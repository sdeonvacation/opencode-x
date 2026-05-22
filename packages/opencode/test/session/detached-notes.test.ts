import { describe, test, expect, beforeEach } from "bun:test"
import { DetachedNotes } from "@/session/detached-notes"
import type { SessionID } from "@/session/schema"

const sid = (s: string) => s as SessionID

describe("DetachedNotes", () => {
  beforeEach(() => {
    DetachedNotes.drain(sid("a"))
    DetachedNotes.drain(sid("b"))
    DetachedNotes.unprotect(sid("a"))
    DetachedNotes.unprotect(sid("b"))
    DetachedNotes.unprotect(sid("c1"))
    DetachedNotes.unprotect(sid("c2"))
    DetachedNotes.clearDetaching(sid("a"))
    DetachedNotes.removeParent(sid("a"))
  })

  // --- Notes ---
  test("queue and drain notes", () => {
    DetachedNotes.queue(sid("a"), "completed", "done")
    DetachedNotes.queue(sid("a"), "error", "oops")
    const drained = DetachedNotes.drain(sid("a"))
    expect(drained).toHaveLength(2)
    expect(drained[0]).toEqual({ state: "completed", summary: "done" })
    expect(drained[1]).toEqual({ state: "error", summary: "oops" })
  })

  test("drain clears notes", () => {
    DetachedNotes.queue(sid("a"), "completed", "x")
    DetachedNotes.drain(sid("a"))
    expect(DetachedNotes.drain(sid("a"))).toHaveLength(0)
  })

  test("peek does not clear notes", () => {
    DetachedNotes.queue(sid("a"), "cancelled", "c")
    expect(DetachedNotes.peek(sid("a"))).toHaveLength(1)
    expect(DetachedNotes.peek(sid("a"))).toHaveLength(1)
  })

  test("drain returns empty for unknown session", () => {
    expect(DetachedNotes.drain(sid("unknown"))).toHaveLength(0)
  })

  test("peek returns empty for unknown session", () => {
    expect(DetachedNotes.peek(sid("unknown"))).toHaveLength(0)
  })

  test("notes are isolated per session", () => {
    DetachedNotes.queue(sid("a"), "completed", "a-note")
    DetachedNotes.queue(sid("b"), "error", "b-note")
    expect(DetachedNotes.drain(sid("a"))).toHaveLength(1)
    expect(DetachedNotes.drain(sid("b"))).toHaveLength(1)
    expect(DetachedNotes.drain(sid("a"))).toHaveLength(0)
  })

  // --- Protection ---
  test("protect and isProtected", () => {
    expect(DetachedNotes.isProtected(sid("a"))).toBe(false)
    DetachedNotes.protect(sid("a"))
    expect(DetachedNotes.isProtected(sid("a"))).toBe(true)
  })

  test("unprotect removes protection", () => {
    DetachedNotes.protect(sid("a"))
    DetachedNotes.unprotect(sid("a"))
    expect(DetachedNotes.isProtected(sid("a"))).toBe(false)
  })

  test("unprotect on non-protected is no-op", () => {
    DetachedNotes.unprotect(sid("a"))
    expect(DetachedNotes.isProtected(sid("a"))).toBe(false)
  })

  // --- Detaching flag ---
  test("markDetaching and isDetaching", () => {
    expect(DetachedNotes.isDetaching(sid("a"))).toBe(false)
    DetachedNotes.markDetaching(sid("a"))
    expect(DetachedNotes.isDetaching(sid("a"))).toBe(true)
  })

  test("clearDetaching removes flag", () => {
    DetachedNotes.markDetaching(sid("a"))
    DetachedNotes.clearDetaching(sid("a"))
    expect(DetachedNotes.isDetaching(sid("a"))).toBe(false)
  })

  // --- Parent tracking ---
  test("registerParent and getDetachedChildren", () => {
    DetachedNotes.registerParent(
      sid("a"),
      [
        { childID: sid("c1"), description: "task 1" },
        { childID: sid("c2"), description: "task 2" },
      ],
      { providerID: "anthropic", modelID: "claude" },
      "build",
    )
    const children = DetachedNotes.getDetachedChildren(sid("a"))
    expect(children).toHaveLength(2)
    expect(children).toContain("c1")
    expect(children).toContain("c2")
  })

  test("getDetachedChildren returns empty for unknown parent", () => {
    expect(DetachedNotes.getDetachedChildren(sid("unknown"))).toHaveLength(0)
  })

  test("getParent returns registered state", () => {
    DetachedNotes.registerParent(
      sid("a"),
      [{ childID: sid("c1"), description: "task 1" }],
      { providerID: "openai", modelID: "gpt-4" },
      "code",
    )
    const parent = DetachedNotes.getParent(sid("a"))
    expect(parent).toBeDefined()
    expect(parent!.model).toEqual({ providerID: "openai", modelID: "gpt-4" })
    expect(parent!.agent).toBe("code")
    expect(parent!.pending).toBe(1)
  })

  test("getParent returns undefined for unknown", () => {
    expect(DetachedNotes.getParent(sid("unknown"))).toBeUndefined()
  })

  test("removeParent returns child IDs and cleans up", () => {
    DetachedNotes.registerParent(
      sid("a"),
      [
        { childID: sid("c1"), description: "t1" },
        { childID: sid("c2"), description: "t2" },
      ],
      { providerID: "p", modelID: "m" },
      "build",
    )
    const ids = DetachedNotes.removeParent(sid("a"))
    expect(ids).toHaveLength(2)
    expect(DetachedNotes.getParent(sid("a"))).toBeUndefined()
  })

  test("removeParent returns empty for unknown", () => {
    expect(DetachedNotes.removeParent(sid("unknown"))).toHaveLength(0)
  })

  // --- childCompleted ---
  test("childCompleted tracks results and signals allDone", () => {
    DetachedNotes.registerParent(
      sid("a"),
      [
        { childID: sid("c1"), description: "t1" },
        { childID: sid("c2"), description: "t2" },
      ],
      { providerID: "p", modelID: "m" },
      "build",
    )

    const first = DetachedNotes.childCompleted(sid("a"), sid("c1"), {
      childID: sid("c1"),
      description: "t1",
      result: "output1",
      state: "completed",
    })
    expect(first).toBeDefined()
    expect(first!.allDone).toBe(false)
    expect(first!.results).toHaveLength(0)

    const second = DetachedNotes.childCompleted(sid("a"), sid("c2"), {
      childID: sid("c2"),
      description: "t2",
      error: "failed",
      state: "error",
    })
    expect(second).toBeDefined()
    expect(second!.allDone).toBe(true)
    expect(second!.results).toHaveLength(2)
    expect(second!.results[0].state).toBe("completed")
    expect(second!.results[1].state).toBe("error")
  })

  test("childCompleted returns undefined for unknown parent", () => {
    const result = DetachedNotes.childCompleted(sid("unknown"), sid("c1"), {
      childID: sid("c1"),
      description: "t",
      state: "completed",
    })
    expect(result).toBeUndefined()
  })

  test("childCompleted returns undefined for unknown child", () => {
    DetachedNotes.registerParent(
      sid("a"),
      [{ childID: sid("c1"), description: "t1" }],
      { providerID: "p", modelID: "m" },
      "build",
    )
    const result = DetachedNotes.childCompleted(sid("a"), sid("unknown"), {
      childID: sid("unknown"),
      description: "t",
      state: "completed",
    })
    expect(result).toBeUndefined()
  })

  test("childCompleted cleans up parent on allDone", () => {
    DetachedNotes.registerParent(
      sid("a"),
      [{ childID: sid("c1"), description: "t1" }],
      { providerID: "p", modelID: "m" },
      "build",
    )
    DetachedNotes.childCompleted(sid("a"), sid("c1"), {
      childID: sid("c1"),
      description: "t1",
      result: "done",
      state: "completed",
    })
    expect(DetachedNotes.getParent(sid("a"))).toBeUndefined()
  })
})
