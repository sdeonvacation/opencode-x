import path from "path"
import os from "os"
import { appendFile } from "fs/promises"
import z from "zod"
import { SessionID, MessageID, PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { Log } from "../util/log"
import { SessionRevert } from "./revert"
import { Session, HookContext } from "."
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions, asSchema } from "ai"
import { SessionCompaction } from "./compaction"
import { Bus } from "../bus"
import { ProviderTransform } from "../provider/transform"
import { SystemPrompt } from "./system"
import { Instruction } from "./instruction"
import { Memory } from "../memory/memory"
import { Plugin } from "../plugin"
import MAX_STEPS from "../session/prompt/max-steps.txt"
import { ToolRegistry } from "../tool/registry"
import { MCP } from "../mcp"
import { LSP } from "../lsp"
import { FileTime } from "../file/time"
import { ulid } from "ulid"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"
import * as Stream from "effect/Stream"
import { Command } from "../command"
import { pathToFileURL, fileURLToPath } from "url"
import { ConfigMarkdown } from "../config/markdown"
import { Config } from "../config/config"
import { resolveLocal, resolveLocalAsync } from "./resolve-local"
import { SessionSummary } from "./summary"
import { SlidingWindow } from "./sliding-window"
// [fork-perf] Phase 1: history cache (incremental rebuild + ModelMessage memoization)
import * as HistoryCache from "./history-cache"
import { NamedError } from "@opencode-ai/util/error"
import { SessionProcessor } from "./processor"
import { Tool } from "@/tool/tool"
import { Permission } from "@/permission"
import { Wildcard } from "@/util/wildcard"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { Shell } from "@/shell/shell"
import { AppFileSystem } from "@/filesystem"
import { Truncate } from "@/tool/truncate"
import { decodeDataUrl } from "@/util/data-url"
import { Process } from "@/util/process"
import { Cause, Deferred, Effect, Exit, Layer, Option, Scope, ServiceMap } from "effect"
import { insertReminders } from "./prompt-reminders"
import { handleSubtask } from "./subtask-handler"
import { InstanceState } from "@/effect/instance-state"
import { applyToolBudget } from "./tool-budget"
import { ContextCollapse } from "./context-collapse"
import { MicroCompact } from "./microcompact"
import { PromptSplit } from "./prompt-split"
import { Goal } from "../goal/goal"
import { GoalLoop } from "../goal/goal-loop"
import { Hook } from "../hook/hook"
import { Global } from "../global"
import { PersistentMemory } from "../memory/persistent"
import { makeRuntime } from "@/effect/run-service"
import { SessionRunState } from "./run-state"
import { CacheDebugLog } from "./cache-debug-log"
import { Instance } from "@/project/instance"
import type { TaskPromptOps } from "@/tool/task"

import { DreamTrigger } from "./dream-trigger"
import { DetachedNotes } from "./detached-notes"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

export namespace SessionPrompt {
  const log = Log.create({ service: "session.prompt" })

  export interface Interface {
    readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
    readonly prompt: (input: PromptInput) => Effect.Effect<MessageV2.WithParts>
    readonly complete: (input: CompleteInput) => Effect.Effect<MessageV2.WithParts>
    readonly loop: (input: z.infer<typeof LoopInput>) => Effect.Effect<MessageV2.WithParts>
    readonly shell: (input: ShellInput) => Effect.Effect<MessageV2.WithParts>
    readonly command: (input: CommandInput) => Effect.Effect<MessageV2.WithParts>
    readonly resolvePromptParts: (template: string) => Effect.Effect<PromptInput["parts"]>
    // fork: background-detach (#FORK) — begin
    readonly background: (sessionID: SessionID) => Effect.Effect<number>
    // fork: background-detach (#FORK) — end
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/SessionPrompt") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const status = yield* SessionStatus.Service
      const sessions = yield* Session.Service
      const agents = yield* Agent.Service
      const provider = yield* Provider.Service
      const processor = yield* SessionProcessor.Service
      const compaction = yield* SessionCompaction.Service
      const plugin = yield* Plugin.Service
      const commands = yield* Command.Service
      const permission = yield* Permission.Service
      const fsys = yield* AppFileSystem.Service
      const mcp = yield* MCP.Service
      const lsp = yield* LSP.Service
      const filetime = yield* FileTime.Service
      const registry = yield* ToolRegistry.Service
      const truncate = yield* Truncate.Service
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const scope = yield* Scope.Scope
      const instruction = yield* Instruction.Service
      const state = yield* SessionRunState.Service
      const revert = yield* SessionRevert.Service
      const config = yield* Config.Service

      // fork: background-detach (#FORK) — begin (cancel override)
      const cancel = Effect.fn("SessionPrompt.cancel")(function* (sessionID: SessionID) {
        if (DetachedNotes.isProtected(sessionID)) return
        log.info("cancel", { sessionID })
        yield* state.cancel(sessionID)
        // Cascade: also cancel any detached children of this parent
        const childIDs = DetachedNotes.getDetachedChildren(sessionID)
        if (childIDs.length) {
          for (const childID of childIDs) {
            DetachedNotes.unprotect(childID as SessionID)
            yield* state.cancel(childID as SessionID)
          }
          DetachedNotes.removeParent(sessionID)
        }
      })
      // fork: background-detach (#FORK) — end (cancel override)

      // fork: background-detach (#FORK) — begin
      const background = Effect.fn("SessionPrompt.background")(function* (sessionID: SessionID) {
        const runner = yield* state.peek(sessionID)
        if (!runner) return 0
        const st = runner.state
        if (st._tag !== "Running" && st._tag !== "ShellThenRun") return 0

        // Find running children
        const kids = yield* sessions.children(sessionID)
        type ChildEntry = { childID: SessionID; description: string; run: Effect.Effect<string, unknown> }
        const children: ChildEntry[] = []
        for (const child of kids) {
          if (child.time.archived) continue
          const r = yield* state.peek(child.id)
          if (r && (r.state._tag === "Running" || r.state._tag === "ShellThenRun")) {
            // Running child — await its Deferred
            const done = r.state._tag === "Running" ? r.state.run.done : r.state.run.done
            const run = Deferred.await(done).pipe(
              Effect.map((msg: any) => msg.parts.findLast((p: any) => p.type === "text")?.text ?? ""),
            )
            children.push({ childID: child.id, description: child.title ?? child.id, run })
          } else if (r && r.state._tag !== "Idle") {
            // Pending child (runner exists but not yet running) — poll until it starts
            const run = Effect.gen(function* () {
              let polled: typeof runner | undefined
              for (let i = 0; i < 600; i++) {
                polled = yield* state.peek(child.id)
                if (polled && (polled.state._tag === "Running" || polled.state._tag === "ShellThenRun")) break
                if (polled && polled.state._tag === "Idle") return ""
                yield* Effect.sleep("500 millis")
              }
              if (!polled || (polled.state._tag !== "Running" && polled.state._tag !== "ShellThenRun")) return ""
              const done = polled.state._tag === "Running" ? polled.state.run.done : polled.state.run.done
              const msg = yield* Deferred.await(done)
              const last = msg.parts.findLast((p: any) => p.type === "text") as { text: string } | undefined
              return last?.text ?? ""
            })
            children.push({ childID: child.id, description: child.title ?? child.id, run })
          }
        }

        if (children.length === 0) return 0

        // Get parent model/agent for auto-resume
        const msgs = MessageV2.page({ sessionID, limit: 5 })
        const lastAssist = msgs.items.findLast((m) => m.info.role === "assistant")
        const model =
          lastAssist && lastAssist.info.role === "assistant"
            ? { providerID: lastAssist.info.providerID, modelID: lastAssist.info.modelID }
            : { providerID: "unknown" as any, modelID: "unknown" as any }
        const agent = lastAssist && lastAssist.info.role === "assistant" ? lastAssist.info.agent : "build"
        const variant = lastAssist && lastAssist.info.role === "assistant" ? lastAssist.info.variant : undefined

        // Delegate to PushToBackgroundExecutor
        const mod = yield* Effect.promise(() => import("@/orchestration/executor/push-to-bg"))
        const result = yield* Effect.promise(() =>
          mod.executePushToBackground({
            parentSessionID: sessionID,
            children,
            model,
            agent,
            variant,
            cancelParent: async () => {
              DetachedNotes.markDetaching(sessionID)
              await Effect.runPromise(state.cancel(sessionID))
              DetachedNotes.clearDetaching(sessionID)
            },
          }),
        )

        return result.count
      })
      // fork: background-detach (#FORK) — end

      const resolvePromptParts = Effect.fn("SessionPrompt.resolvePromptParts")(function* (template: string) {
        const ctx = yield* InstanceState.context
        const parts: PromptInput["parts"] = [{ type: "text", text: template }]
        const files = ConfigMarkdown.files(template)
        const seen = new Set<string>()
        yield* Effect.forEach(
          files,
          Effect.fnUntraced(function* (match) {
            const name = match[1]
            if (seen.has(name)) return
            seen.add(name)
            const filepath = name.startsWith("~/")
              ? path.join(os.homedir(), name.slice(2))
              : path.resolve(ctx.worktree, name)

            const info = yield* fsys.stat(filepath).pipe(Effect.option)
            if (Option.isNone(info)) {
              const found = yield* agents.get(name)
              if (found) parts.push({ type: "agent", name: found.name })
              return
            }
            const stat = info.value
            parts.push({
              type: "file",
              url: pathToFileURL(filepath).href,
              filename: name,
              mime: stat.type === "Directory" ? "application/x-directory" : "text/plain",
            })
          }),
          { concurrency: "unbounded", discard: true },
        )
        return parts
      })

