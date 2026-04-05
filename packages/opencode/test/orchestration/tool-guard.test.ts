import { describe, expect, spyOn, test } from "bun:test"
import { Bus } from "../../src/bus"
import { OrchestrationEvent } from "../../src/orchestration/events"
import { create, LoopDetectedError } from "../../src/orchestration/tool-guard"

describe("orchestration/tool-guard", () => {
  test("allows non-repeating calls", async () => {
    const publish = spyOn(Bus, "publish").mockResolvedValue()
    const guard = create({ sessionID: "session-non-repeating", threshold: 3 })

    try {
      await guard.before({ toolName: "task", input: { prompt: "a" } })
      await guard.before({ toolName: "task", input: { prompt: "b" } })
      expect(publish).not.toHaveBeenCalled()
    } finally {
      guard.reset()
      publish.mockRestore()
    }
  })

  test("publishes event and throws when loop is detected", async () => {
    const publish = spyOn(Bus, "publish").mockResolvedValue()
    const guard = create({ sessionID: "session-detected", threshold: 2 })

    try {
      await guard.before({ toolName: "task", input: { prompt: "repeat" } })
      await expect(guard.before({ toolName: "task", input: { prompt: "repeat" } })).rejects.toEqual(
        new LoopDetectedError("task", 2),
      )
      expect(publish).toHaveBeenCalledWith(OrchestrationEvent.LoopDetected, {
        sessionID: "session-detected",
        toolName: "task",
        count: 2,
      })
    } finally {
      guard.reset()
      publish.mockRestore()
    }
  })

  test("reset clears loop state", async () => {
    const publish = spyOn(Bus, "publish").mockResolvedValue()
    const guard = create({ sessionID: "session-reset", threshold: 2 })

    try {
      await guard.before({ toolName: "task", input: { prompt: "repeat" } })
      guard.reset()
      await guard.before({ toolName: "task", input: { prompt: "repeat" } })
      expect(publish).not.toHaveBeenCalled()
    } finally {
      guard.reset()
      publish.mockRestore()
    }
  })

  test("shares loop state across guards for the same session", async () => {
    const publish = spyOn(Bus, "publish").mockResolvedValue()
    const first = create({ sessionID: "session-shared", threshold: 2 })
    const second = create({ sessionID: "session-shared", threshold: 2 })

    try {
      await first.before({ toolName: "task", input: { prompt: "repeat" } })
      await expect(second.before({ toolName: "task", input: { prompt: "repeat" } })).rejects.toEqual(
        new LoopDetectedError("task", 2),
      )
    } finally {
      first.reset()
      publish.mockRestore()
    }
  })

  test("keeps loop state isolated between sessions", async () => {
    const publish = spyOn(Bus, "publish").mockResolvedValue()
    const first = create({ sessionID: "session-isolated-1", threshold: 2 })
    const second = create({ sessionID: "session-isolated-2", threshold: 2 })

    try {
      await first.before({ toolName: "task", input: { prompt: "repeat" } })
      await second.before({ toolName: "task", input: { prompt: "repeat" } })
      expect(publish).not.toHaveBeenCalled()
    } finally {
      first.reset()
      second.reset()
      publish.mockRestore()
    }
  })
})
