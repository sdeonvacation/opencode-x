import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { AppFileSystem } from "../../src/filesystem"
import { FileTime } from "../../src/file/time"
import { LSP } from "../../src/lsp"
import { MessageID, SessionID } from "../../src/session/schema"
import { Instruction } from "../../src/session/instruction"
import { ReadTool } from "../../src/tool/read"
import { Tool } from "../../src/tool/tool"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const ctx = {
  sessionID: SessionID.make("ses_parallel_read"),
  messageID: MessageID.make("msg_parallel_read"),
  callID: "call_parallel_read",
  agent: "explore",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    AppFileSystem.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    FileTime.defaultLayer,
    Instruction.defaultLayer,
    Layer.succeed(
      LSP.Service,
      LSP.Service.of({
        init: () => Effect.void,
        status: () => Effect.succeed([]),
        hasClients: () => Effect.succeed(false),
        touchFile: () => Effect.void,
        diagnostics: () => Effect.succeed({}),
        hover: () => Effect.succeed(undefined),
        definition: () => Effect.succeed([]),
        references: () => Effect.succeed([]),
        implementation: () => Effect.succeed([]),
        documentSymbol: () => Effect.succeed([]),
        workspaceSymbol: () => Effect.succeed([]),
        prepareCallHierarchy: () => Effect.succeed([]),
        incomingCalls: () => Effect.succeed([]),
        outgoingCalls: () => Effect.succeed([]),
      }),
    ),
  ),
)

const init = Effect.fn("ParallelReadTest.init")(function* () {
  const info = yield* ReadTool
  return yield* Effect.promise(() => info.init())
})

const exec = Effect.fn("ParallelReadTest.exec")(function* (
  dir: string,
  args: Tool.InferParameters<typeof ReadTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* provideInstance(dir)(Effect.promise(() => tool.execute(args, next)))
})

describe("tool.read parallel behavior", () => {
  it.live("supports concurrent reads without corrupting file time state", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const fs = yield* AppFileSystem.Service
      yield* fs.writeWithDirs(path.join(dir, "a.txt"), "alpha\n")
      yield* fs.writeWithDirs(path.join(dir, "b.txt"), "beta\n")
      yield* fs.writeWithDirs(path.join(dir, "c.txt"), "gamma\n")

      const [a, b, c] = yield* Effect.all(
        [
          exec(dir, { filePath: path.join(dir, "a.txt") }),
          exec(dir, { filePath: path.join(dir, "b.txt") }),
          exec(dir, { filePath: path.join(dir, "c.txt") }),
        ],
        { concurrency: "inherit" },
      )

      expect(a.output).toContain("alpha")
      expect(b.output).toContain("beta")
      expect(c.output).toContain("gamma")

      const stamps = yield* provideInstance(dir)(
        Effect.gen(function* () {
          const time = yield* FileTime.Service
          return yield* Effect.all([
            time.get(ctx.sessionID, path.join(dir, "a.txt")),
            time.get(ctx.sessionID, path.join(dir, "b.txt")),
            time.get(ctx.sessionID, path.join(dir, "c.txt")),
          ])
        }),
      )
      expect(stamps[0]).toBeDefined()
      expect(stamps[1]).toBeDefined()
      expect(stamps[2]).toBeDefined()
    }),
  )

  it.live("supports concurrent reads of the same file", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const fs = yield* AppFileSystem.Service
      yield* fs.writeWithDirs(path.join(dir, "same.txt"), "same\n")

      const [first, second, third] = yield* Effect.all(
        [
          exec(dir, { filePath: path.join(dir, "same.txt") }),
          exec(dir, { filePath: path.join(dir, "same.txt") }),
          exec(dir, { filePath: path.join(dir, "same.txt") }),
        ],
        { concurrency: "inherit" },
      )

      expect(first.output).toContain("same")
      expect(second.output).toContain("same")
      expect(third.output).toContain("same")

      const stamp = yield* provideInstance(dir)(
        Effect.gen(function* () {
          const time = yield* FileTime.Service
          return yield* time.get(ctx.sessionID, path.join(dir, "same.txt"))
        }),
      )
      expect(stamp).toBeDefined()
    }),
  )
})
