import z from "zod"
import fs from "fs/promises"
import { Deferred, Effect, Layer, ServiceMap } from "effect"
import { makeRuntime } from "@/effect/run-service"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"

import { Log } from "@/util/log"
import { Session } from "@/session"
import { MessageV2 } from "./message-v2"
import { type SessionID, type MessageID, MessageID as MessageIDUtil, PartID as PartIDUtil } from "./schema"
import { SessionID as SessionIDSchema } from "./schema"
import { computeBoundary, COMPACTABLE_TOOL_NAMES } from "./checkpoint-boundary"
import { checkpointPath, memoryPath, notesPath, globalMemoryPath, metaDir, tasksDir } from "./checkpoint-paths"
import { readBudgeted, readBudgetedSectionAware, readDirBudgeted } from "./budgeted-read"
import { composeWriterPrompt } from "./checkpoint-writer-prompt"
import { CHECKPOINT_TEMPLATE, CHECKPOINT_SECTION_BUDGETS } from "./checkpoint-templates"
import { SessionPrompt } from "./prompt"
import { spawnSubagent } from "@/orchestration/task-spawn"
import { Agent } from "@/agent/agent"

export namespace Checkpoint {
  const log = Log.create({ service: "checkpoint" })

  export const WriterSettled = BusEvent.define(
    "checkpoint.writer.settled",
    z.object({
      sessionID: SessionIDSchema.zod,
    }),
  )

  type WriterState = {
    deferred: Deferred.Deferred<boolean>
    boundary: MessageID
  }

  const writers = new Map<string, WriterState>()

  const REBUILD_CHECKPOINT_BUDGET = 8000
  const REBUILD_MEMORY_BUDGET = 4000
  const REBUILD_NOTES_BUDGET = 2000
  const REBUILD_GLOBAL_MEMORY_BUDGET = 2000
  const DEFAULT_TIMEOUT = 300_000

  export interface Interface {
    readonly tryStartCheckpointWriter: (input: {
      sessionID: SessionID
      messages: MessageV2.WithParts[]
    }) => Effect.Effect<boolean>

    readonly waitForWriter: (input: { sessionID: SessionID; timeout?: number }) => Effect.Effect<boolean>

    readonly drainWriters: () => Effect.Effect<void>

    readonly hasCheckpoint: (input: { sessionID: SessionID }) => Effect.Effect<boolean>

    readonly hasMemoryOrTasks: (input: { sessionID: SessionID }) => Effect.Effect<boolean>

    readonly loadLatest: (input: {
      sessionID: SessionID
    }) => Effect.Effect<{ checkpoint?: string; memory?: string; notes?: string }>

    readonly renderRebuildContext: (input: {
      sessionID: SessionID
      tail: MessageV2.WithParts[]
    }) => Effect.Effect<string>

    readonly insertRebuildBoundary: (input: {
      sessionID: SessionID
      context: string
      messages: MessageV2.WithParts[]
    }) => Effect.Effect<void>

    readonly isWriterRunning: (input: { sessionID: SessionID }) => Effect.Effect<boolean>

    readonly lastBoundary: (input: { sessionID: SessionID }) => Effect.Effect<MessageID | undefined>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Checkpoint") {}

