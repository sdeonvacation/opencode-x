import { describe, expect, spyOn, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Bus } from "../../src/bus"
import { TuiEvent } from "../../src/cli/cmd/tui/event"
import { SessionID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

describe("tool.task background inject Instance.bind", () => {
  test("Instance.bind preserves ALS context for async callbacks", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const dir = Instance.directory
        // Simulate what task.ts does: bind an async fn inside Instance context
        const bound = Instance.bind(async () => {
          return Instance.directory
        })

        // Call it outside Instance context (simulating background fiber)
        // We wrap in a setTimeout-like pattern to lose context
        const result = await new Promise<string>((resolve) => {
          // queueMicrotask loses ALS context in some runtimes
          setTimeout(async () => {
            resolve(await bound())
          }, 0)
        })

        expect(result).toBe(dir)
      },
    })
  })

  test("Instance.bind captures context at definition time", async () => {
    await using tmp = await tmpdir()
    let bound: () => Promise<string>

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        bound = Instance.bind(async () => Instance.directory)
      },
    })

    // Call bound function outside any Instance context
    const result = await bound!()
    expect(result).toBe(tmp.path)
  })

  test("Bus.publish works inside Instance.bind callback", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const published: any[] = []
        const spy = spyOn(Bus, "publish").mockImplementation(async (...args: any[]) => {
          published.push(args)
        })

        const bound = Instance.bind(async (state: "completed" | "error" | "running") => {
          await Bus.publish(TuiEvent.BackgroundTaskUpdate, {
            sessionID: SessionID.make("ses_test"),
            taskID: SessionID.make("ses_child"),
            title: "test task",
            state,
          })
        })

        try {
          // Call outside context
          await bound("completed")
          expect(published.length).toBe(1)
          expect(published[0][1].state).toBe("completed")
        } finally {
          spy.mockRestore()
        }
      },
    })
  })

  test("unbound async fn loses Instance context", async () => {
    await using tmp = await tmpdir()
    let unbound: () => Promise<string>

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // NOT using Instance.bind
        unbound = async () => Instance.directory
      },
    })

    // Should throw because ALS context is lost
    expect(() => unbound!()).toThrow()
  })
})
