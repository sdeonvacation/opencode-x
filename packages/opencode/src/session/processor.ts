import { Cause, Deferred, Effect, Layer, Option, ServiceMap } from "effect" // [fork-perf]
import * as Stream from "effect/Stream"
import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Snapshot } from "@/snapshot"
import { Log } from "@/util/log"
import { Session } from "."
import { LLM } from "./llm"
import { LLMCompress } from "./llm-compress"
import { MessageV2 } from "./message-v2"
import { isOverflow } from "./overflow"
import { compressionEligibleEntry, shouldCompress, templateFor, type CompressionThresholds } from "./route-classifier"
import { log as routeLog } from "./route-logger"
import { PartID } from "./schema"
import type { SessionID } from "./schema"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { SessionSummary } from "./summary"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { Question } from "@/question"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { Flag } from "@/flag/flag"
import * as PartCoalescer from "./part-coalescer" // [fork-perf] Phase 1B
import * as DoomLoopDetector from "./doom-loop" // [fork-perf] Phase 1B
import { SnapshotGate } from "./snapshot-gate" // [fork-perf] Phase 4
import { ReactiveCompact } from "./llm/reactive-compact" // [fork-perf] Phase 5
import { DetachedNotes } from "./detached-notes"

export namespace SessionProcessor {
  const DOOM_LOOP_THRESHOLD = 3
  const DOOM_LOOP_HARD_CAP = 3
  const log = Log.create({ service: "session.processor" })

  export function truncateHeadTail(text: string, head: number, tail: number): string {
    const lines = text.split("\n")
    if (lines.length <= head + tail) return text
    const omitted = lines.length - head - tail
    return [...lines.slice(0, head), `\n... (${omitted} lines omitted) ...\n`, ...lines.slice(-tail)].join("\n")
  }

  export type Result = "compact" | "stop" | "continue"

  export type Event = LLM.Event

  export interface Handle {
    readonly message: MessageV2.Assistant
    readonly updateToolCall: (
      toolCallID: string,
      update: (part: MessageV2.ToolPart) => MessageV2.ToolPart,
    ) => Effect.Effect<MessageV2.ToolPart | undefined>
    readonly completeToolCall: (
      toolCallID: string,
      output: {
        title: string
        metadata: Record<string, any>
        output: string
        attachments?: MessageV2.FilePart[]
      },
    ) => Effect.Effect<void>
    readonly process: (streamInput: LLM.StreamInput) => Effect.Effect<Result>
  }

  type Input = {
    assistantMessage: MessageV2.Assistant
    sessionID: SessionID
    model: Provider.Model
  }

  export interface Interface {
    readonly create: (input: Input) => Effect.Effect<Handle>
  }

  type ToolCall = {
    partID: MessageV2.ToolPart["id"]
    messageID: MessageV2.ToolPart["messageID"]
    sessionID: MessageV2.ToolPart["sessionID"]
    done: Deferred.Deferred<void>
    inputEnded: boolean
  }

  interface ProcessorContext extends Input {
    toolcalls: Record<string, ToolCall>
    shouldBreak: boolean
    snapshot: string | undefined
    blocked: boolean
    needsCompaction: boolean
    currentText: MessageV2.TextPart | undefined
    reasoningMap: Record<string, MessageV2.ReasoningPart>
    localModel?: Provider.Model
    compressionThreshold: number
    compressionTimeout: number
    compressionMaxTokens: number
    compressionTailLines: number
    compressionThresholds?: CompressionThresholds
    doom: Map<string, number>
    hadText: boolean
    hadToolCalls: boolean
    fsToolFired: boolean // [fork-perf] Phase 4: set true when FS-mutating tool fires
    lastSnapshotAt?: string // [fork-perf] Phase 4: hash of last successful track()
    doomLoop: DoomLoopDetector.DoomLoopDetector | undefined // [fork-perf] Phase 1B: ring-buffer detector
    compactedReactively: boolean // [fork-perf] Phase 5: prevent double-compact on retry
    agentPermission: Permission.Ruleset // [fork-perf] doom-loop: per-process agent permission ruleset
  }

  type StreamEvent = Event

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/SessionProcessor") {}

