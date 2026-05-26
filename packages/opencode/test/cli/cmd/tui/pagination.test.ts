import { describe, expect, test } from "bun:test"
import { Pagination } from "../../../../src/cli/cmd/tui/util/pagination"

describe("Pagination", () => {
  test("initial state for unknown session", () => {
    const p = Pagination()
    const state = p.get("unknown")
    expect(state.cursor).toBeNull()
    expect(state.loading).toBe(false)
    expect(state.more).toBe(false)
  })

  test("set partial state merges with existing", () => {
    const p = Pagination()
    p.set("s1", { cursor: "abc", more: true })
    expect(p.get("s1")).toEqual({ cursor: "abc", loading: false, more: true })

    p.set("s1", { loading: true })
    expect(p.get("s1")).toEqual({ cursor: "abc", loading: true, more: true })
  })

  test("set overwrites fields", () => {
    const p = Pagination()
    p.set("s1", { cursor: "c1", more: true, loading: false })
    p.set("s1", { cursor: "c2", more: false })
    expect(p.get("s1").cursor).toBe("c2")
    expect(p.get("s1").more).toBe(false)
    expect(p.get("s1").loading).toBe(false)
  })

  test("delete removes session state", () => {
    const p = Pagination()
    p.set("s1", { cursor: "x", more: true })
    p.delete("s1")
    expect(p.get("s1").cursor).toBeNull()
    expect(p.get("s1").more).toBe(false)
  })

  test("clear removes all sessions", () => {
    const p = Pagination()
    p.set("s1", { cursor: "a", more: true })
    p.set("s2", { cursor: "b", more: true })
    p.clear()
    expect(p.get("s1").more).toBe(false)
    expect(p.get("s2").more).toBe(false)
  })

  test("get returns fresh copy each time", () => {
    const p = Pagination()
    p.set("s1", { cursor: "a", more: true })
    const a = p.get("s1")
    p.set("s1", { cursor: "b" })
    const b = p.get("s1")
    expect(a.cursor).toBe("a")
    expect(b.cursor).toBe("b")
  })
})
