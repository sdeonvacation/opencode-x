import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { TaskStatusTool } from "../../src/tool/task_status"
import { BackgroundJob } from "../../src/background/job"
import { SessionStatus } from "../../src/session/status"
import { Session } from "../../src/session"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Config } from "../../src/config/config"
import { Flag } from "../../src/flag/flag"
import { testEffect } from "../lib/effect"
import { provideTmpdirInstance } from "../fixture/fixture"

const original = Flag.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS
beforeAll(() => {
  ;(Flag as any).OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = true
})
afterAll(() => {
  ;(Flag as any).OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = original
})

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const it = testEffect(
  Layer.mergeAll(BackgroundJob.defaultLayer, SessionStatus.defaultLayer, Session.defaultLayer, Config.defaultLayer),
)

function makeCtx(sessionID?: string) {
  return {
    sessionID: SessionID.make(sessionID ?? "ses_test"),
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
    ask: async () => {},
  } as any
}

describe("tool.task_status", () => {
  describe("initialization", () => {
    it.live("initializes via Effect with required services", () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const info = yield* TaskStatusTool
          const tool = await info.init()
          expect(tool.description).toContain("background subagent")
          expect(tool.parameters).toBeDefined()
        }),
      ),
    )
  })

  describe("execute", () => {
    it.live("returns error when session not found", () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const info = yield* TaskStatusTool
          const tool = await info.init()
          const result = await tool.execute({ task_id: "ses_nonexistent" }, makeCtx())
          expect(result.output).toContain("state: error")
          expect(result.output).toContain("Task not found")
          expect(result.metadata.state).toBe("error")
          expect(result.metadata.timed_out).toBe(false)
        }),
      ),
    )

    it.live("returns completed state for finished task", () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const chat = yield* session.create({ title: "bg-task" })

          const user = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: chat.id,
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })

          yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "assistant",
            parentID: user.id,
            sessionID: chat.id,
            mode: "build",
            agent: "build",
            cost: 0,
            path: { cwd: "/tmp", root: "/tmp" },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ref.modelID,
            providerID: ref.providerID,
            time: { created: Date.now(), completed: Date.now() },
            finish: "stop",
          })

          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: MessageID.ascending(),
            sessionID: chat.id,
            type: "text",
            text: "Task completed successfully",
          })

          const info = yield* TaskStatusTool
          const tool = await info.init()
          const result = await tool.execute({ task_id: chat.id }, makeCtx())

          expect(result.output).toContain("state:")
          expect(result.output).toContain("task_id:")
          expect(result.metadata.task_id).toBe(chat.id)
        }),
      ),
    )

    it.live("returns running state for active background job", () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const chat = yield* session.create({ title: "running-task" })

          yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: chat.id,
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })

          const jobs = yield* BackgroundJob.Service
          yield* jobs.start({
            id: chat.id,
            type: "task",
            title: "test task",
            run: Effect.never,
          })

          const info = yield* TaskStatusTool
          const tool = await info.init()
          const result = await tool.execute({ task_id: chat.id }, makeCtx())

          expect(result.output).toContain("state: running")
          expect(result.output).toContain("<task_result>")
          expect(result.metadata.state).toBe("running")
        }),
      ),
    )

    it.live("returns completed state for finished background job", () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const chat = yield* session.create({ title: "done-task" })

          yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: chat.id,
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })

          const jobs = yield* BackgroundJob.Service
          yield* jobs.start({
            id: chat.id,
            type: "task",
            title: "test task",
            run: Effect.succeed("Final answer from subagent"),
          })

          // Wait briefly for the job to complete
          yield* Effect.sleep("50 millis")

          const info = yield* TaskStatusTool
          const tool = await info.init()
          const result = await tool.execute({ task_id: chat.id }, makeCtx())

          expect(result.output).toContain("state: completed")
          expect(result.output).toContain("Final answer from subagent")
          expect(result.output).toContain("<task_result>")
          expect(result.metadata.state).toBe("completed")
        }),
      ),
    )

    it.live("returns error state for failed background job", () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const chat = yield* session.create({ title: "failed-task" })

          yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: chat.id,
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })

          const jobs = yield* BackgroundJob.Service
          yield* jobs.start({
            id: chat.id,
            type: "task",
            title: "test task",
            run: Effect.fail(new Error("Something went wrong")),
          })

          yield* Effect.sleep("50 millis")

          const info = yield* TaskStatusTool
          const tool = await info.init()
          const result = await tool.execute({ task_id: chat.id }, makeCtx())

          expect(result.output).toContain("state: error")
          expect(result.output).toContain("<task_error>")
          expect(result.output).toContain("Something went wrong")
          expect(result.metadata.state).toBe("error")
        }),
      ),
    )

    it.live("wait=true with timeout returns timed_out for running job", () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const chat = yield* session.create({ title: "slow-task" })

          yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: chat.id,
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })

          const jobs = yield* BackgroundJob.Service
          yield* jobs.start({
            id: chat.id,
            type: "task",
            title: "slow task",
            run: Effect.never,
          })

          const info = yield* TaskStatusTool
          const tool = await info.init()
          const result = await tool.execute({ task_id: chat.id, wait: true, timeout_ms: 100 }, makeCtx())

          expect(result.output).toContain("Timed out")
          expect(result.metadata.timed_out).toBe(true)
        }),
      ),
    )

    it.live("wait=true resolves immediately for completed job", () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const chat = yield* session.create({ title: "instant-task" })

          yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: chat.id,
            agent: "build",
            model: ref,
            time: { created: Date.now() },
          })

          const jobs = yield* BackgroundJob.Service
          yield* jobs.start({
            id: chat.id,
            type: "task",
            title: "instant task",
            run: Effect.succeed("Done instantly"),
          })

          yield* Effect.sleep("50 millis")

          const info = yield* TaskStatusTool
          const tool = await info.init()
          const result = await tool.execute({ task_id: chat.id, wait: true, timeout_ms: 5000 }, makeCtx())

          expect(result.output).toContain("state: completed")
          expect(result.output).toContain("Done instantly")
          expect(result.metadata.timed_out).toBe(false)
        }),
      ),
    )
  })

  describe("flag disabled", () => {
    it.live("throws when OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS is false", () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const prev = Flag.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS
          ;(Flag as any).OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = false
          try {
            const info = yield* TaskStatusTool
            const tool = await info.init()
            await expect(tool.execute({ task_id: "ses_test" }, makeCtx())).rejects.toThrow(
              "task_status requires OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true",
            )
          } finally {
            ;(Flag as any).OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = prev
          }
        }),
      ),
    )
  })

  describe("output format", () => {
    it.live("output contains task_id, state, and tagged content", () =>
      provideTmpdirInstance(() =>
        Effect.gen(function* () {
          const info = yield* TaskStatusTool
          const tool = await info.init()
          const result = await tool.execute({ task_id: "ses_missing" }, makeCtx())

          const lines = result.output.split("\n")
          expect(lines[0]).toMatch(/^task_id: /)
          expect(lines[1]).toMatch(/^state: /)
          expect(result.output).toMatch(/<task_error>/)
          expect(result.output).toMatch(/<\/task_error>/)
        }),
      ),
    )
  })
})