  export const layer: Layer.Layer<Service, never, Bus.Service | Session.Service> = Layer.effect(
    Service,
    Effect.gen(function* () {
      yield* Bus.Service
      const session = yield* Session.Service

      const tryStartCheckpointWriter = Effect.fn("Checkpoint.tryStartCheckpointWriter")(function* (input: {
        sessionID: SessionID
        messages: MessageV2.WithParts[]
      }) {
        log.info("trigger", { session: input.sessionID, messages: input.messages.length })
        if (writers.has(input.sessionID)) {
          log.info("skipped: writer already running", { session: input.sessionID })
          return false
        }
        const boundary = computeBoundary(input.messages)
        if (!boundary) {
          log.info("skipped: no valid boundary", { session: input.sessionID, messages: input.messages.length })
          return false
        }
        log.info("boundary found", {
          session: input.sessionID,
          index: boundary.index,
          head: boundary.head.length,
          tail: boundary.tail.length,
        })

        const deferred = yield* Deferred.make<boolean>()
        writers.set(input.sessionID, { deferred, boundary: boundary.id })

        // Compose writer prompt with conversation context
        const paths = {
          checkpoint: checkpointPath(input.sessionID),
          memory: memoryPath(input.sessionID),
          notes: notesPath(input.sessionID),
        }
        const prompt = composeWriterPrompt({
          session: input.sessionID,
          paths,
          template: CHECKPOINT_TEMPLATE,
          budgets: CHECKPOINT_SECTION_BUDGETS,
        })

        // Serialize conversation head for writer context
        const head = boundary.head
          .map((m) => {
            const role = m.info.role
            const text = m.parts
              .filter((p): p is MessageV2.TextPart => p.type === "text")
              .map((p) => p.text)
              .join("\n")
            return `[${role}]: ${text.slice(0, 4000)}`
          })
          .join("\n\n")

        const writerMessage = [prompt, "", "## Conversation to Summarize", "", head].join("\n")

        // Spawn writer in background, then extract output and write files
        const dir = metaDir(input.sessionID)
        void (async () => {
          try {
            await fs.mkdir(dir, { recursive: true })
            const agent = await Agent.get("checkpoint-writer")
            const spawned = await spawnSubagent(undefined, {
              parentSessionID: input.sessionID,
              agent,
              description: "checkpoint writer",
              canTask: false,
              canTodo: false,
              taskPermissionID: "task",
              maxDepth: 1,
              maxDescendants: 1,
            })
            await SessionPrompt.prompt({
              sessionID: spawned.session.id,
              messageID: MessageIDUtil.ascending(),
              agent: "checkpoint-writer",
              parts: [{ type: "text", text: writerMessage }],
            })

            // Read writer output and write files programmatically
            const msgs = await Session.messages({ sessionID: spawned.session.id })
            const output = msgs
              .filter((m) => m.info.role === "assistant")
              .flatMap((m) => m.parts.filter((p): p is MessageV2.TextPart => p.type === "text"))
              .map((p) => p.text)
              .join("\n")

            const parsed = parseWriterOutput(output)
            const written = await writeCheckpointFiles(input.sessionID, parsed)
            log.info("files written", { session: input.sessionID, count: written })
            Effect.runFork(Deferred.succeed(deferred, written > 0))
          } catch (err) {
            log.error("writer failed", { session: input.sessionID, error: String(err) })
            Effect.runFork(Deferred.succeed(deferred, false))
          } finally {
            writers.delete(input.sessionID)
            void Bus.publish(WriterSettled, { sessionID: input.sessionID })
          }
        })()

        return true
      })

      const waitForWriter = Effect.fn("Checkpoint.waitForWriter")(function* (input: {
        sessionID: SessionID
        timeout?: number
      }) {
        const state = writers.get(input.sessionID)
        if (!state) return true
        const timeout = input.timeout ?? DEFAULT_TIMEOUT
        const result = yield* Deferred.await(state.deferred).pipe(Effect.timeoutOption(timeout))
        if (result._tag === "Some") return result.value
        return false
      })

      const drainWriters = Effect.fn("Checkpoint.drainWriters")(function* () {
        const pending = Array.from(writers.values())
        for (const state of pending) {
          yield* Deferred.await(state.deferred).pipe(Effect.timeoutOption(DEFAULT_TIMEOUT), Effect.ignore)
        }
        writers.clear()
      })

      const hasCheckpoint = Effect.fn("Checkpoint.hasCheckpoint")(function* (input: { sessionID: SessionID }) {
        const exists = yield* Effect.promise(() => Bun.file(checkpointPath(input.sessionID)).exists())
        return exists
      })

      const hasMemoryOrTasks = Effect.fn("Checkpoint.hasMemoryOrTasks")(function* (input: { sessionID: SessionID }) {
        const [mem, tasks] = yield* Effect.promise(() =>
          Promise.all([
            Bun.file(memoryPath(input.sessionID)).exists(),
            fs
              .stat(tasksDir(input.sessionID))
              .then(() => true)
              .catch(() => false),
          ]),
        )
        return mem || tasks
      })

      const loadLatest = Effect.fn("Checkpoint.loadLatest")(function* (input: { sessionID: SessionID }) {
        const [ckpt, mem, notes] = yield* Effect.promise(() =>
          Promise.all([
            readFile(checkpointPath(input.sessionID)),
            readFile(memoryPath(input.sessionID)),
            readFile(notesPath(input.sessionID)),
          ]),
        )
        return { checkpoint: ckpt, memory: mem, notes }
      })

      const renderRebuildContext = Effect.fn("Checkpoint.renderRebuildContext")(function* (input: {
        sessionID: SessionID
        tail: MessageV2.WithParts[]
      }) {
        const [ckpt, mem, notes, global] = yield* Effect.promise(() =>
          Promise.all([
            readBudgetedSectionAware(checkpointPath(input.sessionID), REBUILD_CHECKPOINT_BUDGET),
            readBudgeted(memoryPath(input.sessionID), REBUILD_MEMORY_BUDGET),
            readBudgeted(notesPath(input.sessionID), REBUILD_NOTES_BUDGET),
            readDirBudgeted(globalMemoryPath(), REBUILD_GLOBAL_MEMORY_BUDGET),
          ]),
        )

        const sections: string[] = []

        if (ckpt.content) {
          sections.push(`<checkpoint>\n${ckpt.content}${ckpt.truncated ? "\n[truncated]" : ""}\n</checkpoint>`)
        }
        if (mem.content) {
          sections.push(`<memory>\n${mem.content}${mem.truncated ? "\n[truncated]" : ""}\n</memory>`)
        }
        if (notes.content) {
          sections.push(`<notes>\n${notes.content}${notes.truncated ? "\n[truncated]" : ""}\n</notes>`)
        }
        if (global.content) {
          sections.push(
            `<global-memory>\n${global.content}${global.truncated ? "\n[truncated]" : ""}\n</global-memory>`,
          )
        }

        if (sections.length === 0) return ""
        return `<checkpoint-context>\n${sections.join("\n\n")}\n</checkpoint-context>`
      })

      const insertRebuildBoundary = Effect.fn("Checkpoint.insertRebuildBoundary")(function* (input: {
        sessionID: SessionID
        context: string
        messages: MessageV2.WithParts[]
      }) {
        if (!input.context) return

        // Microcompact: clear compactable tool results
        for (const msg of input.messages) {
          for (const part of msg.parts) {
            if (part.type !== "tool") continue
            if (!COMPACTABLE_TOOL_NAMES.has(part.tool)) continue
            if (part.state.status === "completed" && part.state.output !== "[compacted]") {
              const compacted = { ...part, state: { ...part.state, output: "[compacted]" } } as typeof part
              yield* session.updatePart(compacted)
            }
          }
        }

        // Insert synthetic user message with rebuild context
        const last = input.messages.findLast((m) => m.info.role === "user")
        if (!last || last.info.role !== "user") return
        const msg = yield* session.updateMessage({
          id: MessageIDUtil.ascending(),
          role: "user",
          sessionID: input.sessionID,
          agent: last.info.agent,
          model: last.info.model,
          time: { created: Date.now() },
        })
        yield* session.updatePart({
          id: PartIDUtil.ascending(),
          messageID: msg.id,
          sessionID: input.sessionID,
          type: "text",
          synthetic: true,
          text: input.context,
          time: { start: Date.now(), end: Date.now() },
        })
      })

      const isWriterRunning = Effect.fn("Checkpoint.isWriterRunning")(function* (input: { sessionID: SessionID }) {
        return writers.has(input.sessionID)
      })

      const lastBoundary = Effect.fn("Checkpoint.lastBoundary")(function* (input: { sessionID: SessionID }) {
        const state = writers.get(input.sessionID)
        if (state) return state.boundary
        return undefined
      })

      return Service.of({
        tryStartCheckpointWriter,
        waitForWriter,
        drainWriters,
        hasCheckpoint,
        hasMemoryOrTasks,
        loadLatest,
        renderRebuildContext,
        insertRebuildBoundary,
        isWriterRunning,
        lastBoundary,
      })
    }),
  )

