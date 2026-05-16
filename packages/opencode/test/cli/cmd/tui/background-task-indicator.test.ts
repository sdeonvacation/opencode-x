import { describe, expect, test } from "bun:test"
import { TuiEvent } from "../../../../src/cli/cmd/tui/event"

describe("TuiEvent.BackgroundTaskUpdate", () => {
  test("event type is defined", () => {
    expect(TuiEvent.BackgroundTaskUpdate).toBeDefined()
    expect(TuiEvent.BackgroundTaskUpdate.type).toBe("tui.background.update")
  })

  test("schema validates running state", () => {
    const payload = {
      sessionID: "ses_abc123",
      taskID: "ses_task_1",
      title: "run tests",
      state: "running" as const,
    }
    const result = TuiEvent.BackgroundTaskUpdate.properties.safeParse(payload)
    expect(result.success).toBe(true)
  })

  test("schema validates completed state", () => {
    const payload = {
      sessionID: "ses_abc123",
      taskID: "ses_task_1",
      title: "run tests",
      state: "completed" as const,
    }
    const result = TuiEvent.BackgroundTaskUpdate.properties.safeParse(payload)
    expect(result.success).toBe(true)
  })

  test("schema validates error state", () => {
    const payload = {
      sessionID: "ses_abc123",
      taskID: "ses_task_1",
      title: "run tests",
      state: "error" as const,
    }
    const result = TuiEvent.BackgroundTaskUpdate.properties.safeParse(payload)
    expect(result.success).toBe(true)
  })

  test("schema rejects invalid state", () => {
    const payload = {
      sessionID: "ses_abc123",
      taskID: "ses_task_1",
      title: "run tests",
      state: "unknown",
    }
    const result = TuiEvent.BackgroundTaskUpdate.properties.safeParse(payload)
    expect(result.success).toBe(false)
  })

  test("schema rejects missing taskID", () => {
    const payload = {
      sessionID: "ses_abc123",
      title: "run tests",
      state: "running",
    }
    const result = TuiEvent.BackgroundTaskUpdate.properties.safeParse(payload)
    expect(result.success).toBe(false)
  })

  test("schema rejects missing title", () => {
    const payload = {
      sessionID: "ses_abc123",
      taskID: "ses_task_1",
      state: "running",
    }
    const result = TuiEvent.BackgroundTaskUpdate.properties.safeParse(payload)
    expect(result.success).toBe(false)
  })

  test("schema rejects missing sessionID", () => {
    const payload = {
      taskID: "ses_task_1",
      title: "run tests",
      state: "running",
    }
    const result = TuiEvent.BackgroundTaskUpdate.properties.safeParse(payload)
    expect(result.success).toBe(false)
  })
})
