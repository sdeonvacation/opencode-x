import { afterEach, describe, expect, test } from "bun:test"
import z from "zod"
import { Bus } from "../../src/bus"
import { BusEvent } from "../../src/bus/bus-event"
import { OrchestrationEvent } from "../../src/orchestration/events"
import { BranchPREvent } from "../../src/orchestration/branch-pr-events"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

function withInstance(directory: string, fn: () => Promise<void>) {
  return Instance.provide({ directory, fn })
}

describe("branch-pr-handler push-to-background subscriber", () => {
  afterEach(() => Instance.disposeAll())

  test("subscriber filters by sessionID", async () => {
    await using tmp = await tmpdir()
    const received: string[] = []

    await withInstance(tmp.path, async () => {
      const target = "session-aaa"
      const unsub = Bus.subscribe(OrchestrationEvent.Complete, async (event) => {
        if (event.properties.sessionID !== target) return
        received.push(event.properties.sessionID)
      })
      await Bun.sleep(10)

      // Publish for wrong session — should be ignored
      await Bus.publish(OrchestrationEvent.Complete, {
        sessionID: "session-bbb",
        parentSessionID: "parent-1",
        agent: "coder",
        durationMs: 100,
      })
      await Bun.sleep(10)
      expect(received).toEqual([])

      // Publish for correct session — should match
      await Bus.publish(OrchestrationEvent.Complete, {
        sessionID: target,
        parentSessionID: "parent-1",
        agent: "coder",
        durationMs: 200,
      })
      await Bun.sleep(10)
      expect(received).toEqual([target])

      unsub()
    })
  })

  test("handled flag prevents double-fire", async () => {
    await using tmp = await tmpdir()
    const calls: number[] = []
    let count = 0

    await withInstance(tmp.path, async () => {
      const target = "session-double"
      let handled = false

      const unsub = Bus.subscribe(OrchestrationEvent.Complete, async (event) => {
        if (event.properties.sessionID !== target) return
        if (handled) return
        handled = true
        calls.push(++count)
      })
      await Bun.sleep(10)

      // Fire twice rapidly
      await Bus.publish(OrchestrationEvent.Complete, {
        sessionID: target,
        parentSessionID: "parent-1",
        agent: "coder",
        durationMs: 100,
      })
      await Bus.publish(OrchestrationEvent.Complete, {
        sessionID: target,
        parentSessionID: "parent-1",
        agent: "coder",
        durationMs: 200,
      })
      await Bun.sleep(30)

      // Only first should have fired
      expect(calls).toEqual([1])

      unsub()
    })
  })

  test("unsub prevents subscriber from firing", async () => {
    await using tmp = await tmpdir()
    const received: string[] = []

    await withInstance(tmp.path, async () => {
      const target = "session-unsub"

      const unsub = Bus.subscribe(OrchestrationEvent.Complete, async (event) => {
        if (event.properties.sessionID !== target) return
        received.push(event.properties.sessionID)
      })
      await Bun.sleep(10)

      // Unsubscribe before any event (simulates normal completion path)
      unsub()
      await Bun.sleep(10)

      // Publish after unsub — subscriber should not fire
      await Bus.publish(OrchestrationEvent.Complete, {
        sessionID: target,
        parentSessionID: "parent-1",
        agent: "coder",
        durationMs: 100,
      })
      await Bun.sleep(10)

      expect(received).toEqual([])
    })
  })

  test("normal completion sets handled before unsub (race guard)", async () => {
    await using tmp = await tmpdir()
    const fired: string[] = []

    await withInstance(tmp.path, async () => {
      const target = "session-race"
      let handled = false

      const unsub = Bus.subscribe(OrchestrationEvent.Complete, async (event) => {
        if (event.properties.sessionID !== target) return
        if (handled) return
        handled = true
        fired.push("subscriber")
      })
      await Bun.sleep(10)

      // Simulate normal completion: set handled + unsub before publish
      handled = true
      unsub()

      await Bus.publish(OrchestrationEvent.Complete, {
        sessionID: target,
        parentSessionID: "parent-1",
        agent: "coder",
        durationMs: 100,
      })
      await Bun.sleep(10)

      // Subscriber should not have fired
      expect(fired).toEqual([])
    })
  })

  test("BranchPREvent.Ready schema accepts expected payload", async () => {
    await using tmp = await tmpdir()
    const received: Array<{ id: string; branch: string }> = []

    await withInstance(tmp.path, async () => {
      const unsub = Bus.subscribe(BranchPREvent.Ready, async (event) => {
        received.push({ id: event.properties.id, branch: event.properties.branch })
      })
      await Bun.sleep(10)

      await Bus.publish(BranchPREvent.Ready, {
        id: "pr-123",
        sessionID: "sess-1",
        parentSessionID: "parent-1",
        branch: "opencode/abc/test",
        filesChanged: 3,
        insertions: 42,
        deletions: 7,
      })
      await Bun.sleep(10)

      expect(received).toEqual([{ id: "pr-123", branch: "opencode/abc/test" }])

      unsub()
    })
  })
})
