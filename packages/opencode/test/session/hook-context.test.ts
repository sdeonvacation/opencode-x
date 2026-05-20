import { describe, test, expect, beforeEach } from "bun:test"
import { HookContext } from "../../src/session/index"

describe("HookContext", () => {
  const id = "sess-test-123"

  beforeEach(() => {
    HookContext.clear(id)
  })

  test("setSession and getSession", () => {
    expect(HookContext.getSession(id)).toBeUndefined()
    HookContext.setSession(id, "session output")
    expect(HookContext.getSession(id)).toBe("session output")
  })

  test("setTurn and getTurn", () => {
    expect(HookContext.getTurn(id)).toBeUndefined()
    HookContext.setTurn(id, "turn output")
    expect(HookContext.getTurn(id)).toBe("turn output")
  })

  test("setTurn overwrites previous value", () => {
    HookContext.setTurn(id, "first")
    HookContext.setTurn(id, "second")
    expect(HookContext.getTurn(id)).toBe("second")
  })

  test("clear removes both session and turn", () => {
    HookContext.setSession(id, "s")
    HookContext.setTurn(id, "t")
    HookContext.clear(id)
    expect(HookContext.getSession(id)).toBeUndefined()
    expect(HookContext.getTurn(id)).toBeUndefined()
  })

  test("independent sessions", () => {
    const other = "sess-other-456"
    HookContext.setSession(id, "a")
    HookContext.setSession(other, "b")
    expect(HookContext.getSession(id)).toBe("a")
    expect(HookContext.getSession(other)).toBe("b")
    HookContext.clear(id)
    expect(HookContext.getSession(id)).toBeUndefined()
    expect(HookContext.getSession(other)).toBe("b")
    HookContext.clear(other)
  })
})
