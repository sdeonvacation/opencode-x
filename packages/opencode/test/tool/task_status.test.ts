import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { MessageID, SessionID } from "../../src/session/schema"
import { Flag } from "../../src/flag/flag"
import { TaskStatusTool } from "../../src/tool/task_status"
import { BackgroundJob } from "../../src/background/job"
import { makeRuntime } from "../../src/effect/run-service"
import { Effect } from "effect"
import { tmpdir } from "../fixture/fixture"

const bgRuntime = makeRuntime(BackgroundJob.Service, BackgroundJob.defaultLayer)
const originalFlag = Flag.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS

afterEach(() => {
  // @ts-expect-error override readonly flag for testing
  Flag.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = originalFlag
})

describe("tool.task_status", () => {
  test("returns completed background job output", async () => {
    // @ts-expect-error override readonly flag for testing
    Flag.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = true

    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await TaskStatusTool.init()
        const taskID = SessionID.make("test-task-1")

        await bgRuntime.runPromise((svc) => svc.start({ id: taskID, type: "task", run: Effect.succeed("all done") }))

        // Wait briefly for job to settle
        await new Promise((r) => setTimeout(r, 50))

        const result = await tool.execute(
          { task_id: taskID, wait: true, timeout_ms: 1_000 },
          {
            sessionID: SessionID.make("parent"),
            messageID: MessageID.ascending(),
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
            metadata: () => {},
            ask: async () => {},
          },
        )

        expect(result.output).toContain("state: completed")
        expect(result.output).toContain("all done")
        expect(result.metadata.timed_out).toBe(false)
      },
    })
  })

  test("wait=true times out while the background job is running", async () => {
    // @ts-expect-error override readonly flag for testing
    Flag.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = true

    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await TaskStatusTool.init()
        const taskID = SessionID.make("test-task-2")

        await bgRuntime.runPromise((svc) => svc.start({ id: taskID, type: "task", run: Effect.never }))

        const result = await tool.execute(
          { task_id: taskID, wait: true, timeout_ms: 50 },
          {
            sessionID: SessionID.make("parent"),
            messageID: MessageID.ascending(),
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
            metadata: () => {},
            ask: async () => {},
          },
        )

        expect(result.output).toContain("state: running")
        expect(result.output).toContain("Timed out after 50ms")
        expect(result.metadata.timed_out).toBe(true)
      },
    })
  })
})
