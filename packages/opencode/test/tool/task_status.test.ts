import { afterEach, beforeAll, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Session } from "@/session"
import { MessageID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { TaskStatusTool } from "@/tool/task_status"
import { Truncate } from "@/tool/truncate"
import { Instance } from "../../src/project/instance"
import { testEffect } from "../lib/effect"
import { provideTmpdirInstance } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

beforeAll(() => {
  process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = "true"
})

const layer = Layer.mergeAll(
  Agent.defaultLayer,
  BackgroundJob.defaultLayer,
  Bus.layer,
  CrossSpawnSpawner.defaultLayer,
  Session.defaultLayer,
  SessionStatus.defaultLayer,
  Truncate.defaultLayer,
)

const it = testEffect(layer)

describe("tool.task_status", () => {
  it.live("returns completed background job output", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const sessions = yield* Session.Service
        const tool = yield* TaskStatusTool
        const def = yield* Effect.promise(() => tool.init())
        const chat = yield* sessions.create({})

        yield* jobs.start({ id: chat.id, type: "task", run: Effect.succeed("all done") })

        const result = yield* Effect.promise(() =>
          def.execute(
            { task_id: chat.id, wait: true, timeout_ms: 1_000 },
            {
              sessionID: chat.id,
              messageID: MessageID.ascending(),
              agent: "build",
              abort: new AbortController().signal,
              messages: [],
              metadata: () => {},
              ask: async () => {},
            },
          ),
        )

        expect(result.output).toContain("state: completed")
        expect(result.output).toContain("all done")
        expect(result.metadata.timed_out).toBe(false)
      }),
    ),
  )

  it.live("wait=true times out while the background job is running", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        const sessions = yield* Session.Service
        const tool = yield* TaskStatusTool
        const def = yield* Effect.promise(() => tool.init())
        const chat = yield* sessions.create({})

        yield* jobs.start({ id: chat.id, type: "task", run: Effect.never })

        const result = yield* Effect.promise(() =>
          def.execute(
            { task_id: chat.id, wait: true, timeout_ms: 50 },
            {
              sessionID: chat.id,
              messageID: MessageID.ascending(),
              agent: "build",
              abort: new AbortController().signal,
              messages: [],
              metadata: () => {},
              ask: async () => {},
            },
          ),
        )

        expect(result.output).toContain("state: running")
        expect(result.output).toContain("Timed out after 50ms")
        expect(result.metadata.timed_out).toBe(true)
      }),
    ),
  )
})
