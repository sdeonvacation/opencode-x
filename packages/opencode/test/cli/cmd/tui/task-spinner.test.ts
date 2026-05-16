import { describe, expect, test } from "bun:test"
import { TuiEvent } from "../../../../src/cli/cmd/tui/event"

/**
 * Tests the background task spinner logic used in the Task component.
 *
 * The Task component derives `isRunning` as:
 * - For background tasks: starts true, flips to false when a BackgroundTaskUpdate
 *   event arrives with state !== "running" matching the task's session ID.
 * - For blocking tasks: uses props.part.state.status === "running".
 */
describe("Task spinner logic", () => {
  // Simulates the derivation logic extracted from the Task component
  function derive(opts: {
    background: boolean
    partStatus: string
    events: Array<{ taskID: string; state: string }>
    sessionId: string
  }) {
    // Mirrors: const [bgRunning, setBgRunning] = createSignal(!!props.metadata.background)
    let bgRunning = !!opts.background

    if (opts.background) {
      for (const evt of opts.events) {
        if (evt.taskID !== opts.sessionId) continue
        bgRunning = evt.state === "running"
      }
    }

    // Mirrors: const isRunning = createMemo(() => props.metadata.background ? bgRunning() : props.part.state.status === "running")
    return opts.background ? bgRunning : opts.partStatus === "running"
  }

  test("background task starts with spinner on", () => {
    const result = derive({
      background: true,
      partStatus: "completed",
      events: [],
      sessionId: "ses_task_1",
    })
    expect(result).toBe(true)
  })

  test("background task spinner turns off on completed event", () => {
    const result = derive({
      background: true,
      partStatus: "completed",
      events: [{ taskID: "ses_task_1", state: "completed" }],
      sessionId: "ses_task_1",
    })
    expect(result).toBe(false)
  })

  test("background task spinner turns off on error event", () => {
    const result = derive({
      background: true,
      partStatus: "completed",
      events: [{ taskID: "ses_task_1", state: "error" }],
      sessionId: "ses_task_1",
    })
    expect(result).toBe(false)
  })

  test("background task ignores events for other task IDs", () => {
    const result = derive({
      background: true,
      partStatus: "completed",
      events: [{ taskID: "ses_other", state: "completed" }],
      sessionId: "ses_task_1",
    })
    expect(result).toBe(true)
  })

  test("background task spinner stays on while running event arrives", () => {
    const result = derive({
      background: true,
      partStatus: "completed",
      events: [{ taskID: "ses_task_1", state: "running" }],
      sessionId: "ses_task_1",
    })
    expect(result).toBe(true)
  })

  test("blocking task uses part status running", () => {
    const result = derive({
      background: false,
      partStatus: "running",
      events: [],
      sessionId: "ses_task_1",
    })
    expect(result).toBe(true)
  })

  test("blocking task uses part status completed", () => {
    const result = derive({
      background: false,
      partStatus: "completed",
      events: [],
      sessionId: "ses_task_1",
    })
    expect(result).toBe(false)
  })

  test("blocking task ignores background events", () => {
    const result = derive({
      background: false,
      partStatus: "running",
      events: [{ taskID: "ses_task_1", state: "completed" }],
      sessionId: "ses_task_1",
    })
    expect(result).toBe(true)
  })

  test("BackgroundTaskUpdate event type matches expected value", () => {
    expect(TuiEvent.BackgroundTaskUpdate.type).toBe("tui.background.update")
  })

  // Validates the race condition fix: if "completed" arrives without any prior
  // "running" event (because we removed the racing publish), spinner correctly stops.
  test("background task stops spinner on completed without prior running event", () => {
    const result = derive({
      background: true,
      partStatus: "completed",
      events: [{ taskID: "ses_task_1", state: "completed" }],
      sessionId: "ses_task_1",
    })
    expect(result).toBe(false)
  })

  // Validates that if completed arrives THEN a stale running event arrives (old race),
  // the spinner would erroneously turn back on. This documents the bug scenario
  // that the task.ts fix prevents by not emitting "running" at all.
  test("completed then running event causes erroneous spinner (documents race)", () => {
    const result = derive({
      background: true,
      partStatus: "completed",
      events: [
        { taskID: "ses_task_1", state: "completed" },
        { taskID: "ses_task_1", state: "running" },
      ],
      sessionId: "ses_task_1",
    })
    // This would be true (bug) if the running event arrives after completed
    // The fix in task.ts prevents this by never emitting the running event
    expect(result).toBe(true)
  })

  test("BackgroundTaskUpdate schema accepts valid running payload", () => {
    const result = TuiEvent.BackgroundTaskUpdate.properties.safeParse({
      sessionID: "ses_abc",
      taskID: "ses_task_1",
      title: "test task",
      state: "running",
    })
    expect(result.success).toBe(true)
  })

  test("BackgroundTaskUpdate schema accepts valid completed payload", () => {
    const result = TuiEvent.BackgroundTaskUpdate.properties.safeParse({
      sessionID: "ses_abc",
      taskID: "ses_task_1",
      title: "test task",
      state: "completed",
    })
    expect(result.success).toBe(true)
  })
})