  export const defaultLayer = Layer.suspend(() =>
    layer.pipe(Layer.provide(Bus.layer), Layer.provide(Session.defaultLayer)),
  )

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function hasCheckpoint(input: { sessionID: SessionID }) {
    return runPromise((svc) => svc.hasCheckpoint(input))
  }

  export async function hasMemoryOrTasks(input: { sessionID: SessionID }) {
    return runPromise((svc) => svc.hasMemoryOrTasks(input))
  }

  export async function loadLatest(input: { sessionID: SessionID }) {
    return runPromise((svc) => svc.loadLatest(input))
  }

  export async function tryStartCheckpointWriter(input: { sessionID: SessionID; messages: MessageV2.WithParts[] }) {
    return runPromise((svc) => svc.tryStartCheckpointWriter(input))
  }

  export async function waitForWriter(input: { sessionID: SessionID; timeout?: number }) {
    return runPromise((svc) => svc.waitForWriter(input))
  }

  export async function drainWriters() {
    return runPromise((svc) => svc.drainWriters())
  }

  export async function renderRebuildContext(input: { sessionID: SessionID; tail: MessageV2.WithParts[] }) {
    return runPromise((svc) => svc.renderRebuildContext(input))
  }

  export async function insertRebuildBoundary(input: {
    sessionID: SessionID
    context: string
    messages: MessageV2.WithParts[]
  }) {
    return runPromise((svc) => svc.insertRebuildBoundary(input))
  }

  export async function isWriterRunning(input: { sessionID: SessionID }) {
    return runPromise((svc) => svc.isWriterRunning(input))
  }
}

interface ParsedOutput {
  checkpoint?: string
  memory?: string
  notes?: string
}

function parseWriterOutput(output: string): ParsedOutput {
  const extract = (tag: string): string | undefined => {
    const re = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`)
    const match = output.match(re)
    return match?.[1]?.trim() || undefined
  }
  return {
    checkpoint: extract("checkpoint-file"),
    memory: extract("memory-file"),
    notes: extract("notes-file"),
  }
}

async function writeCheckpointFiles(session: SessionID, parsed: ParsedOutput): Promise<number> {
  let count = 0
  if (parsed.checkpoint) {
    await Bun.write(checkpointPath(session), parsed.checkpoint)
    count++
  }
  if (parsed.memory) {
    await Bun.write(memoryPath(session), parsed.memory)
    count++
  }
  if (parsed.notes) {
    await Bun.write(notesPath(session), parsed.notes)
    count++
  }
  return count
}

async function readFile(path: string): Promise<string | undefined> {
  const file = Bun.file(path)
  if (!(await file.exists())) return undefined
  return file.text()
}
