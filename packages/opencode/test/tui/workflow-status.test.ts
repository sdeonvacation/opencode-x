import { describe, test, expect, beforeEach } from "bun:test"

type WorkflowStatus = {
  id: string
  name: string
  phase: string
  status: "running" | "completed" | "failed" | "cancelled"
  error?: string
}

// Extract state machine logic from the context to test independently
function createWorkflowState() {
  let current: WorkflowStatus | null = null
  let timer: Timer | undefined

  function handle(evt: { type: string; properties: Record<string, any> }) {
    if (evt.type === "workflow.started") {
      if (timer) clearTimeout(timer)
      timer = undefined
      current = {
        id: evt.properties.runID,
        name: evt.properties.name,
        phase: "starting",
        status: "running",
      }
    }

    if (evt.type === "workflow.phase") {
      if (!current || current.id !== evt.properties.runID) return
      current = { ...current, phase: evt.properties.phase }
    }

    if (evt.type === "workflow.finished") {
      if (!current || current.id !== evt.properties.runID) return
      current = { ...current, status: evt.properties.status, error: evt.properties.error }
      timer = setTimeout(() => {
        current = null
      }, 5000)
    }
  }

  return {
    get current() {
      return current
    },
    handle,
    clear() {
      current = null
      if (timer) clearTimeout(timer)
    },
  }
}

describe("workflow status state", () => {
  let state: ReturnType<typeof createWorkflowState>

  beforeEach(() => {
    state = createWorkflowState()
  })

  test("starts null", () => {
    expect(state.current).toBeNull()
  })

  test("workflow.started sets running state", () => {
    state.handle({
      type: "workflow.started",
      properties: { runID: "run1", name: "review-and-fix", sessionID: "s1" },
    })
    expect(state.current).toEqual({
      id: "run1",
      name: "review-and-fix",
      phase: "starting",
      status: "running",
    })
  })

  test("workflow.phase updates phase", () => {
    state.handle({
      type: "workflow.started",
      properties: { runID: "run1", name: "deploy", sessionID: "s1" },
    })
    state.handle({
      type: "workflow.phase",
      properties: { runID: "run1", phase: "testing" },
    })
    expect(state.current!.phase).toBe("testing")
  })

  test("workflow.phase ignores mismatched runID", () => {
    state.handle({
      type: "workflow.started",
      properties: { runID: "run1", name: "deploy", sessionID: "s1" },
    })
    state.handle({
      type: "workflow.phase",
      properties: { runID: "run-other", phase: "building" },
    })
    expect(state.current!.phase).toBe("starting")
  })

  test("workflow.phase ignored when no active workflow", () => {
    state.handle({
      type: "workflow.phase",
      properties: { runID: "run1", phase: "testing" },
    })
    expect(state.current).toBeNull()
  })

  test("workflow.finished sets terminal status", () => {
    state.handle({
      type: "workflow.started",
      properties: { runID: "run1", name: "deploy", sessionID: "s1" },
    })
    state.handle({
      type: "workflow.finished",
      properties: { runID: "run1", name: "deploy", status: "completed" },
    })
    expect(state.current!.status).toBe("completed")
    expect(state.current!.error).toBeUndefined()
  })

  test("workflow.finished with error", () => {
    state.handle({
      type: "workflow.started",
      properties: { runID: "run1", name: "deploy", sessionID: "s1" },
    })
    state.handle({
      type: "workflow.finished",
      properties: { runID: "run1", name: "deploy", status: "failed", error: "timeout" },
    })
    expect(state.current!.status).toBe("failed")
    expect(state.current!.error).toBe("timeout")
  })

  test("workflow.finished ignores mismatched runID", () => {
    state.handle({
      type: "workflow.started",
      properties: { runID: "run1", name: "deploy", sessionID: "s1" },
    })
    state.handle({
      type: "workflow.finished",
      properties: { runID: "run-other", name: "deploy", status: "completed" },
    })
    expect(state.current!.status).toBe("running")
  })

  test("new workflow.started replaces previous", () => {
    state.handle({
      type: "workflow.started",
      properties: { runID: "run1", name: "deploy", sessionID: "s1" },
    })
    state.handle({
      type: "workflow.phase",
      properties: { runID: "run1", phase: "building" },
    })
    state.handle({
      type: "workflow.started",
      properties: { runID: "run2", name: "test-suite", sessionID: "s2" },
    })
    expect(state.current).toEqual({
      id: "run2",
      name: "test-suite",
      phase: "starting",
      status: "running",
    })
  })

  test("multiple phase transitions in sequence", () => {
    state.handle({
      type: "workflow.started",
      properties: { runID: "run1", name: "pipeline", sessionID: "s1" },
    })
    state.handle({ type: "workflow.phase", properties: { runID: "run1", phase: "lint" } })
    state.handle({ type: "workflow.phase", properties: { runID: "run1", phase: "test" } })
    state.handle({ type: "workflow.phase", properties: { runID: "run1", phase: "deploy" } })
    expect(state.current!.phase).toBe("deploy")
    expect(state.current!.status).toBe("running")
  })

  test("cancelled status", () => {
    state.handle({
      type: "workflow.started",
      properties: { runID: "run1", name: "deploy", sessionID: "s1" },
    })
    state.handle({
      type: "workflow.finished",
      properties: { runID: "run1", name: "deploy", status: "cancelled" },
    })
    expect(state.current!.status).toBe("cancelled")
  })

  test("unrelated event types ignored", () => {
    state.handle({
      type: "session.updated",
      properties: { sessionID: "s1" },
    })
    expect(state.current).toBeNull()
  })
})
