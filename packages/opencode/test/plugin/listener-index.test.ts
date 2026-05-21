import { describe, expect, test } from "bun:test"
import { ListenerIndex } from "../../src/plugin/listener-index"

describe("ListenerIndex.build", () => {
  test("empty hooks array → has() always returns false", () => {
    const idx = ListenerIndex.build([])
    expect(ListenerIndex.has(idx, "experimental.chat.system.transform")).toBe(false)
    expect(ListenerIndex.has(idx, "anyEvent")).toBe(false)
  })

  test("single hook with one truthy listener → has() returns true for that name", () => {
    const hooks = [{ "experimental.chat.system.transform": () => {} }]
    const idx = ListenerIndex.build(hooks)
    expect(ListenerIndex.has(idx, "experimental.chat.system.transform")).toBe(true)
    expect(ListenerIndex.has(idx, "other.event")).toBe(false)
  })

  test("falsy values are not counted", () => {
    const hooks = [
      {
        "event.a": null,
        "event.b": undefined,
        "event.c": false,
        "event.d": () => {},
      },
    ]
    const idx = ListenerIndex.build(hooks as any)
    expect(ListenerIndex.has(idx, "event.a")).toBe(false)
    expect(ListenerIndex.has(idx, "event.b")).toBe(false)
    expect(ListenerIndex.has(idx, "event.c")).toBe(false)
    expect(ListenerIndex.has(idx, "event.d")).toBe(true)
  })

  test("multiple plugins with overlapping keys → counts aggregate correctly", () => {
    const hooks = [
      { "event.a": () => {}, "event.b": () => {} },
      { "event.a": () => {} }, // second plugin also listens to event.a
      { "event.c": () => {} },
    ]
    const idx = ListenerIndex.build(hooks)
    // event.a has 2 listeners
    expect((idx.get("event.a") ?? 0)).toBe(2)
    // event.b has 1 listener
    expect((idx.get("event.b") ?? 0)).toBe(1)
    // event.c has 1 listener
    expect((idx.get("event.c") ?? 0)).toBe(1)

    expect(ListenerIndex.has(idx, "event.a")).toBe(true)
    expect(ListenerIndex.has(idx, "event.b")).toBe(true)
    expect(ListenerIndex.has(idx, "event.c")).toBe(true)
    expect(ListenerIndex.has(idx, "event.d")).toBe(false)
  })

  test("hook with non-object value is skipped gracefully", () => {
    const hooks = [null, undefined, 42, "string", { "event.x": () => {} }] as any[]
    const idx = ListenerIndex.build(hooks)
    expect(ListenerIndex.has(idx, "event.x")).toBe(true)
    expect(idx.size).toBe(1)
  })

  test("has() returns false for count=0 even if key was set", () => {
    // Manually constructed edge: key exists but count is 0
    const idx = new Map<string, number>([["event.zero", 0]])
    expect(ListenerIndex.has(idx, "event.zero")).toBe(false)
  })
})