      const title = Effect.fn("SessionPrompt.ensureTitle")(function* (input: {
        session: Session.Info
        history: MessageV2.WithParts[]
        providerID: ProviderID
        modelID: ModelID
      }) {
        if (input.session.parentID) return
        if (!Session.isDefaultTitle(input.session.title)) return

        const real = (m: MessageV2.WithParts) =>
          m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic)
        const idx = input.history.findIndex(real)
        if (idx === -1) return
        if (input.history.filter(real).length !== 1) return

        const context = input.history.slice(0, idx + 1)
        const firstUser = context[idx]
        if (!firstUser || firstUser.info.role !== "user") return
        const firstInfo = firstUser.info

        const subtasks = firstUser.parts.filter((p): p is MessageV2.SubtaskPart => p.type === "subtask")
        const onlySubtasks = subtasks.length > 0 && firstUser.parts.every((p) => p.type === "subtask")

        const ag = yield* agents.get("title")
        if (!ag) return
        const cfg = yield* config.get()
        const mdl = ag.model
          ? yield* provider.getModel(ag.model.providerID, ag.model.modelID)
          : ((yield* resolveLocal(provider, cfg, "title")) ??
            (yield* provider.getSmallModel(input.providerID)) ??
            (yield* provider.getModel(input.providerID, input.modelID)))
        const msgs = onlySubtasks
          ? [{ role: "user" as const, content: subtasks.map((p) => p.prompt).join("\n") }]
          : yield* MessageV2.toModelMessagesEffect(context, mdl, {
              stripThinkingText: cfg.experimental?.strip_thinking_text !== false,
            }) // [fork-perf] strip-thinking
        const text = yield* Effect.promise(async (signal) => {
          const result = await LLM.stream({
            agent: ag,
            user: firstInfo,
            system: [],
            small: true,
            tools: {},
            model: mdl,
            abort: signal,
            sessionID: input.session.id,
            retries: 2,
            messages: [{ role: "user", content: "Generate a title for this conversation:\n" }, ...msgs],
          })
          return result.text
        })
        const cleaned = text
          .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.length > 0)
        if (!cleaned) return
        const t = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
        yield* sessions
          .setTitle({ sessionID: input.session.id, title: t })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => log.error("failed to generate title", { error: Cause.squash(cause) })),
            ),
          )
      })

      const resolveTools = Effect.fn("SessionPrompt.resolveTools")(function* (input: {
        agent: Agent.Info
        model: Provider.Model
        session: Session.Info
        tools?: Record<string, boolean>
        processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
        bypassAgentCheck: boolean
        messages: MessageV2.WithParts[]
      }) {
        using _ = log.time("resolveTools")
        const tools: Record<string, AITool> = {}
        const toolMeta = new Map<string, LLM.ToolMeta>()
        const cfg = yield* config.get()
        const merged = Permission.merge(input.agent.permission, input.session.permission ?? [])
        const approved = new Set<string>()
        const batch = cfg.experimental?.batch_permissions !== false

        const context = (args: any, options: ToolExecutionOptions): Tool.Context => ({
          sessionID: input.session.id,
          abort: options.abortSignal!,
          messageID: input.processor.message.id,
          callID: options.toolCallId,
          extra: {
            model: input.model,
            bypassAgentCheck: input.bypassAgentCheck,
            promptOps: {
              cancel: (sessionID) => SessionPrompt.cancel(sessionID),
              resolvePromptParts: (template) => SessionPrompt.resolvePromptParts(template),
              prompt: (promptInput) => SessionPrompt.prompt(promptInput),
            } satisfies TaskPromptOps,
          },
          agent: input.agent.name,
          messages: input.messages,
          metadata: (val) =>
            Effect.runPromise(
              input.processor.updateToolCall(options.toolCallId, (match) => {
                if (!["running", "pending"].includes(match.state.status)) return match
                return {
                  ...match,
                  state: {
                    title: val.title,
                    metadata: val.metadata,
                    status: "running",
                    input: match.state.input,
                    time: { start: Date.now() },
                  },
                }
              }),
            ),
          ask: (req) => {
            if (batch && approved.has(req.permission)) return Promise.resolve()
            return Effect.runPromise(
              permission.ask({
                ...req,
                sessionID: input.session.id,
                tool: { messageID: input.processor.message.id, callID: options.toolCallId },
                ruleset: merged,
              }),
            )
          },
        })

        for (const item of yield* registry.tools({
          modelID: ModelID.make(input.model.api.id),
          providerID: input.model.providerID,
          agent: input.agent,
        })) {
          const schema = ProviderTransform.schema(input.model, z.toJSONSchema(item.parameters))
          // [fork-perf] parallel-safe gate: only static `true` is safe at request-time.
          // Function-form predicates depend on input not yet known; their runtime
          // check belongs in StreamingDispatcher (Phase 3, deferred). Treat as not-safe.
          toolMeta.set(item.id, { parallelSafe: item.parallelSafe === true })
          if (batch && Permission.evaluate(item.id, "*", merged).action === "allow") {
            const hasSpecificRestriction = merged.some(
              (rule) => rule.pattern !== "*" && rule.action !== "allow" && Wildcard.match(item.id, rule.permission),
            )
            if (!hasSpecificRestriction) {
              approved.add(item.id)
            }
          }
          tools[item.id] = tool({
            id: item.id as any,
            description: item.description,
            inputSchema: jsonSchema(schema as any),
            execute(args, options) {
              return Effect.runPromise(
                Effect.gen(function* () {
                  const ctx = context(args, options)
                  yield* plugin.trigger(
                    "tool.execute.before",
                    { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
                    { args },
                  )
                  // Hook dispatch: PreToolUse (Phase 5)
                  if (cfg.experimental?.hooks !== false) {
                    const rules = yield* Effect.promise(() => Hook.load())
                    const hookResult = yield* (
                      Hook.dispatch(
                        "PreToolUse",
                        {
                          tool: item.id,
                          input: args,
                          sessionID: ctx.sessionID,
                          model: input.model?.id,
                        },
                        rules,
                        cfg,
                      ) as Effect.Effect<
                        { allowed: true; output: string[]; updatedInput?: Record<string, unknown> },
                        any
                      >
                    ).pipe(
                      Effect.catch((denied: any) => {
                        return Effect.succeed({ allowed: false as const, reason: denied.message as string })
                      }),
                    )
                    if (!hookResult.allowed) {
                      return {
                        title: "Hook denied",
                        output: `Tool execution denied by hook: ${"reason" in hookResult ? hookResult.reason : "unknown"}`,
                        metadata: { denied: true },
                      }
                    }
                    if (
                      hookResult.updatedInput &&
                      typeof hookResult.updatedInput === "object" &&
                      !Array.isArray(hookResult.updatedInput)
                    ) {
                      ctx.extra!.preHookInput = args
                      args = hookResult.updatedInput as typeof args
                      yield* input.processor.updateToolCall(options.toolCallId, (match) => {
                        if (!["running", "pending"].includes(match.state.status)) return match
                        return {
                          ...match,
                          state: { ...match.state, input: args as Record<string, any> },
                        }
                      })
                    }
                  }
                  const result = yield* Effect.promise(() => item.execute(args, ctx))
                  const output = {
                    ...result,
                    attachments: result.attachments?.map((attachment) => ({
                      ...attachment,
                      id: PartID.ascending(),
                      sessionID: ctx.sessionID,
                      messageID: input.processor.message.id,
                    })),
                  }
                  yield* plugin.trigger(
                    "tool.execute.after",
                    { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
                    output,
                  )
                  // Hook dispatch: PostToolUse (Phase 5, fire-and-forget)
                  if (cfg.experimental?.hooks !== false) {
                    Effect.runPromise(
                      Effect.promise(async () => {
                        const rules = await Hook.load()
                        await Effect.runPromise(
                          (
                            Hook.dispatch(
                              "PostToolUse",
                              {
                                tool: item.id,
                                input: args,
                                result: output,
                                sessionID: ctx.sessionID,
                                model: input.model?.id,
                              },
                              rules,
                              cfg,
                            ) as Effect.Effect<{
                              allowed: true
                              output: string[]
                              updatedInput?: Record<string, unknown>
                            }>
                          ).pipe(Effect.ignore),
                        )
                      }),
                    ).catch(() => {})
                  }
                  if (options.abortSignal?.aborted) {
                    yield* input.processor.completeToolCall(options.toolCallId, output)
                  }
                  return output
                }),
              )
            },
          })
        }

        for (const [key, item] of Object.entries(yield* mcp.tools())) {
          const execute = item.execute
          if (!execute) continue
          if (batch && Permission.evaluate(key, "*", merged).action === "allow") {
            approved.add(key)
          }

          const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
          const transformed = ProviderTransform.schema(input.model, schema)
          item.inputSchema = jsonSchema(transformed)
          item.execute = (args, opts) =>
            Effect.runPromise(
              Effect.gen(function* () {
                const ctx = context(args, opts)
                yield* plugin.trigger(
                  "tool.execute.before",
                  { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId },
                  { args },
                )
                if (!approved.has(key)) {
                  yield* Effect.promise(() =>
                    ctx.ask({ permission: key, metadata: {}, patterns: ["*"], always: ["*"] }),
                  )
                }
                const result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.promise(() =>
                  execute(args, opts),
                )
                yield* plugin.trigger(
                  "tool.execute.after",
                  { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
                  result,
                )

                const textParts: string[] = []
                const attachments: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[] = []
                for (const contentItem of result.content) {
                  if (contentItem.type === "text") textParts.push(contentItem.text)
                  else if (contentItem.type === "image") {
                    attachments.push({
                      type: "file",
                      mime: contentItem.mimeType,
                      url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
                    })
                  } else if (contentItem.type === "resource") {
                    const { resource } = contentItem
                    if (resource.text) textParts.push(resource.text)
                    if (resource.blob) {
                      attachments.push({
                        type: "file",
                        mime: resource.mimeType ?? "application/octet-stream",
                        url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
                        filename: resource.uri,
                      })
                    }
                  }
                }

                const truncated = yield* truncate.output(textParts.join("\n\n"), {}, input.agent)
                const metadata = {
                  ...(result.metadata ?? {}),
                  truncated: truncated.truncated,
                  ...(truncated.truncated && { outputPath: truncated.outputPath }),
                }

                const output = {
                  title: "",
                  metadata,
                  output: truncated.content,
                  attachments: attachments.map((attachment) => ({
                    ...attachment,
                    id: PartID.ascending(),
                    sessionID: ctx.sessionID,
                    messageID: input.processor.message.id,
                  })),
                  content: result.content,
                }
                if (opts.abortSignal?.aborted) {
                  yield* input.processor.completeToolCall(opts.toolCallId, output)
                }
                return output
              }),
            )
          toolMeta.set(key, { parallelSafe: false })
          tools[key] = item
        }

        return { tools, toolMeta }
      })

      const shellImpl = Effect.fn("SessionPrompt.shellImpl")(function* (input: ShellInput) {
        const ctx = yield* InstanceState.context
        const session = yield* sessions.get(input.sessionID)
        if (session.revert) {
          yield* revert.cleanup(session)
        }
        const agent = yield* agents.get(input.agent)
        if (!agent) {
          const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
          const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
          const error = new NamedError.Unknown({ message: `Agent not found: "${input.agent}".${hint}` })
          yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
          throw error
        }
        const model = input.model ?? agent.model ?? (yield* lastModel(input.sessionID))
        const userMsg: MessageV2.User = {
          id: input.messageID ?? MessageID.ascending(),
          sessionID: input.sessionID,
          time: { created: Date.now() },
          role: "user",
          agent: input.agent,
          model: { providerID: model.providerID, modelID: model.modelID },
        }
        yield* sessions.updateMessage(userMsg)
        const userPart: MessageV2.Part = {
          type: "text",
          id: PartID.ascending(),
          messageID: userMsg.id,
          sessionID: input.sessionID,
          text: "The following tool was executed by the user",
          synthetic: true,
        }
        yield* sessions.updatePart(userPart)

        const msg: MessageV2.Assistant = {
          id: MessageID.ascending(),
          sessionID: input.sessionID,
          parentID: userMsg.id,
          mode: input.agent,
          agent: input.agent,
          cost: 0,
          path: { cwd: ctx.directory, root: ctx.worktree },
          time: { created: Date.now() },
          role: "assistant",
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: model.modelID,
          providerID: model.providerID,
        }
        yield* sessions.updateMessage(msg)
        const part: MessageV2.ToolPart = {
          type: "tool",
          id: PartID.ascending(),
          messageID: msg.id,
          sessionID: input.sessionID,
          tool: "bash",
          callID: ulid(),
          state: {
            status: "running",
            time: { start: Date.now() },
            input: { command: input.command },
          },
        }
        yield* sessions.updatePart(part)

        const sh = Shell.preferred()
        const shellName = (
          process.platform === "win32" ? path.win32.basename(sh, ".exe") : path.basename(sh)
        ).toLowerCase()
        const invocations: Record<string, { args: string[] }> = {
          nu: { args: ["-c", input.command] },
          fish: { args: ["-c", input.command] },
          zsh: {
            args: [
              "-l",
              "-c",
              `
                __oc_cwd=$PWD
                [[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
                [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
                cd "$__oc_cwd"
                eval ${JSON.stringify(input.command)}
              `,
            ],
          },
          bash: {
            args: [
              "-l",
              "-c",
              `
                __oc_cwd=$PWD
                shopt -s expand_aliases
                [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
                cd "$__oc_cwd"
                eval ${JSON.stringify(input.command)}
              `,
            ],
          },
          cmd: { args: ["/c", input.command] },
          powershell: { args: ["-NoProfile", "-Command", input.command] },
          pwsh: { args: ["-NoProfile", "-Command", input.command] },
          "": { args: ["-c", input.command] },
        }

        const args = (invocations[shellName] ?? invocations[""]).args
        const cwd = ctx.directory
        const shellEnv = yield* plugin.trigger(
          "shell.env",
          { cwd, sessionID: input.sessionID, callID: part.callID },
          { env: {} },
        )

        const cmd = ChildProcess.make(sh, args, {
          cwd,
          extendEnv: true,
          env: { ...shellEnv.env, TERM: "dumb" },
          stdin: "ignore",
          forceKillAfter: "3 seconds",
        })

        let output = ""
        let aborted = false

        const finish = Effect.uninterruptible(
          Effect.gen(function* () {
            if (aborted) {
              output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
            }
            if (!msg.time.completed) {
              msg.time.completed = Date.now()
              yield* sessions.updateMessage(msg)
            }
            if (part.state.status === "running") {
              part.state = {
                status: "completed",
                time: { ...part.state.time, end: Date.now() },
                input: part.state.input,
                title: "",
                metadata: { output, description: "" },
                output,
              }
              yield* sessions.updatePart(part)
            }
          }),
        )

        const exit = yield* Effect.gen(function* () {
          const handle = yield* spawner.spawn(cmd)
          yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
            Effect.sync(() => {
              output += chunk
              if (part.state.status === "running") {
                part.state.metadata = { output, description: "" }
                void Effect.runFork(sessions.updatePart(part))
              }
            }),
          )
          yield* handle.exitCode
        }).pipe(
          Effect.scoped,
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              aborted = true
            }),
          ),
          Effect.orDie,
          Effect.ensuring(finish),
          Effect.exit,
        )

        if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
          return yield* Effect.failCause(exit.cause)
        }

        return { info: msg, parts: [part] }
      })

      const getModel = Effect.fn("SessionPrompt.getModel")(function* (
        providerID: ProviderID,
        modelID: ModelID,
        sessionID: SessionID,
      ) {
        const exit = yield* provider.getModel(providerID, modelID).pipe(Effect.exit)
        if (Exit.isSuccess(exit)) return exit.value
        const err = Cause.squash(exit.cause)
        if (Provider.ModelNotFoundError.isInstance(err)) {
          const hint = err.data.suggestions?.length ? ` Did you mean: ${err.data.suggestions.join(", ")}?` : ""
          yield* bus.publish(Session.Event.Error, {
            sessionID,
            error: new NamedError.Unknown({
              message: `Model not found: ${err.data.providerID}/${err.data.modelID}.${hint}`,
            }).toObject(),
          })
        }
        return yield* Effect.failCause(exit.cause)
      })

      const lastModel = Effect.fnUntraced(function* (sessionID: SessionID) {
        const model = yield* Effect.promise(async () => {
          for await (const item of MessageV2.stream(sessionID)) {
            if (item.info.role === "user" && item.info.model) return item.info.model
          }
        })
        if (model) return model
        return yield* provider.defaultModel()
      })

      const createUserMessage = Effect.fn("SessionPrompt.createUserMessage")(function* (input: PromptInput) {
        const agentName = input.agent || (yield* agents.defaultAgent())
        const ag = yield* agents.get(agentName)
        if (!ag) {
          const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
          const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
          const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
          yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
          throw error
        }

        const model = input.model ?? ag.model ?? (yield* lastModel(input.sessionID))
        const same = ag.model && model.providerID === ag.model.providerID && model.modelID === ag.model.modelID
        const full =
          input.variant || (ag.variant && same)
            ? yield* provider.getModel(model.providerID, model.modelID).pipe(Effect.catchDefect(() => Effect.void))
            : undefined
        const variant =
          input.variant && full?.variants?.[input.variant]
            ? input.variant
            : ag.variant && same && full?.variants?.[ag.variant]
              ? ag.variant
              : undefined

        const info: MessageV2.User = {
          id: input.messageID ?? MessageID.ascending(),
          role: "user",
          sessionID: input.sessionID,
          time: { created: Date.now() },
          tools: input.tools,
          agent: ag.name,
          model: {
            providerID: model.providerID,
            modelID: model.modelID,
            variant,
          },
          system: input.system,
          format: input.format,
        }

        yield* Effect.addFinalizer(() => instruction.clear(info.id))

        type Draft<T> = T extends MessageV2.Part ? Omit<T, "id"> & { id?: string } : never
        const assign = (part: Draft<MessageV2.Part>): MessageV2.Part => ({
          ...part,
          id: part.id ? PartID.make(part.id) : PartID.ascending(),
        })

        const resolvePart: (part: PromptInput["parts"][number]) => Effect.Effect<Draft<MessageV2.Part>[]> = Effect.fn(
          "SessionPrompt.resolveUserPart",
        )(function* (part) {
          if (part.type === "file") {
            if (part.source?.type === "resource") {
              const { clientName, uri } = part.source
              log.info("mcp resource", { clientName, uri, mime: part.mime })
              const pieces: Draft<MessageV2.Part>[] = [
                {
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Reading MCP resource: ${part.filename} (${uri})`,
                },
              ]
              const exit = yield* mcp.readResource(clientName, uri).pipe(Effect.exit)
              if (Exit.isSuccess(exit)) {
                const content = exit.value
                if (!content) throw new Error(`Resource not found: ${clientName}/${uri}`)
                const items = Array.isArray(content.contents) ? content.contents : [content.contents]
                for (const c of items) {
                  if ("text" in c && c.text) {
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: c.text,
                    })
                  } else if ("blob" in c && c.blob) {
                    const mime = "mimeType" in c ? c.mimeType : part.mime
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `[Binary content: ${mime}]`,
                    })
                  }
                }
                pieces.push({ ...part, messageID: info.id, sessionID: input.sessionID })
              } else {
                const error = Cause.squash(exit.cause)
                log.error("failed to read MCP resource", { error, clientName, uri })
                const message = error instanceof Error ? error.message : String(error)
                pieces.push({
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  synthetic: true,
                  text: `Failed to read MCP resource ${part.filename}: ${message}`,
                })
              }
              return pieces
            }
            const url = new URL(part.url)
            switch (url.protocol) {
              case "data:":
                if (part.mime === "text/plain") {
                  return [
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                    },
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: decodeDataUrl(part.url),
                    },
                    { ...part, messageID: info.id, sessionID: input.sessionID },
                  ]
                }
                break
              case "file:": {
                log.info("file", { mime: part.mime })
                const filepath = fileURLToPath(part.url)
                if (yield* fsys.isDir(filepath)) part.mime = "application/x-directory"

                const { read } = yield* registry.named()
                const execRead = (args: Parameters<typeof read.execute>[0], extra?: Tool.Context["extra"]) =>
                  Effect.promise((signal: AbortSignal) =>
                    read.execute(args, {
                      sessionID: input.sessionID,
                      abort: signal,
                      agent: input.agent!,
                      messageID: info.id,
                      extra: { bypassCwdCheck: true, ...extra },
                      messages: [],
                      metadata: async () => {},
                      ask: async () => {},
                    }),
                  )

                if (part.mime === "text/plain") {
                  let offset: number | undefined
                  let limit: number | undefined
                  const range = { start: url.searchParams.get("start"), end: url.searchParams.get("end") }
                  if (range.start != null) {
                    const filePathURI = part.url.split("?")[0]
                    let start = parseInt(range.start)
                    let end = range.end ? parseInt(range.end) : undefined
                    if (start === end) {
                      const symbols = yield* lsp
                        .documentSymbol(filePathURI)
                        .pipe(Effect.catch(() => Effect.succeed([])))
                      for (const symbol of symbols) {
                        let r: LSP.Range | undefined
                        if ("range" in symbol) r = symbol.range
                        else if ("location" in symbol) r = symbol.location.range
                        if (r?.start?.line && r?.start?.line === start) {
                          start = r.start.line
                          end = r?.end?.line ?? start
                          break
                        }
                      }
                    }
                    offset = Math.max(start, 1)
                    if (end) limit = end - (offset - 1)
                  }
                  const args = { filePath: filepath, offset, limit }
                  const pieces: Draft<MessageV2.Part>[] = [
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                    },
                  ]
                  const exit = yield* provider.getModel(info.model.providerID, info.model.modelID).pipe(
                    Effect.flatMap((mdl) => execRead(args, { model: mdl })),
                    Effect.exit,
                  )
                  if (Exit.isSuccess(exit)) {
                    const result = exit.value
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: result.output,
                    })
                    if (result.attachments?.length) {
                      pieces.push(
                        ...result.attachments.map((a) => ({
                          ...a,
                          synthetic: true,
                          filename: a.filename ?? part.filename,
                          messageID: info.id,
                          sessionID: input.sessionID,
                        })),
                      )
                    } else {
                      pieces.push({ ...part, messageID: info.id, sessionID: input.sessionID })
                    }
                  } else {
                    const error = Cause.squash(exit.cause)
                    log.error("failed to read file", { error })
                    const message = error instanceof Error ? error.message : String(error)
                    yield* bus.publish(Session.Event.Error, {
                      sessionID: input.sessionID,
                      error: new NamedError.Unknown({ message }).toObject(),
                    })
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    })
                  }
                  return pieces
                }

                if (part.mime === "application/x-directory") {
                  const args = { filePath: filepath }
                  const exit = yield* execRead(args).pipe(Effect.exit)
                  if (Exit.isFailure(exit)) {
                    const error = Cause.squash(exit.cause)
                    log.error("failed to read directory", { error })
                    const message = error instanceof Error ? error.message : String(error)
                    yield* bus.publish(Session.Event.Error, {
                      sessionID: input.sessionID,
                      error: new NamedError.Unknown({ message }).toObject(),
                    })
                    return [
                      {
                        messageID: info.id,
                        sessionID: input.sessionID,
                        type: "text",
                        synthetic: true,
                        text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                      },
                    ]
                  }
                  return [
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                    },
                    {
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: exit.value.output,
                    },
                    { ...part, messageID: info.id, sessionID: input.sessionID },
                  ]
                }

                yield* filetime.read(input.sessionID, filepath)
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: {"filePath":"${filepath}"}`,
                  },
                  {
                    id: part.id,
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "file",
                    url:
                      `data:${part.mime};base64,` +
                      Buffer.from(yield* fsys.readFile(filepath).pipe(Effect.catch(Effect.die))).toString("base64"),
                    mime: part.mime,
                    filename: part.filename!,
                    source: part.source,
                  },
                ]
              }
            }
          }

          if (part.type === "agent") {
            const perm = Permission.evaluate("task", part.name, ag.permission)
            const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
            return [
              { ...part, messageID: info.id, sessionID: input.sessionID },
              {
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text:
                  " Use the above message and context to generate a prompt and call the task tool with subagent: " +
                  part.name +
                  hint,
              },
            ]
          }

          return [{ ...part, messageID: info.id, sessionID: input.sessionID }]
        })

        const parts = yield* Effect.forEach(input.parts, resolvePart, { concurrency: "unbounded" }).pipe(
          Effect.map((x) => x.flat().map(assign)),
        )

        yield* plugin.trigger(
          "chat.message",
          {
            sessionID: input.sessionID,
            agent: input.agent,
            model: input.model,
            messageID: input.messageID,
            variant: input.variant,
          },
          { message: info, parts },
        )

        const parsed = MessageV2.Info.safeParse(info)
        if (!parsed.success) {
          log.error("invalid user message before save", {
            sessionID: input.sessionID,
            messageID: info.id,
            agent: info.agent,
            model: info.model,
            issues: parsed.error.issues,
          })
        }
        parts.forEach((part, index) => {
          const p = MessageV2.Part.safeParse(part)
          if (p.success) return
          log.error("invalid user part before save", {
            sessionID: input.sessionID,
            messageID: info.id,
            partID: part.id,
            partType: part.type,
            index,
            issues: p.error.issues,
            part,
          })
        })

        yield* sessions.updateMessage(info)
        for (const part of parts) yield* sessions.updatePart(part)

        return { info, parts }
      }, Effect.scoped)

      const prompt: (input: PromptInput) => Effect.Effect<MessageV2.WithParts> = Effect.fn("SessionPrompt.prompt")(
        function* (input: PromptInput) {
          const session = yield* sessions.get(input.sessionID)
          yield* revert.cleanup(session)
          const message = yield* createUserMessage(input)
          yield* sessions.touch(input.sessionID)

          // Hook dispatch: UserPromptSubmit (blocking — can deny)
          const cfg = yield* Effect.promise(() => Config.get())
          if (cfg.experimental?.hooks !== false) {
            const rules = yield* Effect.promise(() => Hook.load())
            const text = input.parts
              .filter((p): p is { type: "text"; text: string } => p.type === "text")
              .map((p) => p.text)
              .join("\n")
            const exit = yield* Effect.exit(
              Hook.dispatch(
                "UserPromptSubmit",
                {
                  sessionID: input.sessionID,
                  prompt: text,
                  transcript_path: path.join(Global.Path.transcripts, input.sessionID + ".jsonl"),
                },
                rules,
                cfg,
              ),
            )
            if (Exit.isFailure(exit)) {
              const err = Cause.squash(exit.cause)
              const reason = Hook.HookDenied.isInstance(err)
                ? err.data.message
                : err && typeof err === "object" && "message" in err
                  ? String(err.message)
                  : "hook denied prompt"
              log.warn("hook-denied-prompt", { sessionID: input.sessionID, reason })
              const error = new NamedError.Unknown({
                message: reason,
              })
              yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
              return message
            }
            if (Exit.isSuccess(exit) && exit.value.output.length > 0) {
              HookContext.setTurn(input.sessionID, exit.value.output.join("\n\n"))
            }
          }

          // Skill-command injection: if prompt matches a plugin skill, inject content into model context
          const prompt = input.parts
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join("\n")
          const cmdMatch = /^\/([^\s]+)/.exec(prompt)
          if (cmdMatch) {
            const skill = yield* Effect.promise(() => Hook.resolveSkill(cmdMatch[1]))
            if (skill) {
              const existing = HookContext.getSession(input.sessionID)
              HookContext.setSession(input.sessionID, existing ? existing + "\n\n" + skill : skill)
            }
          }

          const permissions: Permission.Ruleset = []
          for (const [t, enabled] of Object.entries(input.tools ?? {})) {
            permissions.push({ permission: t, action: enabled ? "allow" : "deny", pattern: "*" })
          }
          if (permissions.length > 0) {
            session.permission = permissions
            yield* sessions.setPermission({ sessionID: session.id, permission: permissions })
          }

          if (input.noReply === true) return message
          return yield* loop({ sessionID: input.sessionID })
        },
      )

      const complete: (input: CompleteInput) => Effect.Effect<MessageV2.WithParts> = Effect.fn(
        "SessionPrompt.complete",
      )(function* (input: CompleteInput) {
        return yield* state.ensureRunning(
          input.sessionID,
          lastAssistant(input.sessionID),
          Effect.promise(async (abort) => {
            const session = await Session.get(input.sessionID)
            await SessionRevert.cleanup(session)

            const base = input.model ?? (await lastModel(input.sessionID).pipe(Effect.runPromise))
            const cfg = await Config.get()
            const model = await (async () => {
              if (input.model) return Provider.getModel(input.model.providerID, input.model.modelID)
              if (input.small === false) return Provider.getModel(base.providerID, base.modelID)
              return (
                (await resolveLocalAsync(cfg, "complete")) ??
                (await Provider.getSmallModel(base.providerID)) ??
                Provider.getModel(base.providerID, base.modelID)
              )
            })()

            const user = await createUserMessage({
              sessionID: input.sessionID,
              model: {
                providerID: model.providerID,
                modelID: model.id,
              },
              parts: input.parts,
            }).pipe(Effect.runPromise)
            await sessions.touch(input.sessionID).pipe(Effect.runPromise)

            const agent = await Agent.get(user.info.agent)
            if (!agent) throw new Error(`Agent not found: ${user.info.agent}`)

            const assistant = (await Session.updateMessage({
              id: MessageID.ascending(),
              parentID: user.info.id,
              role: "assistant",
              mode: agent.name,
              agent: agent.name,
              variant: user.info.model.variant,
              path: {
                cwd: Instance.directory,
                root: Instance.worktree,
              },
              cost: 0,
              tokens: {
                input: 0,
                output: 0,
                reasoning: 0,
                cache: { read: 0, write: 0 },
              },
              modelID: model.id,
              providerID: model.providerID,
              time: {
                created: Date.now(),
              },
              sessionID: input.sessionID,
            })) as MessageV2.Assistant

            let text: MessageV2.TextPart | undefined
            const reason: Record<string, MessageV2.ReasoningPart> = {}

            try {
              const result = await LLM.stream({
                user: user.info as MessageV2.User,
                agent,
                permission: session.permission,
                abort,
                sessionID: input.sessionID,
                system: [],
                messages: await MessageV2.toModelMessages(
                  MessageV2.filterCompacted(MessageV2.stream(input.sessionID)),
                  model,
                  { stripThinkingText: cfg.experimental?.strip_thinking_text !== false }, // [fork-perf] strip-thinking
                ),
                tools: {},
                model,
                retries: 2,
                small: input.small ?? true,
              })

              for await (const event of result.fullStream) {
                if (event.type === "error") throw event.error

                if (event.type === "reasoning-start") {
                  if (reason[event.id]) continue
                  reason[event.id] = await Session.updatePart({
                    id: PartID.ascending(),
                    messageID: assistant.id,
                    sessionID: assistant.sessionID,
                    type: "reasoning",
                    text: "",
                    time: { start: Date.now() },
                    metadata: event.providerMetadata,
                  })
                  continue
                }

                if (event.type === "reasoning-delta") {
                  const part = reason[event.id]
                  if (!part) continue
                  part.text += event.text
                  if (event.providerMetadata) part.metadata = event.providerMetadata
                  await Session.updatePartDelta({
                    sessionID: part.sessionID,
                    messageID: part.messageID,
                    partID: part.id,
                    field: "text",
                    delta: event.text,
                  })
                  continue
                }

                if (event.type === "reasoning-end") {
                  const part = reason[event.id]
                  if (!part) continue
                  part.text = part.text.trimEnd()
                  part.time = { ...part.time, end: Date.now() }
                  if (event.providerMetadata) part.metadata = event.providerMetadata
                  await Session.updatePart(part)
                  delete reason[event.id]
                  continue
                }

                if (event.type === "text-start") {
                  text = await Session.updatePart({
                    id: PartID.ascending(),
                    messageID: assistant.id,
                    sessionID: assistant.sessionID,
                    type: "text",
                    text: "",
                    time: { start: Date.now() },
                    metadata: event.providerMetadata,
                  })
                  continue
                }

                if (event.type === "text-delta") {
                  if (!text) continue
                  text.text += event.text
                  if (event.providerMetadata) text.metadata = event.providerMetadata
                  await Session.updatePartDelta({
                    sessionID: text.sessionID,
                    messageID: text.messageID,
                    partID: text.id,
                    field: "text",
                    delta: event.text,
                  })
                  continue
                }

                if (event.type === "text-end") {
                  if (!text) continue
                  text.text = text.text.trimEnd()
                  text.time = { start: text.time?.start ?? Date.now(), end: Date.now() }
                  if (event.providerMetadata) text.metadata = event.providerMetadata
                  await Session.updatePart(text)
                  text = undefined
                  continue
                }

                if (event.type === "finish-step") {
                  const usage = Session.getUsage({
                    model,
                    usage: event.usage,
                    metadata: event.providerMetadata,
                  })
                  assistant.finish = event.finishReason
                  assistant.cost += usage.cost
                  assistant.tokens = usage.tokens
                  // Cache break detection: large context with zero cache reads suggests cache bust
                  if (usage.tokens.cache.read === 0 && usage.tokens.input > 10000 && usage.tokens.cache.write === 0) {
                    log.warn("cache-break", { input: usage.tokens.input, model: model.id })
                  }
                  await Session.updatePart({
                    id: PartID.ascending(),
                    reason: event.finishReason,
                    messageID: assistant.id,
                    sessionID: assistant.sessionID,
                    type: "step-finish",
                    tokens: usage.tokens,
                    cost: usage.cost,
                  })
                  await Session.updateMessage(assistant)
                  // Append Claude Code-compatible JSONL entry for hook transcript_path compat
                  await appendFile(
                    path.join(Global.Path.transcripts, input.sessionID + ".jsonl"),
                    JSON.stringify({
                      type: "assistant",
                      message: {
                        model: model.id,
                        usage: {
                          output_tokens: usage.tokens.output,
                          cache_read_input_tokens: usage.tokens.cache.read,
                        },
                      },
                    }) + "\n",
                    "utf8",
                  ).catch(() => {})
                }
              }
            } catch (err) {
              assistant.error = MessageV2.fromError(err, {
                providerID: model.providerID,
                aborted: abort.aborted,
              })
              await Bus.publish(Session.Event.Error, {
                sessionID: input.sessionID,
                error: assistant.error,
              })
            }

            if (text) {
              text.time = { start: text.time?.start ?? Date.now(), end: Date.now() }
              await Session.updatePart(text)
            }
            await Promise.all(
              Object.values(reason).map((part) =>
                Session.updatePart({
                  ...part,
                  time: { start: part.time.start ?? Date.now(), end: Date.now() },
                }),
              ),
            )

            if (!assistant.time.completed) assistant.time.completed = Date.now()
            await Session.updateMessage(assistant)

            return {
              info: assistant,
              parts: MessageV2.parts(assistant.id),
            }
          }),
        )
      })

      const lastAssistant = (sessionID: SessionID) =>
        Effect.promise(async () => {
          let latest: MessageV2.WithParts | undefined
          for await (const item of MessageV2.stream(sessionID)) {
            latest ??= item
            if (item.info.role !== "user") return item
          }
          if (latest) return latest
          throw new Error("Impossible")
        })

      const runLoop: (sessionID: SessionID) => Effect.Effect<MessageV2.WithParts> = Effect.fn("SessionPrompt.run")(
        function* (sessionID: SessionID) {
          const ctx = yield* InstanceState.context
          let structured: unknown | undefined
          let step = 0
          const session = yield* sessions.get(sessionID)
          // Cache system prompt fragments that are stable within a single runLoop call
          let cachedSkills: { key: string; value: string | undefined } | undefined
          let cachedEnv: { key: string; value: string[] } | undefined
          // [fork-perf] Phase 1: per-runLoop history cache; rebuilds ModelMessages
          // incrementally as new messages arrive, invalidated explicitly on compaction.
          const _cfgPerf = yield* config.get()
          const historyCache = _cfgPerf.experimental?.history_cache !== false ? HistoryCache.create() : undefined

          // [cache-debug] open one debug-log handle for this runLoop invocation
          const _cacheDebugLog = CacheDebugLog.open(sessionID, _cfgPerf)
          // tracking state for per-turn delta computation and change detection
          let _cdbPrevTokens: CacheDebugLog.TokenCounts | undefined
          let _cdbPrevSystemHash: string | undefined
          let _cdbPrevToolsHash: string | undefined
          let _cdbPrevMsgsHash: string | undefined

          while (true) {
            yield* status.set(sessionID, { type: "busy" })
            log.info("loop", { step, sessionID })

            // [cache-debug] prune event
            const _cdbPruneMsgsBefore = yield* MessageV2.filterCompactedEffect(sessionID)
            yield* compaction.prune({ sessionID }).pipe(Effect.orElseSucceed(() => false))
            let msgs = yield* MessageV2.filterCompactedEffect(sessionID)
            if (_cacheDebugLog && msgs.length !== _cdbPruneMsgsBefore.length) {
              _cacheDebugLog.log({
                type: "prune",
                sessionID,
                event: "prune",
                msgsLenBefore: _cdbPruneMsgsBefore.length,
                msgsLenAfter: msgs.length,
                msgsFingerprintBefore: MessageV2.msgsFingerprint(_cdbPruneMsgsBefore),
                msgsFingerprintAfter: MessageV2.msgsFingerprint(msgs),
                historyCacheInvalidated: false,
                tokenEstimate: CacheDebugLog.cheapTokenEstimate(msgs),
                ts: Date.now(),
              })
            }

            // [fork-perf] cache-stability: restore in-memory synthetic summary that
            // SlidingWindow.compact() produced last iteration. Synthetic is never persisted
            // to DB so filterCompactedEffect cannot see it. Adopt peeked array if first part
            // is a synthetic <context-summary> text and shape aligns with DB tail.
            //
            // CRITICAL: also append any DB msgs that arrived AFTER the stash was taken,
            // otherwise an errored assistant persisted post-stash is invisible to the
            // doom-loop guard below and the loop spins. The stash is frozen at the last
            // compact; new tail msgs (tool turns, errored assistants) live only in the
            // fresh DB read.
            const peeked = SlidingWindow.peekCompacted(sessionID)
            if (peeked && peeked.length > 0) {
              const firstPart = peeked[0]?.parts[0]
              const isSyntheticSummary =
                firstPart?.type === "text" &&
                (firstPart as { synthetic?: boolean }).synthetic === true &&
                firstPart.text.startsWith("<context-summary>")
              if (isSyntheticSummary && peeked.length <= msgs.length + 1) {
                const stashTailIds = new Set(peeked.map((m) => m.info.id))
                const tail = msgs.filter((m) => !stashTailIds.has(m.info.id))
                msgs = tail.length > 0 ? [...peeked, ...tail] : peeked
              }
            }

            const { user: lastUser, assistant: lastAssistant, finished: lastFinished, tasks } = MessageV2.latest(msgs)

            if (!lastUser) throw new Error("No user message found in stream. This should never happen.")

            const lastAssistantMsg = msgs.findLast(
              (msg) => msg.info.role === "assistant" && msg.info.id === lastAssistant?.id,
            )
            // Some providers return "stop" even when the assistant message contains tool calls.
            // Keep the loop running so tool results can be sent back to the model.
            // Skip provider-executed tool parts — those were fully handled within the
            // provider's stream (e.g. DWS Agent Platform) and don't need a re-loop.
            // Skip orphaned interrupted tools — these were marked interrupted during
            // cleanup/abort and should not keep the run-loop alive.
            const hasToolCalls =
              lastAssistantMsg?.parts.some(
                (part) =>
                  part.type === "tool" &&
                  !part.metadata?.providerExecuted &&
                  !(part.state.status === "error" && part.state.metadata?.interrupted === true),
              ) ?? false

            // [fork-perf] doom-loop guard: an errored assistant (e.g. schema-validation
            // failure pre-stream) leaves `finish` undefined, so the normal exit
            // condition below never matches and the loop spins. Stop immediately
            // when the most recent assistant carries an error newer than the user.
            if (lastAssistant?.error && lastUser.id < lastAssistant.id) {
              log.info("exiting loop on errored assistant", { sessionID, error: lastAssistant.error?.name })
              break
            }

            if (
              lastAssistant?.finish &&
              !["tool-calls"].includes(lastAssistant.finish) &&
              !hasToolCalls &&
              lastUser.id < lastAssistant.id
            ) {
              // Goal auto-continuation: if goal active + under budget, inject continuation
              // instead of exiting the loop.
              const exitCfg = yield* config.get()
              if (exitCfg.experimental?.goal_system !== false) {
                const goal = Goal.get(sessionID)
                if (goal && GoalLoop.shouldContinue({ goal, step })) {
                  Goal.tick({ id: goal.id, tokens: lastFinished?.tokens?.input ?? 0, turns: 1 })
                  const updated = Goal.get(sessionID)
                  if (updated && updated.status === "active") {
                    yield* createUserMessage({
                      sessionID,
                      agent: lastUser.agent,
                      model: lastUser.model,
                      parts: [{ type: "text", text: GoalLoop.continuation(updated), synthetic: true }],
                    })
                    continue
                  }
                }
              }
              const orphaned = lastAssistantMsg?.parts.filter(
                (part) => part.type === "tool" && part.state.status === "error" && part.state.metadata?.interrupted,
              ).length
              if (orphaned) log.info("exiting loop with orphaned interrupted tools", { sessionID, orphaned })
              else log.info("exiting loop", { sessionID })
              break
            }

            step++
            if (step === 1)
              yield* title({
                session,
                modelID: lastUser.model.modelID,
                providerID: lastUser.model.providerID,
                history: msgs,
              }).pipe(Effect.ignore, Effect.forkIn(scope))

            if (step === 1 && !session.parentID)
              yield* Effect.gen(function* () {
                const dream = yield* agents.get("dream")
                const distill = yield* agents.get("distill")
                DreamTrigger.check({ sessionID, cfg: _cfgPerf, dream, distill })
              }).pipe(Effect.ignore, Effect.forkIn(scope))

            const model = yield* getModel(lastUser.model.providerID, lastUser.model.modelID, sessionID)
            const task = tasks.pop()

            if (task?.type === "subtask") {
              yield* handleSubtask(
                { sessions, agents, registry, plugin, permission, bus, status, getModel },
                { task, model, lastUser, sessionID, session, msgs },
              )
              continue
            }

            if (task?.type === "compaction") {
              SlidingWindow.invalidate(sessionID)
              const _cdbCpFpBefore = MessageV2.msgsFingerprint(msgs)
              const result = yield* compaction.process({
                messages: msgs,
                parentID: lastUser.id,
                sessionID,
                auto: task.auto,
                overflow: task.overflow,
              })
              // [fork-perf] Phase 1: invalidate AFTER compaction so next turn
              // rebuilds from the post-compaction state, not pre-compaction stale messages.
              historyCache?.invalidate()
              if (_cacheDebugLog) {
                const _cdbCpMsgsAfter = yield* MessageV2.filterCompactedEffect(sessionID)
                _cacheDebugLog.log({
                  type: "prune",
                  sessionID,
                  event: "compaction-process",
                  msgsLenBefore: msgs.length,
                  msgsLenAfter: _cdbCpMsgsAfter.length,
                  msgsFingerprintBefore: _cdbCpFpBefore,
                  msgsFingerprintAfter: MessageV2.msgsFingerprint(_cdbCpMsgsAfter),
                  historyCacheInvalidated: true,
                  tokenEstimate: CacheDebugLog.cheapTokenEstimate(_cdbCpMsgsAfter),
                  ts: Date.now(),
                })
              }
              if (result === "stop") break
              continue
            }

            if (
              lastFinished &&
              lastFinished.summary !== true &&
              (yield* compaction.isOverflow({ tokens: lastFinished.tokens, model }))
            ) {
              yield* compaction.create({ sessionID, agent: lastUser.agent, model: lastUser.model, auto: true })
              continue
            }

            const agent = yield* agents.get(lastUser.agent)
            if (!agent) {
              const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
              const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
              const error = new NamedError.Unknown({ message: `Agent not found: "${lastUser.agent}".${hint}` })
              yield* bus.publish(Session.Event.Error, { sessionID, error: error.toObject() })
              throw error
            }
            const maxSteps = agent.steps ?? Infinity
            const isLastStep = step >= maxSteps
            if (isLastStep && lastAssistant?.parentID === lastUser.id && lastAssistant.id === lastFinished?.id) {
              log.info("exiting loop at max agent steps", { sessionID, step, maxSteps })
              break
            }
            const reminderResult = yield* insertReminders({ sessions, fsys }, { messages: msgs, agent, session })
            msgs = reminderResult.messages

            const msg: MessageV2.Assistant = {
              id: MessageID.ascending(),
              parentID: lastUser.id,
              role: "assistant",
              mode: agent.name,
              agent: agent.name,
              variant: lastUser.model.variant,
              path: { cwd: ctx.directory, root: ctx.worktree },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: model.id,
              providerID: model.providerID,
              time: { created: Date.now() },
              sessionID,
            }
            yield* sessions.updateMessage(msg)
            const handle = yield* processor.create({
              assistantMessage: msg,
              sessionID,
              model,
            })

            const outcome: "break" | "continue" = yield* Effect.gen(function* () {
              const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
              const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false

              const resolvedTools = yield* resolveTools({
                agent,
                session,
                model,
                tools: lastUser.tools,
                processor: handle,
                bypassAgentCheck,
                messages: msgs,
              })
              const tools = resolvedTools.tools

              if (lastUser.format?.type === "json_schema") {
                tools["StructuredOutput"] = createStructuredOutputTool({
                  schema: lastUser.format.schema,
                  onSuccess(output) {
                    structured = output
                  },
                })
              }

              if (step === 1) SessionSummary.summarize({ sessionID, messageID: lastUser.id })

              if (step > 1 && lastFinished) {
                for (const m of msgs) {
                  if (m.info.role !== "user" || m.info.id <= lastFinished.id) continue
                  for (const p of m.parts) {
                    if (p.type !== "text" || p.ignored || p.synthetic) continue
                    if (!p.text.trim()) continue
                    p.text = [
                      "<system-reminder>",
                      "The user sent the following message:",
                      p.text,
                      "",
                      "Please address this message and continue with your tasks.",
                      "</system-reminder>",
                    ].join("\n")
                  }
                }
              }

              yield* plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })
              const cfg = yield* config.get()
              const before = msgs.length
              const _cdbSwFpBefore = MessageV2.msgsFingerprint(msgs)
              msgs = yield* SlidingWindow.compact({
                msgs,
                model,
                provider,
                cfg,
                sessionID,
                agent,
                hint: lastFinished?.tokens
                  ? lastFinished.tokens.input + lastFinished.tokens.cache.read + lastFinished.tokens.cache.write
                  : undefined,
              })
              log.info("compact", { sessionID, before, after: msgs.length })
              const _cdbSwChanged = msgs.length !== before
              if (_cdbSwChanged) historyCache?.invalidate() // [fork-perf] Phase 1
              if (_cacheDebugLog && (_cdbSwChanged || MessageV2.msgsFingerprint(msgs) !== _cdbSwFpBefore)) {
                _cacheDebugLog.log({
                  type: "prune",
                  sessionID,
                  event: "sliding-window-compact",
                  msgsLenBefore: before,
                  msgsLenAfter: msgs.length,
                  msgsFingerprintBefore: _cdbSwFpBefore,
                  msgsFingerprintAfter: MessageV2.msgsFingerprint(msgs),
                  historyCacheInvalidated: _cdbSwChanged,
                  tokenEstimate: CacheDebugLog.cheapTokenEstimate(msgs),
                  ts: Date.now(),
                })
              }
              const sw = SlidingWindow.getMetrics(sessionID)
              if (sw) {
                handle.message.compaction = { total: sw.total, savings: sw.savings, msgs: sw.msgs }
              }

              if (cfg.experimental?.proactive_prune && lastFinished?.tokens) {
                const used =
                  lastFinished.tokens.input + lastFinished.tokens.cache.read + lastFinished.tokens.cache.write
                const limit = model.limit?.context ?? 200_000
                // [fork-perf] cache-stability: skip proactive_prune when SlidingWindow.compact
                // already trimmed history this turn. Stacking both invalidates the prompt-cache
                // breakpoint twice in one turn for marginal additional savings.
                const slidingCompactedThisTurn = before !== msgs.length
                if (used > limit * 0.8 && !slidingCompactedThisTurn) {
                  yield* compaction.prune({ sessionID, aggressive: true }).pipe(Effect.orElseSucceed(() => false))
                  msgs = yield* MessageV2.filterCompactedEffect(sessionID)
                  // [fork-perf] Phase 1: msgs replaced — next turn must rebuild from fresh state
                  historyCache?.invalidate()
                }
              }

              // Tool result budget (Phase 1A)
              if (cfg.experimental?.tool_result_budget) {
                const _cdbTbBefore = msgs.length
                const _cdbTbFpBefore = MessageV2.msgsFingerprint(msgs)
                msgs = applyToolBudget(msgs, cfg.experimental.tool_result_budget)
                if (_cacheDebugLog && msgs.length !== _cdbTbBefore) {
                  _cacheDebugLog.log({
                    type: "prune",
                    sessionID,
                    event: "tool-budget",
                    msgsLenBefore: _cdbTbBefore,
                    msgsLenAfter: msgs.length,
                    msgsFingerprintBefore: _cdbTbFpBefore,
                    msgsFingerprintAfter: MessageV2.msgsFingerprint(msgs),
                    historyCacheInvalidated: false,
                    tokenEstimate: CacheDebugLog.cheapTokenEstimate(msgs),
                    ts: Date.now(),
                  })
                }
              }

              // MicroCompact at 75% (Phase 1C) — mutual exclusion with proactive_prune
              if (cfg.experimental?.microcompact && !cfg.experimental?.proactive_prune && lastFinished?.tokens) {
                const used =
                  lastFinished.tokens.input + lastFinished.tokens.cache.read + lastFinished.tokens.cache.write
                const limit = model.limit?.context ?? 200_000
                if (MicroCompact.shouldCompact({ input: used, context: limit })) {
                  const prevLen = msgs.length
                  const _cdbMcFpBefore = MessageV2.msgsFingerprint(msgs)
                  msgs = yield* (
                    MicroCompact.compact({
                      sessionID,
                      msgs,
                      model,
                      provider,
                      cfg,
                    }) as Effect.Effect<MessageV2.WithParts[]>
                  ).pipe(Effect.orElseSucceed(() => msgs))
                  // [fork-perf] Phase 1: invalidate only when MicroCompact actually changed msgs
                  const _cdbMcChanged = msgs.length !== prevLen
                  if (_cdbMcChanged) historyCache?.invalidate()
                  if (_cacheDebugLog && _cdbMcChanged) {
                    _cacheDebugLog.log({
                      type: "prune",
                      sessionID,
                      event: "microcompact",
                      msgsLenBefore: prevLen,
                      msgsLenAfter: msgs.length,
                      msgsFingerprintBefore: _cdbMcFpBefore,
                      msgsFingerprintAfter: MessageV2.msgsFingerprint(msgs),
                      historyCacheInvalidated: _cdbMcChanged,
                      tokenEstimate: CacheDebugLog.cheapTokenEstimate(msgs),
                      ts: Date.now(),
                    })
                  }
                }
              }

              // Context collapse at 97% (Phase 1B)
              if (cfg.experimental?.context_collapse && lastFinished?.tokens) {
                const used =
                  lastFinished.tokens.input + lastFinished.tokens.cache.read + lastFinished.tokens.cache.write
                const limit = model.limit?.context ?? 200_000
                if (ContextCollapse.shouldCollapse({ input: used, context: limit })) {
                  const prevLen = msgs.length
                  const _cdbCcFpBefore = MessageV2.msgsFingerprint(msgs)
                  msgs = yield* (
                    ContextCollapse.collapse({
                      sessionID,
                      msgs,
                      model,
                      provider,
                      cfg,
                    }) as Effect.Effect<MessageV2.WithParts[]>
                  ).pipe(Effect.orElseSucceed(() => msgs))
                  // [fork-perf] Phase 1: invalidate only when ContextCollapse actually changed msgs
                  const _cdbCcChanged = msgs.length !== prevLen
                  if (_cdbCcChanged) historyCache?.invalidate()
                  if (_cacheDebugLog && _cdbCcChanged) {
                    _cacheDebugLog.log({
                      type: "prune",
                      sessionID,
                      event: "context-collapse",
                      msgsLenBefore: prevLen,
                      msgsLenAfter: msgs.length,
                      msgsFingerprintBefore: _cdbCcFpBefore,
                      msgsFingerprintAfter: MessageV2.msgsFingerprint(msgs),
                      historyCacheInvalidated: _cdbCcChanged,
                      tokenEstimate: CacheDebugLog.cheapTokenEstimate(msgs),
                      ts: Date.now(),
                    })
                  }
                }
              }

              const skillsKey = agent.name
              const envKey = `${model.providerID}:${model.id}`
              const [skills, env, instructions, modelMsgs] = yield* Effect.all([
                Effect.gen(function* () {
                  if (cachedSkills?.key === skillsKey) return cachedSkills.value
                  const val = yield* Effect.promise(() => SystemPrompt.skills(agent))
                  cachedSkills = { key: skillsKey, value: val }
                  return val
                }),
                Effect.gen(function* () {
                  if (cachedEnv?.key === envKey) return cachedEnv.value
                  const val = yield* Effect.promise(() => SystemPrompt.environment(model))
                  cachedEnv = { key: envKey, value: val }
                  return val
                }),
                instruction.system().pipe(Effect.orDie),
                // [fork-perf] Phase 1: use historyCache when enabled — incremental ModelMessage rebuild.
                // The cache invalidates on compaction (see seams above) so msg-array drift is bounded.
                historyCache
                  ? historyCache
                      .get({ sessionID, model, stripThinkingText: cfg.experimental?.strip_thinking_text !== false })
                      .pipe(Effect.map((r) => r.modelMessages)) // [fork-perf] strip-thinking
                  : MessageV2.toModelMessagesEffect(msgs, model, {
                      stripThinkingText: cfg.experimental?.strip_thinking_text !== false,
                    }), // [fork-perf] strip-thinking
              ])
              const system: string[] = []
              // Prompt split caching: stable prefix (one joined entry) then dynamic suffix
              if (cfg.experimental?.prompt_split_caching !== false) {
                const stable = [...(skills ? [skills] : []), ...instructions].filter((x) => x)
                system.push(stable.join("\n"))
                system.push(...env)
              } else {
                system.push(...env, ...(skills ? [skills] : []), ...instructions)
              }
              if (agent.mode === "primary") {
                const memory = yield* Effect.promise(() => Memory.list(sessionID)).pipe(
                  Effect.orElseSucceed(() => [] as Awaited<ReturnType<typeof Memory.list>>),
                )
                if (memory.length > 0) system.push("Session Memory:\n" + memory.map((m) => `- ${m.content}`).join("\n"))
              }

              // Persistent memory (Phase 6)
              if (cfg.experimental?.persistent_memory !== false) {
                const mem = PersistentMemory.inject()
                if (mem) system.push(mem)
              }

              // Goal addendum (Phase 3)
              if (cfg.experimental?.goal_system !== false) {
                const goal = Goal.get(sessionID)
                if (goal) system.push(Goal.addendum(goal))
              }

              // Hook context injection (plugin stdout)
              const hookSession = HookContext.getSession(sessionID)
              if (hookSession) system.push(hookSession)
              const hookTurn = HookContext.getTurn(sessionID)
              if (hookTurn) system.push(hookTurn)

              const format = lastUser.format ?? { type: "text" as const }
              if (format.type === "json_schema") system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)
              // Multi-step gate: allow SDK-internal looping for safe tool sets
              const safe = LLM.parallelGate({
                agent,
                permission: session.permission,
                cfg,
                toolMeta: resolvedTools.toolMeta,
              })
              const steps =
                safe && cfg.experimental?.multi_step !== false ? (cfg.experimental?.multi_step_count ?? 5) : undefined

              // [cache-debug] capture pre-call hashes; the actual token-count log
              // is emitted AFTER handle.process completes so we read the real
              // usage from handle.message.tokens (not the prior turn's stale snapshot).
              let _cdbTurnHashes: { sys: string; tools: string; msgs: string } | undefined
              if (_cacheDebugLog) {
                _cdbTurnHashes = {
                  sys: CacheDebugLog.systemHash(system),
                  tools: CacheDebugLog.toolsHash(Object.keys(tools)),
                  msgs: CacheDebugLog.djb2(MessageV2.msgsFingerprint(msgs)),
                }
              }

              // [response-chaining] Read last response_id for OpenAI previousResponseId chaining
              // Chain breaks if compaction occurred after the last step-finish with response_id
              const lastResponseId = (() => {
                let rid: string | undefined
                let ridPartId: string | undefined
                for (let i = msgs.length - 1; i >= 0; i--) {
                  const msg = msgs[i]
                  if (msg.info.role !== "assistant") continue
                  for (let j = msg.parts.length - 1; j >= 0; j--) {
                    const part = msg.parts[j]
                    if (part.type === "step-finish" && part.response_id) {
                      rid = part.response_id
                      ridPartId = part.id
                      break
                    }
                  }
                  if (rid) break
                }
                if (!rid || !ridPartId) return undefined
                // Check if compaction occurred after the response_id part
                for (const msg of msgs) {
                  for (const part of msg.parts) {
                    if (part.type === "compaction" && part.id > ridPartId!) return undefined
                  }
                }
                return rid
              })()

              const result = yield* handle.process({
                user: lastUser,
                agent,
                permission: session.permission,
                sessionID,
                parentSessionID: session.parentID,
                system,
                messages: [...modelMsgs, ...(isLastStep ? [{ role: "assistant" as const, content: MAX_STEPS }] : [])],
                tools,
                toolMeta: resolvedTools.toolMeta,
                model,
                toolChoice: format.type === "json_schema" ? "required" : undefined,
                maxSteps: steps,
                lastResponseId,
              })
              // [fork-perf] history-cache: assistant message's parts mutate during streaming
              // (tool calls/results appended in place to the existing assistant message ID).
              // streamAfterEffect only finds messages with id > lastMessageID, so it cannot
              // detect parts.length change on the SAME message. Invalidate after each turn
              // (correctness > memoization). The cache still wins INSIDE a turn (tools batch).
              historyCache?.invalidate()

              // [cache-debug] log TurnEvent AFTER the LLM call so we capture real usage
              // from handle.message.tokens, not the prior turn's stale snapshot.
              if (_cacheDebugLog && _cdbTurnHashes) {
                const t = handle.message.tokens
                const curTokens: CacheDebugLog.TokenCounts = {
                  input: t?.input ?? 0,
                  cacheRead: t?.cache?.read ?? 0,
                  cacheWrite: t?.cache?.write ?? 0,
                  output: t?.output ?? 0,
                }
                const tokenDelta: CacheDebugLog.TokenDelta = _cdbPrevTokens
                  ? {
                      input: curTokens.input - _cdbPrevTokens.input,
                      cacheRead: curTokens.cacheRead - _cdbPrevTokens.cacheRead,
                      cacheWrite: curTokens.cacheWrite - _cdbPrevTokens.cacheWrite,
                      output: curTokens.output - _cdbPrevTokens.output,
                    }
                  : { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
                _cdbPrevTokens = curTokens

                const { sys: sysHash, tools: tHash, msgs: mHash } = _cdbTurnHashes
                const turnEvent: CacheDebugLog.TurnEvent = {
                  type: "turn",
                  sessionID,
                  turn: step,
                  tokens: curTokens,
                  tokenDelta,
                  ...(sysHash !== _cdbPrevSystemHash ? { systemHash: sysHash } : {}),
                  ...(tHash !== _cdbPrevToolsHash ? { toolsHash: tHash } : {}),
                  ...(mHash !== _cdbPrevMsgsHash ? { msgsHash: mHash } : {}),
                  flags: CacheDebugLog.extractFlags(cfg),
                  provider: model.providerID,
                  model: model.id,
                  ts: Date.now(),
                }
                _cdbPrevSystemHash = sysHash
                _cdbPrevToolsHash = tHash
                _cdbPrevMsgsHash = mHash
                _cacheDebugLog.log(turnEvent)
              }

              if (structured !== undefined) {
                handle.message.structured = structured
                handle.message.finish = handle.message.finish ?? "stop"
                yield* sessions.updateMessage(handle.message)
                return "break" as const
              }

              const finished = handle.message.finish && !["tool-calls", "unknown"].includes(handle.message.finish)
              if (finished && !handle.message.error) {
                // Surface content-filter finish (e.g. Anthropic refusal) as a visible error.
                // Previously the session went idle silently on filtered responses.
                if (handle.message.finish === "content-filter") {
                  handle.message.error = new MessageV2.ContentFilterError({
                    message: "The response was blocked by the provider's content filter",
                  }).toObject()
                  yield* sessions.updateMessage(handle.message)
                  yield* bus.publish(Session.Event.Error, { sessionID, error: handle.message.error })
                  return "break" as const
                }
                if (format.type === "json_schema") {
                  handle.message.error = new MessageV2.StructuredOutputError({
                    message: "Model did not produce structured output",
                    retries: 0,
                  }).toObject()
                  yield* sessions.updateMessage(handle.message)
                  return "break" as const
                }
              }

              if (result === "stop") return "break" as const
              if (result === "compact") {
                yield* compaction.create({
                  sessionID,
                  agent: lastUser.agent,
                  model: lastUser.model,
                  auto: true,
                  overflow: !handle.message.finish,
                })
              }
              return "continue" as const
            }).pipe(Effect.ensuring(instruction.clear(handle.message.id)))
            if (outcome === "break") {
              // Goal auto-continuation (Phase 3): if goal active + under budget, continue loop
              const loopCfg = yield* config.get()
              if (loopCfg.experimental?.goal_system !== false && lastUser) {
                const goal = Goal.get(sessionID)
                if (goal && GoalLoop.shouldContinue({ goal, step })) {
                  Goal.tick({ id: goal.id, tokens: lastFinished?.tokens?.input ?? 0, turns: 1 })
                  const updated = Goal.get(sessionID)
                  if (updated && updated.status === "active") {
                    yield* createUserMessage({
                      sessionID,
                      agent: lastUser.agent,
                      model: lastUser.model,
                      parts: [{ type: "text", text: GoalLoop.continuation(updated), synthetic: true }],
                    })
                    continue
                  }
                }
              }
              // Re-enter the loop so the top-of-loop condition re-reads msgs.
              // If a new user message arrived during this run, it will be detected
              // (lastUser.id > lastAssistant.id) and processed; otherwise the top
              // condition exits normally.
              continue
            }
            continue
          }

          yield* compaction.prune({ sessionID }).pipe(Effect.ignore, Effect.forkIn(scope))
          // [cache-debug] close handle so no further writes occur after runLoop exits
          _cacheDebugLog?.close()
          return yield* lastAssistant(sessionID)
        },
      )

      const loop: (input: z.infer<typeof LoopInput>) => Effect.Effect<MessageV2.WithParts> = Effect.fn(
        "SessionPrompt.loop",
      )(function* (input: z.infer<typeof LoopInput>) {
        return yield* state.ensureRunning(input.sessionID, lastAssistant(input.sessionID), runLoop(input.sessionID))
      })

      const shell: (input: ShellInput) => Effect.Effect<MessageV2.WithParts> = Effect.fn("SessionPrompt.shell")(
        function* (input: ShellInput) {
          return yield* state.startShell(input.sessionID, lastAssistant(input.sessionID), shellImpl(input))
        },
      )

      const command = Effect.fn("SessionPrompt.command")(function* (input: CommandInput) {
        log.info("command", input)
        const cmd = yield* commands.get(input.command)
        if (!cmd) {
          const available = (yield* commands.list()).map((c) => c.name)
          const hint = available.length ? ` Available commands: ${available.join(", ")}` : ""
          const error = new NamedError.Unknown({ message: `Command not found: "${input.command}".${hint}` })
          yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
          throw error
        }
        const agentName = cmd.agent ?? input.agent ?? (yield* agents.defaultAgent())

        const raw = input.arguments.match(argsRegex) ?? []
        const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))
        const templateCommand = yield* Effect.promise(async () => cmd.template)

        const placeholders = templateCommand.match(placeholderRegex) ?? []
        let last = 0
        for (const item of placeholders) {
          const value = Number(item.slice(1))
          if (value > last) last = value
        }

        const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
          const position = Number(index)
          const argIndex = position - 1
          if (argIndex >= args.length) return ""
          if (position === last) return args.slice(argIndex).join(" ")
          return args[argIndex]
        })
        const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
        let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

        if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
          template = template + "\n\n" + input.arguments
        }

        const shellMatches = ConfigMarkdown.shell(template)
        if (shellMatches.length > 0) {
          const sh = Shell.preferred()
          const results = yield* Effect.promise(() =>
            Promise.all(
              shellMatches.map(async ([, cmd]) => (await Process.text([cmd], { shell: sh, nothrow: true })).text),
            ),
          )
          let index = 0
          template = template.replace(bashRegex, () => results[index++])
        }
        template = template.trim()

        const taskModel = yield* Effect.gen(function* () {
          if (cmd.model) return Provider.parseModel(cmd.model)
          if (cmd.agent) {
            const cmdAgent = yield* agents.get(cmd.agent)
            if (cmdAgent?.model) return cmdAgent.model
          }
          if (input.model) return Provider.parseModel(input.model)
          return yield* lastModel(input.sessionID)
        })

        yield* getModel(taskModel.providerID, taskModel.modelID, input.sessionID)

        const agent = yield* agents.get(agentName)
        if (!agent) {
          const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
          const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
          const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
          yield* bus.publish(Session.Event.Error, { sessionID: input.sessionID, error: error.toObject() })
          throw error
        }

        const templateParts = yield* resolvePromptParts(template)
        // Deduplicate file parts already present in user input to avoid sending content twice
        const inputFiles = new Set(
          input.parts
            ?.filter((p) => p.type === "file" && new URL(p.url).protocol === "file:")
            .map((p) => fileURLToPath(p.url)),
        )
        const uniqueTemplateParts = templateParts.filter(
          (p) => p.type !== "file" || !inputFiles.has(fileURLToPath(p.url)),
        )
        const isSubtask = (agent.mode === "subagent" && cmd.subtask !== false) || cmd.subtask === true
        const parts = isSubtask
          ? [
              {
                type: "subtask" as const,
                agent: agent.name,
                description: cmd.description ?? "",
                command: input.command,
                model: { providerID: taskModel.providerID, modelID: taskModel.modelID },
                prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
              },
            ]
          : [...uniqueTemplateParts, ...(input.parts ?? [])]

        const userAgent = isSubtask ? (input.agent ?? (yield* agents.defaultAgent())) : agentName
        const userModel = isSubtask
          ? input.model
            ? Provider.parseModel(input.model)
            : yield* lastModel(input.sessionID)
          : taskModel

        yield* plugin.trigger(
          "command.execute.before",
          { command: input.command, sessionID: input.sessionID, arguments: input.arguments },
          { parts },
        )

        const result = yield* prompt({
          sessionID: input.sessionID,
          messageID: input.messageID,
          model: userModel,
          agent: userAgent,
          parts,
          variant: input.variant,
        })
        yield* bus.publish(Command.Event.Executed, {
          name: input.command,
          sessionID: input.sessionID,
          arguments: input.arguments,
          messageID: result.info.id,
        })
        return result
      })

      return Service.of({
        cancel,
        background,
        prompt,
        complete,
        loop,
        shell,
        command,
        resolvePromptParts,
      })
    }),
  )

  const defaultLayer = Layer.suspend(() =>
    layer.pipe(
      Layer.provide(SessionRunState.defaultLayer),
      Layer.provide(SessionStatus.defaultLayer),
      Layer.provide(SessionCompaction.defaultLayer),
      Layer.provide(SessionProcessor.defaultLayer),
      Layer.provide(Command.defaultLayer),
      Layer.provide(Permission.defaultLayer),
      Layer.provide(MCP.defaultLayer),
      Layer.provide(LSP.defaultLayer),
      Layer.provide(FileTime.defaultLayer),
      Layer.provide(ToolRegistry.defaultLayer),
      Layer.provide(Truncate.defaultLayer),
      Layer.provide(Provider.defaultLayer),
      Layer.provide(Instruction.defaultLayer),
      Layer.provide(AppFileSystem.defaultLayer),
      Layer.provide(Plugin.defaultLayer),
      Layer.provide(Session.defaultLayer),
      Layer.provide(SessionRevert.defaultLayer),
      Layer.provide(Agent.defaultLayer),
      Layer.provide(Bus.layer),
      // mergeAll to stay within Effect pipe's 20-argument limit
      Layer.provide(Layer.mergeAll(CrossSpawnSpawner.defaultLayer, Config.defaultLayer)),
    ),
  )
  const { runPromise } = makeRuntime(Service, defaultLayer)

  export const PromptInput = z.object({
    sessionID: SessionID.zod,
    messageID: MessageID.zod.optional(),
    model: z
      .object({
        providerID: ProviderID.zod,
        modelID: ModelID.zod,
      })
      .optional(),
    agent: z.string().optional(),
    noReply: z.boolean().optional(),
    tools: z
      .record(z.string(), z.boolean())
      .optional()
      .describe(
        "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
      ),
    format: MessageV2.Format.optional(),
    system: z.string().optional(),
    variant: z.string().optional(),
    parts: z.array(
      z.discriminatedUnion("type", [
        MessageV2.TextPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "TextPartInput",
          }),
        MessageV2.FilePart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "FilePartInput",
          }),
        MessageV2.AgentPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "AgentPartInput",
          }),
        MessageV2.SubtaskPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "SubtaskPartInput",
          }),
      ]),
    ),
  })
  export type PromptInput = z.infer<typeof PromptInput>

  export const CompleteInput = z.object({
    sessionID: SessionID.zod,
    model: z
      .object({
        providerID: ProviderID.zod,
        modelID: ModelID.zod,
      })
      .optional(),
    small: z.boolean().optional(),
    parts: PromptInput.shape.parts,
  })
  export type CompleteInput = z.infer<typeof CompleteInput>

  export async function prompt(input: PromptInput) {
    return runPromise((svc) => svc.prompt(PromptInput.parse(input)))
  }

  export async function complete(input: CompleteInput) {
    return runPromise((svc) => svc.complete(CompleteInput.parse(input)))
  }

  export async function resolvePromptParts(template: string) {
    return runPromise((svc) => svc.resolvePromptParts(z.string().parse(template)))
  }

  export async function cancel(sessionID: SessionID) {
    return runPromise((svc) => svc.cancel(SessionID.zod.parse(sessionID)))
  }

  // fork: background-detach (#FORK) — begin
  export async function background(sessionID: SessionID) {
    return runPromise((svc) => svc.background(SessionID.zod.parse(sessionID)))
  }
  // fork: background-detach (#FORK) — end

  export const LoopInput = z.object({
    sessionID: SessionID.zod,
  })

  export async function loop(input: z.infer<typeof LoopInput>) {
    return runPromise((svc) => svc.loop(LoopInput.parse(input)))
  }

  export const ShellInput = z.object({
    sessionID: SessionID.zod,
    messageID: MessageID.zod.optional(),
    agent: z.string(),
    model: z
      .object({
        providerID: ProviderID.zod,
        modelID: ModelID.zod,
      })
      .optional(),
    command: z.string(),
  })
  export type ShellInput = z.infer<typeof ShellInput>

  export async function shell(input: ShellInput) {
    return runPromise((svc) => svc.shell(ShellInput.parse(input)))
  }

  export const CommandInput = z.object({
    messageID: MessageID.zod.optional(),
    sessionID: SessionID.zod,
    agent: z.string().optional(),
    model: z.string().optional(),
    arguments: z.string(),
    command: z.string(),
    variant: z.string().optional(),
    parts: z
      .array(
        z.discriminatedUnion("type", [
          MessageV2.FilePart.omit({
            messageID: true,
            sessionID: true,
          }).partial({
            id: true,
          }),
        ]),
      )
      .optional(),
  })
  export type CommandInput = z.infer<typeof CommandInput>

  export async function command(input: CommandInput) {
    return runPromise((svc) => svc.command(CommandInput.parse(input)))
  }

  /** @internal Exported for testing */
  export function createStructuredOutputTool(input: {
    schema: Record<string, any>
    onSuccess: (output: unknown) => void
  }): AITool {
    // Remove $schema property if present (not needed for tool input)
    const { $schema, ...toolSchema } = input.schema

    return tool({
      id: "StructuredOutput" as any,
      description: STRUCTURED_OUTPUT_DESCRIPTION,
      inputSchema: jsonSchema(toolSchema as any),
      async execute(args) {
        // AI SDK validates args against inputSchema before calling execute()
        input.onSuccess(args)
        return {
          output: "Structured output captured successfully.",
          title: "Structured Output",
          metadata: { valid: true },
        }
      },
      toModelOutput({ output }) {
        return {
          type: "text",
          value: output.output,
        }
      },
    })
  }
  const bashRegex = /!`([^`]+)`/g
  // Match [Image N] as single token, quoted strings, or non-space sequences
  const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
  const placeholderRegex = /\$(\d+)/g
  const quoteTrimRegex = /^["']|["']$/g
}
