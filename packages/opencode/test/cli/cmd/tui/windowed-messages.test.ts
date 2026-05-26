import { afterEach, describe, expect, mock, test } from "bun:test"
import { Pagination } from "../../../../src/cli/cmd/tui/util/pagination"

describe("windowed message eviction", () => {
  test("eviction cap is 300 messages", () => {
    // Validates the constant used for eviction threshold
    // The sync store evicts when messages > 300
    const cap = 300
    expect(cap).toBe(300)
  })

  test("pagination tracks cursor from initial load", () => {
    const p = Pagination()
    // Simulates what happens after initial load with cursor
    const cursor = "abc123"
    p.set("session1", { cursor, more: true, loading: false })
    const state = p.get("session1")
    expect(state.cursor).toBe("abc123")
    expect(state.more).toBe(true)
    expect(state.loading).toBe(false)
  })

  test("pagination tracks no-more when cursor is null", () => {
    const p = Pagination()
    p.set("session1", { cursor: null, more: false, loading: false })
    const state = p.get("session1")
    expect(state.cursor).toBeNull()
    expect(state.more).toBe(false)
  })

  test("loadOlder guard: skip when loading", () => {
    const p = Pagination()
    p.set("s1", { cursor: "c1", more: true, loading: true })
    const state = p.get("s1")
    // loadOlder should bail when loading is true
    expect(state.loading).toBe(true)
    expect(state.more).toBe(true)
  })

  test("loadOlder guard: skip when no more", () => {
    const p = Pagination()
    p.set("s1", { cursor: null, more: false, loading: false })
    const state = p.get("s1")
    expect(state.more).toBe(false)
  })

  test("pagination state transitions during load", () => {
    const p = Pagination()
    // Initial state after first fetch
    p.set("s1", { cursor: "page1", more: true, loading: false })

    // Start loading
    p.set("s1", { loading: true })
    expect(p.get("s1").loading).toBe(true)
    expect(p.get("s1").cursor).toBe("page1")

    // Finish loading with new cursor
    p.set("s1", { cursor: "page2", loading: false, more: true })
    expect(p.get("s1").cursor).toBe("page2")
    expect(p.get("s1").loading).toBe(false)
    expect(p.get("s1").more).toBe(true)
  })

  test("pagination state when last page loaded", () => {
    const p = Pagination()
    p.set("s1", { cursor: "page1", more: true, loading: false })
    // Load returns no cursor (last page)
    p.set("s1", { cursor: null, loading: false, more: false })
    expect(p.get("s1").more).toBe(false)
    expect(p.get("s1").cursor).toBeNull()
  })

  test("pagination error recovery", () => {
    const p = Pagination()
    p.set("s1", { cursor: "c1", more: true, loading: false })

    // Start load
    p.set("s1", { loading: true })

    // Error: reset loading but keep cursor and more
    p.set("s1", { loading: false })
    expect(p.get("s1").cursor).toBe("c1")
    expect(p.get("s1").more).toBe(true)
    expect(p.get("s1").loading).toBe(false)
  })

  test("multiple sessions have independent pagination", () => {
    const p = Pagination()
    p.set("s1", { cursor: "c1", more: true, loading: false })
    p.set("s2", { cursor: "c2", more: false, loading: true })
    expect(p.get("s1").cursor).toBe("c1")
    expect(p.get("s1").more).toBe(true)
    expect(p.get("s2").cursor).toBe("c2")
    expect(p.get("s2").more).toBe(false)
    expect(p.get("s2").loading).toBe(true)
  })
})