  export const layer: Layer.Layer<
    Service,
    never,
    | Session.Service
    | Config.Service
    | Bus.Service
    | Snapshot.Service
    | Agent.Service
    | LLM.Service
    | Permission.Service
    | Plugin.Service
    | SessionStatus.Service
    | Provider.Service // [fork-perf] Phase 5: needed for ReactiveCompact.handle
  > = Layer.effect(
    Service,
    Effect.gen(function* () {
      const session = yield* Session.Service
      const config = yield* Config.Service
      const bus = yield* Bus.Service
      const snapshot = yield* Snapshot.Service
      const agents = yield* Agent.Service
      const llm = yield* LLM.Service
      const permission = yield* Permission.Service
      const plugin = yield* Plugin.Service
      const status = yield* SessionStatus.Service
      const provider = yield* Provider.Service // [fork-perf] Phase 5

      const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
        // Pre-capture snapshot before the LLM stream starts. The AI SDK
        // may execute tools internally before emitting start-step events,
        // so capturing inside the event handler can be too late.
        const initialSnapshot = yield* snapshot.track()
        const cfg = yield* config.get()
        const ref = cfg.hybrid?.cheap_model
        const local = ref
          ? yield* Effect.tryPromise(() =>
              Provider.getModel(ProviderID.make(ref.providerID), ModelID.make(ref.modelID)),
            ).pipe(Effect.option)
          : Option.none<Provider.Model>()
        // [fork-perf] Phase 1B: coalescer instance per processor.create call
        const coalescer =
          cfg.experimental?.part_coalescer !== false
            ? PartCoalescer.create({ flush: (part) => session.updatePart(part).pipe(Effect.asVoid) })
            : undefined
        // [fork-perf] Phase 1B: ring-buffer doom-loop detector (alongside existing SELECT-based check)
        const doomLoopDetector: DoomLoopDetector.DoomLoopDetector | undefined =
          cfg.experimental?.doom_loop_ring === true
            ? DoomLoopDetector.create({ threshold: DOOM_LOOP_THRESHOLD })
            : undefined
        const ctx: ProcessorContext = {
          assistantMessage: input.assistantMessage,
          sessionID: input.sessionID,
          model: input.model,
          toolcalls: {},
          shouldBreak: false,
          snapshot: initialSnapshot,
          blocked: false,
          needsCompaction: false,
          currentText: undefined,
          reasoningMap: {},
          localModel: Option.getOrUndefined(local),
          compressionThreshold: cfg.hybrid?.compression_threshold ?? 10,
          compressionTimeout: cfg.hybrid?.compression_timeout_ms ?? 5000,
          compressionMaxTokens: cfg.hybrid?.compression_max_tokens ?? 4096,
          compressionTailLines: cfg.hybrid?.compression_tail_lines ?? 20,
          compressionThresholds: cfg.hybrid?.compression_thresholds,
          doom: new Map(),
          hadText: false,
          hadToolCalls: false,
          fsToolFired: false, // [fork-perf] Phase 4
          lastSnapshotAt: undefined, // [fork-perf] Phase 4
          doomLoop: doomLoopDetector, // [fork-perf] Phase 1B
          compactedReactively: false, // [fork-perf] Phase 5
          agentPermission: [], // [fork-perf] doom-loop: set per-process from streamInput.agent
        }
        let aborted = false

        const parse = (e: unknown) =>
          MessageV2.fromError(e, {
            providerID: input.model.providerID,
            aborted,
          })

        const settleToolCall = Effect.fn("SessionProcessor.settleToolCall")(function* (toolCallID: string) {
          const done = ctx.toolcalls[toolCallID]?.done
          delete ctx.toolcalls[toolCallID]
          if (done) yield* Deferred.succeed(done, undefined).pipe(Effect.ignore)
        })

        const readToolCall = Effect.fn("SessionProcessor.readToolCall")(function* (toolCallID: string) {
          const call = ctx.toolcalls[toolCallID]
          if (!call) return
          const part = yield* session.getPart({
            partID: call.partID,
            messageID: call.messageID,
            sessionID: call.sessionID,
          })
          if (!part || part.type !== "tool") {
            delete ctx.toolcalls[toolCallID]
            return
          }
          return { call, part }
        })

        // Mark in-flight tool parts as error and clear tracking. Used between
        // retry attempts so orphan "pending" parts don't render as stuck in the TUI.
        const settleOrphanToolCalls = Effect.fn("SessionProcessor.settleOrphanToolCalls")(function* (reason: string) {
          // Brief grace period for tools that may still be finishing — mirrors
          // cleanup()'s end-of-process behaviour so a `running` tool whose result
          // is about to land doesn't get prematurely errored.
          yield* Effect.forEach(
            Object.values(ctx.toolcalls),
            (call) => Deferred.await(call.done).pipe(Effect.timeout("250 millis"), Effect.ignore),
            { concurrency: "unbounded" },
          )
          for (const toolCallID of Object.keys(ctx.toolcalls)) {
            const match = yield* readToolCall(toolCallID)
            if (!match) {
              yield* settleToolCall(toolCallID)
              continue
            }
            const part = match.part
            if (part.state.status === "completed" || part.state.status === "error") {
              yield* settleToolCall(toolCallID)
              continue
            }
            const end = Date.now()
            const metadata = "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : {}
            yield* session.updatePart({
              ...part,
              state: {
                ...part.state,
                status: "error",
                error: reason,
                metadata: { ...metadata, interrupted: true },
                time: { start: "time" in part.state ? part.state.time.start : end, end },
              },
            })
            yield* settleToolCall(toolCallID)
          }
        })

        // Mark prior tool parts whose input finished streaming but whose tool-call
        // event never fired (model truncation / max_tokens cutoff / upstream timeout).
        // Providers that interleave parallel tool calls (OpenAI parallel_tool_calls)
        // may emit tool-input-start B before tool-input-end A, so the predicate must
        // gate on inputEnded — not on raw presence of other entries.
        const sweepOrphanInputs = Effect.fn("SessionProcessor.sweepOrphanInputs")(function* (currentID: string) {
          const ids = Object.keys(ctx.toolcalls).filter((id) => id !== currentID)
          if (ids.length === 0) return
          for (const id of ids) {
            const entry = ctx.toolcalls[id]
            if (!entry?.inputEnded) continue
            const match = yield* readToolCall(id)
            if (!match) {
              yield* settleToolCall(id)
              continue
            }
            if (match.part.state.status !== "pending") continue
            const end = Date.now()
            const meta =
              "metadata" in match.part.state && isRecord(match.part.state.metadata) ? match.part.state.metadata : {}
            yield* session.updatePart({
              ...match.part,
              state: {
                status: "error",
                input: match.part.state.input,
                error: "Tool input truncated mid-stream (likely max_tokens or upstream timeout)",
                metadata: { ...meta, interrupted: true },
                time: { start: end, end },
              },
            })
            yield* settleToolCall(id)
          }
        })

        const updateToolCall = Effect.fn("SessionProcessor.updateToolCall")(function* (
          toolCallID: string,
          update: (part: MessageV2.ToolPart) => MessageV2.ToolPart,
        ) {
          const match = yield* readToolCall(toolCallID)
          if (!match) return
          const part = yield* session.updatePart(update(match.part))
          ctx.toolcalls[toolCallID] = {
            ...match.call,
            partID: part.id,
            messageID: part.messageID,
            sessionID: part.sessionID,
          }
          return part
        })

        const completeToolCall = Effect.fn("SessionProcessor.completeToolCall")(function* (
          toolCallID: string,
          output: {
            title: string
            metadata: Record<string, any>
            output: string
            attachments?: MessageV2.FilePart[]
          },
        ) {
          const match = yield* readToolCall(toolCallID)
          if (!match || match.part.state.status !== "running") return
          yield* session.updatePart({
            ...match.part,
            state: {
              status: "completed",
              input: match.part.state.input,
              output: output.output,
              metadata: output.metadata,
              title: output.title,
              time: { start: match.part.state.time.start, end: Date.now() },
              attachments: output.attachments,
            },
          })
          const enabled = cfg.hybrid?.enabled ?? Flag.OPENCODE_HYBRID_ROUTING
          // [fork-perf] compression-replay-safety: only compress once per part.
          // Re-read the persisted part so that if a previous run already wrote
          // compression_attempted=true (e.g. LLM fallback, then reload), we skip
          // re-compression and avoid producing a different output that would bust
          // the Anthropic prompt cache prefix.
          const freshPart = yield* session.getPart({
            partID: match.part.id,
            messageID: match.part.messageID,
            sessionID: match.part.sessionID,
          })
          const alreadyAttempted =
            freshPart?.type === "tool" &&
            freshPart.state.status === "completed" &&
            (freshPart.state.metadata as Record<string, unknown>)?.compression_attempted === true
          if (
            !alreadyAttempted &&
            enabled &&
            ctx.localModel &&
            shouldCompress(output.output, match.part.tool, ctx.compressionThresholds)
          ) {
            const heuristic =
              (match.part.tool === "grep" || match.part.tool === "glob") &&
              cfg.experimental?.compression_heuristic !== false
            if (heuristic) {
              const head = cfg.hybrid?.heuristic_head ?? 50
              const tail = cfg.hybrid?.heuristic_tail ?? 20
              const truncated = truncateHeadTail(output.output, head, tail)
              yield* session.updatePart({
                ...match.part,
                // [fork-perf] Phase 1: terminal=true so coalescer flushes before next API turn
                metadata: { terminal: true },
                state: {
                  status: "completed",
                  input: match.part.state.input,
                  output: truncated,
                  metadata: {
                    ...output.metadata,
                    compressed: true,
                    compression_template: "heuristic_head_tail",
                    // [fork-perf] compression-replay-safety
                    compression_attempted: true,
                  },
                  title: output.title,
                  time: { start: match.part.state.time.start, end: Date.now() },
                  attachments: output.attachments,
                },
              } as any)
            } else {
              const result = yield* LLMCompress.compress({
                tool: match.part.tool,
                output: output.output,
                template: templateFor(match.part.tool, cfg.hybrid?.compression_templates),
                model: ctx.localModel,
                threshold: ctx.compressionThreshold,
                timeout: ctx.compressionTimeout,
                maxTokens: ctx.compressionMaxTokens,
                tailLines: ctx.compressionTailLines,
              })
              yield* session.updatePart({
                ...match.part,
                // [fork-perf] Phase 1: terminal=true so coalescer flushes before next API turn
                metadata: { terminal: true },
                state: {
                  status: "completed",
                  input: match.part.state.input,
                  output: result.compressed,
                  metadata: {
                    ...output.metadata,
                    compressed: true,
                    compression_template: result.stats.template,
                    compression_ratio: result.stats.ratio,
                    compression_fallback: result.stats.fallback,
                    compression_validated: result.stats.validated,
                    // [fork-perf] compression-replay-safety
                    compression_attempted: true,
                  },
                  title: output.title,
                  time: { start: match.part.state.time.start, end: Date.now() },
                  attachments: output.attachments,
                },
              } as any)
            }
          }
          if (enabled) {
            const model = ctx.localModel ?? ctx.model
            yield* Effect.promise(() =>
              routeLog(
                compressionEligibleEntry({
                  sessionID: ctx.sessionID,
                  step: 0,
                  tool: match.part.tool,
                  output: output.output,
                  modelID: model.id,
                  providerID: model.providerID,
                  thresholds: ctx.compressionThresholds,
                }),
                cfg,
              ),
            )
          }
          yield* settleToolCall(toolCallID)
        })

        const failToolCall = Effect.fn("SessionProcessor.failToolCall")(function* (toolCallID: string, error: unknown) {
          const match = yield* readToolCall(toolCallID)
          if (!match || match.part.state.status !== "running") return false
          yield* session.updatePart({
            ...match.part,
            state: {
              status: "error",
              input: match.part.state.input,
              error: errorMessage(error),
              time: { start: match.part.state.time.start, end: Date.now() },
            },
          })
          if (
            error instanceof Permission.RejectedError ||
            error instanceof Permission.DeniedError ||
            error instanceof Question.RejectedError
          ) {
            ctx.blocked = ctx.shouldBreak
          }
          yield* settleToolCall(toolCallID)
          return true
        })

        const handleEvent = Effect.fn("SessionProcessor.handleEvent")(function* (value: StreamEvent) {
          switch (value.type) {
            case "start":
              yield* status.set(ctx.sessionID, { type: "busy" })
              return

            case "reasoning-start":
              if (value.id in ctx.reasoningMap) return
              ctx.reasoningMap[value.id] = {
                id: PartID.ascending(),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.assistantMessage.sessionID,
                type: "reasoning",
                text: "",
                time: { start: Date.now() },
                metadata: value.providerMetadata,
              }
              yield* session.updatePart(ctx.reasoningMap[value.id])
              return

            case "reasoning-delta":
              if (!(value.id in ctx.reasoningMap)) return
              ctx.reasoningMap[value.id].text += value.text
              if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
              yield* session.updatePartDelta({
                sessionID: ctx.reasoningMap[value.id].sessionID,
                messageID: ctx.reasoningMap[value.id].messageID,
                partID: ctx.reasoningMap[value.id].id,
                field: "text",
                delta: value.text,
              })
              return

            case "reasoning-end":
              if (!(value.id in ctx.reasoningMap)) return
              ctx.reasoningMap[value.id].text = ctx.reasoningMap[value.id].text.trimEnd()
              ctx.reasoningMap[value.id].time = { ...ctx.reasoningMap[value.id].time, end: Date.now() }
              if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
              yield* session.updatePart(ctx.reasoningMap[value.id])
              delete ctx.reasoningMap[value.id]
              return

            case "tool-input-start":
              if (ctx.assistantMessage.summary) {
                throw new Error(`Tool call not allowed while generating summary: ${value.toolName}`)
              }
              ctx.hadToolCalls = true
              yield* sweepOrphanInputs(value.id)
              const part = yield* session.updatePart({
                id: ctx.toolcalls[value.id]?.partID ?? PartID.ascending(),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.assistantMessage.sessionID,
                type: "tool",
                tool: value.toolName,
                callID: value.id,
                state: { status: "pending", input: {}, raw: "" },
                metadata: value.providerExecuted ? { providerExecuted: true } : undefined,
              } satisfies MessageV2.ToolPart)
              ctx.toolcalls[value.id] = {
                done: yield* Deferred.make<void>(),
                partID: part.id,
                messageID: part.messageID,
                sessionID: part.sessionID,
                inputEnded: false,
              }
              return

            case "tool-input-delta":
              yield* updateToolCall(value.id, (match) => ({
                ...match,
                state: {
                  ...match.state,
                  raw: (match.state.status === "pending" ? match.state.raw : "") + value.delta,
                },
              }))
              return

            case "tool-input-end": {
              const entry = ctx.toolcalls[value.id]
              if (entry) entry.inputEnded = true
              return
            }

            case "tool-call": {
              if (ctx.assistantMessage.summary) {
                throw new Error(`Tool call not allowed while generating summary: ${value.toolName}`)
              }
              yield* updateToolCall(value.toolCallId, (match) => ({
                ...match,
                tool: value.toolName,
                state: {
                  status: "running" as const,
                  input: value.input,
                  time: { start: Date.now() },
                },
                metadata: match.metadata?.providerExecuted
                  ? { ...value.providerMetadata, providerExecuted: true }
                  : value.providerMetadata,
              }))
              // [fork-perf] Phase 4: track FS-mutating tools for snapshot gate
              SnapshotGate.onToolCall(ctx, value.toolName)

              // [fork-perf] Phase 1B: ring-buffer detector (runs before SELECT-based check)
              if (ctx.doomLoop) {
                ctx.doomLoop.record({ toolName: value.toolName, input: value.input })
                if (ctx.doomLoop.detect({ toolName: value.toolName, input: value.input })) {
                  yield* failToolCall(
                    value.toolCallId,
                    `Doom loop detected (ring): tool '${value.toolName}' called ${DOOM_LOOP_THRESHOLD} times with identical input. Aborting.`,
                  )
                  ctx.shouldBreak = true
                  ctx.blocked = true
                  return
                }
              }

              const parts = MessageV2.parts(ctx.assistantMessage.id)
              const recentParts = parts.filter((part) => part.type === "tool").slice(-DOOM_LOOP_THRESHOLD)

              if (
                recentParts.length !== DOOM_LOOP_THRESHOLD ||
                !recentParts.every(
                  (part) =>
                    part.type === "tool" &&
                    part.tool === value.toolName &&
                    part.state.status !== "pending" &&
                    JSON.stringify(part.state.input) === JSON.stringify(value.input),
                )
              ) {
                return
              }

              const key = value.toolName + JSON.stringify(value.input)
              const count = (ctx.doom.get(key) ?? 0) + 1
              ctx.doom.set(key, count)

              if (count > DOOM_LOOP_HARD_CAP) {
                yield* failToolCall(
                  value.toolCallId,
                  `Doom loop detected: tool '${value.toolName}' called ${count * DOOM_LOOP_THRESHOLD} times with identical input. Aborting.`,
                )
                ctx.shouldBreak = true
                ctx.blocked = true
                return
              }

              yield* permission.ask({
                permission: "doom_loop",
                patterns: [value.toolName],
                sessionID: ctx.assistantMessage.sessionID,
                metadata: { tool: value.toolName, input: value.input },
                always: [value.toolName],
                ruleset: ctx.agentPermission, // [fork-perf] doom-loop: use per-process ruleset
              })
              return
            }

            case "tool-result": {
              yield* completeToolCall(value.toolCallId, value.output)
              return
            }

            case "tool-error": {
              yield* failToolCall(value.toolCallId, value.error)
              return
            }

            case "error":
              // Use warn here — these flow through SessionRetry and may be transient.
              // Terminal failures are logged at ERROR by halt() at the end of the pipeline.
              log.warn("stream error", { error: value.error })
              throw value.error

            case "start-step":
              // [fork-perf] Phase 4: gated snapshot track — skip when no FS tool fired
              if (!ctx.snapshot)
                ctx.snapshot = yield* SnapshotGate.track(ctx, snapshot, cfg.experimental?.skip_snapshot_no_fs !== false)
              yield* session.updatePart({
                id: PartID.ascending(),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.sessionID,
                snapshot: ctx.snapshot,
                type: "step-start",
              })
              return

            case "finish-step": {
              const usage = Session.getUsage({
                model: ctx.model,
                usage: value.usage,
                metadata: value.providerMetadata,
              })
              ctx.assistantMessage.finish = value.finishReason
              ctx.assistantMessage.cost += usage.cost
              ctx.assistantMessage.tokens = usage.tokens
              yield* session.updatePart({
                id: PartID.ascending(),
                reason: value.finishReason,
                // [fork-perf] Phase 4: gated snapshot track
                snapshot: yield* SnapshotGate.track(ctx, snapshot, cfg.experimental?.skip_snapshot_no_fs !== false),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.assistantMessage.sessionID,
                type: "step-finish",
                tokens: usage.tokens,
                cost: usage.cost,
              })
              yield* session.updateMessage(ctx.assistantMessage)
              if (ctx.snapshot) {
                // [fork-perf] Phase 4: gated snapshot patch — returns undefined when no FS tool fired
                const patch = yield* SnapshotGate.patch(ctx, snapshot, cfg.experimental?.skip_snapshot_no_fs !== false)
                if (patch !== undefined && patch.files.length) {
                  yield* session.updatePart({
                    id: PartID.ascending(),
                    messageID: ctx.assistantMessage.id,
                    sessionID: ctx.sessionID,
                    type: "patch",
                    hash: patch.hash,
                    files: patch.files,
                  })
                }
                ctx.snapshot = undefined
              }
              SessionSummary.summarize({
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.parentID,
              })
              if (
                !ctx.assistantMessage.summary &&
                isOverflow({ cfg: yield* config.get(), tokens: usage.tokens, model: ctx.model })
              ) {
                ctx.needsCompaction = true
              }
              return
            }

            case "text-start":
              ctx.currentText = {
                id: PartID.ascending(),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.assistantMessage.sessionID,
                type: "text",
                text: "",
                time: { start: Date.now() },
                metadata: value.providerMetadata,
              }
              yield* session.updatePart(ctx.currentText)
              return

            case "text-delta":
              if (!ctx.currentText) return
              ctx.currentText.text += value.text
              if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
              yield* session.updatePartDelta({
                sessionID: ctx.currentText.sessionID,
                messageID: ctx.currentText.messageID,
                partID: ctx.currentText.id,
                field: "text",
                delta: value.text,
              })
              return

            case "text-end":
              if (!ctx.currentText) return
              ctx.currentText.text = ctx.currentText.text.trimEnd()
              ctx.currentText.text = (yield* plugin.trigger(
                "experimental.text.complete",
                {
                  sessionID: ctx.sessionID,
                  messageID: ctx.assistantMessage.id,
                  partID: ctx.currentText.id,
                },
                { text: ctx.currentText.text },
              )).text
              if (ctx.currentText.text) ctx.hadText = true
              {
                const end = Date.now()
                ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
              }
              if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
              yield* session.updatePart(ctx.currentText)
              ctx.currentText = undefined
              return

            case "finish":
              return

            default:
              log.info("unhandled", { ...value })
              return
          }
        })

        const cleanup = Effect.fn("SessionProcessor.cleanup")(function* () {
          if (ctx.snapshot) {
            // [fork-perf] Phase 4: gated snapshot patch (second site — sliding-window v2 / cleanup path)
            const patch = yield* SnapshotGate.patch(ctx, snapshot, cfg.experimental?.skip_snapshot_no_fs !== false)
            if (patch !== undefined && patch.files.length) {
              yield* session.updatePart({
                id: PartID.ascending(),
                messageID: ctx.assistantMessage.id,
                sessionID: ctx.sessionID,
                type: "patch",
                hash: patch.hash,
                files: patch.files,
              })
            }
            ctx.snapshot = undefined
          }

          if (ctx.currentText) {
            const end = Date.now()
            ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
            yield* session.updatePart(ctx.currentText)
            ctx.currentText = undefined
          }

          for (const part of Object.values(ctx.reasoningMap)) {
            const end = Date.now()
            yield* session.updatePart({
              ...part,
              time: { start: part.time.start ?? end, end },
            })
          }
          ctx.reasoningMap = {}

          yield* Effect.forEach(
            Object.values(ctx.toolcalls),
            (call) => Deferred.await(call.done).pipe(Effect.timeout("250 millis"), Effect.ignore),
            { concurrency: "unbounded" },
          )

          for (const toolCallID of Object.keys(ctx.toolcalls)) {
            const match = yield* readToolCall(toolCallID)
            if (!match) continue
            const part = match.part
            const end = Date.now()
            const metadata = "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : {}
            const error = !DetachedNotes.isDetaching(ctx.sessionID)
              ? "Tool execution aborted"
              : metadata.sessionId
                ? `(background) task_id: ${metadata.sessionId}`
                : "(background)"
            yield* session.updatePart({
              ...part,
              state: {
                ...part.state,
                status: "error",
                error,
                metadata: { ...metadata, interrupted: true },
                time: { start: "time" in part.state ? part.state.time.start : end, end },
              },
            })
          }
          ctx.toolcalls = {}
          ctx.assistantMessage.time.completed = Date.now()
          yield* session.updateMessage(ctx.assistantMessage)
        })

        const halt = Effect.fn("SessionProcessor.halt")(function* (e: unknown) {
          log.error("process", { error: e, stack: e instanceof Error ? e.stack : undefined })
          const error = parse(e)
          if (MessageV2.ContextOverflowError.isInstance(error)) {
            if ((yield* config.get()).compaction?.auto === false && !ctx.assistantMessage.summary) {
              ctx.assistantMessage.error = error
              ctx.assistantMessage.finish = "error"
              yield* bus.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
              yield* status.set(ctx.sessionID, { type: "idle" })
              return
            }
            ctx.needsCompaction = true
            yield* bus.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
            return
          }
          ctx.assistantMessage.error = error
          yield* bus.publish(Session.Event.Error, {
            sessionID: ctx.assistantMessage.sessionID,
            error: ctx.assistantMessage.error,
          })
          yield* status.set(ctx.sessionID, { type: "idle" })
        })

        const process = Effect.fn("SessionProcessor.process")(function* (streamInput: LLM.StreamInput) {
          log.info("process")
          ctx.needsCompaction = false
          ctx.hadText = false
          ctx.hadToolCalls = false
          ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny === false
          ctx.agentPermission = streamInput.agent.permission // [fork-perf] doom-loop: use streamInput agent ruleset

          // [fork-perf] Phase 5: inner runStream extracted so reactive compact can retry once
          const runStream = (input: LLM.StreamInput) =>
            Effect.gen(function* () {
              ctx.currentText = undefined
              ctx.reasoningMap = {}
              const stream = llm.stream({
                ...input,
                onModelResolved: (m) => {
                  ctx.model = m
                },
              })

              // [fork-perf] Phase 1B: wrap stream loop with coalescer dispose in finally
              yield* stream
                .pipe(
                  Stream.tap((event) => handleEvent(event)),
                  Stream.takeUntil(() => ctx.needsCompaction),
                  Stream.runDrain,
                )
                .pipe(Effect.ensuring(coalescer ? coalescer.dispose() : Effect.void))
            }).pipe(
              Effect.onInterrupt(() =>
                Effect.gen(function* () {
                  aborted = true
                  if (!ctx.assistantMessage.error) {
                    yield* halt(new DOMException("Aborted", "AbortError"))
                  }
                }),
              ),
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterruptsOnly(cause),
                (cause) => Effect.fail(Cause.squash(cause)),
              ),
              // Mark orphan tool parts as error before each retry decision so the
              // TUI doesn't render them as stuck "pending" during backoff windows.
              // Skip when the error is non-retryable — terminal failures fall through
              // to halt()/cleanup() which marks orphans with the canonical
              // "Tool execution aborted" reason.
              Effect.tapError((err) =>
                Effect.gen(function* () {
                  if (!SessionRetry.retryable(parse(err))) return
                  yield* settleOrphanToolCalls("Stream interrupted, retrying")
                }).pipe(Effect.catch((e) => Effect.sync(() => log.warn("orphan settle failed", { error: e })))),
              ),
              Effect.retry(
                SessionRetry.policy({
                  parse,
                  set: (info) =>
                    status.set(ctx.sessionID, {
                      type: "retry",
                      attempt: info.attempt,
                      message: info.message,
                      next: info.next,
                    }),
                }),
              ),
            )

          return yield* Effect.gen(function* () {
            yield* runStream(streamInput).pipe(
              // [fork-perf] Phase 5: reactive compact — on overflow, compact inline and retry once
              Effect.catchIf(
                (err) =>
                  ReactiveCompact.isOverflow(err) &&
                  cfg.experimental?.reactive_compaction !== false &&
                  !ctx.compactedReactively,
                (err) =>
                  Effect.gen(function* () {
                    log.warn("reactive compact triggered", { error: err })
                    const msgs = yield* session.messages({ sessionID: ctx.sessionID })
                    const { messages: compacted } = yield* ReactiveCompact.handle({
                      msgs,
                      model: ctx.model,
                      provider,
                      cfg,
                      sessionID: ctx.sessionID,
                      agent: streamInput.agent,
                    })
                    ctx.compactedReactively = true
                    // Rebuild model messages from compacted session messages
                    const retryMsgs = yield* Effect.promise(() =>
                      MessageV2.toModelMessages(compacted, ctx.model, {
                        stripThinkingText: cfg.experimental?.strip_thinking_text !== false, // [fork-perf]
                      }),
                    )
                    yield* runStream({ ...streamInput, messages: retryMsgs })
                  }),
              ),
              Effect.catch(halt),
              Effect.ensuring(cleanup()),
            )

            if (ctx.needsCompaction) return "compact"
            if (ctx.blocked || ctx.assistantMessage.error) return "stop"
            // Noop exit: model returned nothing useful
            if (cfg.experimental?.noop_exit !== false && !ctx.hadText && !ctx.hadToolCalls) return "stop"
            return "continue"
          })
        })

        return {
          get message() {
            return ctx.assistantMessage
          },
          updateToolCall,
          completeToolCall,
          process,
        } satisfies Handle
      })

      return Service.of({ create })
    }),
  )

  export const defaultLayer = Layer.suspend(() =>
    layer.pipe(
      Layer.provide(Session.defaultLayer),
      Layer.provide(Snapshot.defaultLayer),
      Layer.provide(Agent.defaultLayer),
      Layer.provide(LLM.defaultLayer),
      Layer.provide(Permission.defaultLayer),
      Layer.provide(Plugin.defaultLayer),
      Layer.provide(SessionStatus.defaultLayer),
      Layer.provide(Bus.layer),
      Layer.provide(Config.defaultLayer),
      Layer.provide(Provider.defaultLayer), // [fork-perf] Phase 5: reactive compact needs provider
    ),
  )
}
