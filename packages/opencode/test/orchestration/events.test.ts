import { describe, expect, test } from "bun:test"
import { OrchestrationEvent } from "../../src/orchestration/events"

describe("orchestration/events", () => {
  test("defines the expected event types", () => {
    expect(OrchestrationEvent.Spawn.type).toBe("orchestration.spawn")
    expect(OrchestrationEvent.SpawnRejected.type).toBe("orchestration.spawn-rejected")
    expect(OrchestrationEvent.Complete.type).toBe("orchestration.complete")
    expect(OrchestrationEvent.Abort.type).toBe("orchestration.abort")
    expect(OrchestrationEvent.LoopDetected.type).toBe("orchestration.loop-detected")
    expect(OrchestrationEvent.ConcurrencyQueued.type).toBe("orchestration.concurrency-queued")
    expect(OrchestrationEvent.ConcurrencyReleased.type).toBe("orchestration.concurrency-released")
  })

  test("accepts valid payloads", () => {
    expect(
      OrchestrationEvent.Spawn.properties.safeParse({
        sessionID: "s1",
        parentSessionID: "p1",
        agent: "explore",
        depth: 1,
      }).success,
    ).toBe(true)
    expect(
      OrchestrationEvent.SpawnRejected.properties.safeParse({
        sessionID: "s1",
        agent: "explore",
        reason: "max_depth",
        limit: 3,
        current: 3,
      }).success,
    ).toBe(true)
    expect(
      OrchestrationEvent.Complete.properties.safeParse({
        sessionID: "s1",
        parentSessionID: "p1",
        agent: "explore",
        durationMs: 10,
      }).success,
    ).toBe(true)
    expect(OrchestrationEvent.Abort.properties.safeParse({ sessionID: "s1", reason: "timeout" }).success).toBe(true)
    expect(
      OrchestrationEvent.LoopDetected.properties.safeParse({ sessionID: "s1", toolName: "task", count: 5 }).success,
    ).toBe(true)
    expect(
      OrchestrationEvent.ConcurrencyQueued.properties.safeParse({ key: "openai:gpt", queueLength: 2 }).success,
    ).toBe(true)
    expect(
      OrchestrationEvent.ConcurrencyReleased.properties.safeParse({ key: "openai:gpt", queueLength: 0 }).success,
    ).toBe(true)
  })

  test("rejects invalid payloads", () => {
    expect(OrchestrationEvent.Spawn.properties.safeParse({}).success).toBe(false)
    expect(
      OrchestrationEvent.SpawnRejected.properties.safeParse({
        sessionID: "s1",
        agent: "explore",
        reason: "other",
        limit: 3,
        current: 1,
      }).success,
    ).toBe(false)
    expect(OrchestrationEvent.Complete.properties.safeParse({ sessionID: "s1" }).success).toBe(false)
    expect(OrchestrationEvent.Abort.properties.safeParse({ sessionID: 1, reason: "x" }).success).toBe(false)
    expect(OrchestrationEvent.LoopDetected.properties.safeParse({ sessionID: "s1", toolName: "task" }).success).toBe(
      false,
    )
    expect(OrchestrationEvent.ConcurrencyQueued.properties.safeParse({ key: "k", queueLength: "1" }).success).toBe(
      false,
    )
    expect(OrchestrationEvent.ConcurrencyReleased.properties.safeParse({ key: 1, queueLength: 0 }).success).toBe(false)
  })
})
