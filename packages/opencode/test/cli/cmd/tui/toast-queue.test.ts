import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { init, type ToastContext } from "../../../../src/cli/cmd/tui/ui/toast"

describe("toast queue", () => {
  let toast: ToastContext

  beforeEach(() => {
    toast = init()
  })

  test("starts with empty queue", () => {
    expect(toast.currentToast).toBeNull()
    expect(toast.depth).toBe(0)
  })

  test("show() adds item to queue", () => {
    toast.show({ variant: "info", message: "hello" })
    expect(toast.currentToast).not.toBeNull()
    expect(toast.currentToast!.message).toBe("hello")
    expect(toast.currentToast!.variant).toBe("info")
    expect(toast.depth).toBe(1)
  })

  test("show() assigns unique id", () => {
    toast.show({ variant: "info", message: "a" })
    const first = toast.currentToast!.id
    toast.show({ variant: "info", message: "b" })
    // queue has 2 items; first is still head
    expect(toast.depth).toBe(2)
    toast.dismissAll()
    toast.show({ variant: "info", message: "c" })
    expect(toast.currentToast!.id).not.toBe(first)
  })

  test("show() defaults duration to 5000", () => {
    toast.show({ variant: "success", message: "ok" })
    expect(toast.currentToast!.duration).toBe(5000)
  })

  test("show() respects custom duration", () => {
    toast.show({ variant: "warning", message: "wait", duration: 10000 })
    expect(toast.currentToast!.duration).toBe(10000)
  })

  test("show() preserves title", () => {
    toast.show({ variant: "info", message: "body", title: "Header" })
    expect(toast.currentToast!.title).toBe("Header")
  })

  test("currentToast returns first item (FIFO)", () => {
    toast.show({ variant: "info", message: "first" })
    toast.show({ variant: "info", message: "second" })
    expect(toast.currentToast!.message).toBe("first")
  })

  test("depth reflects queue length", () => {
    toast.show({ variant: "info", message: "a" })
    toast.show({ variant: "info", message: "b" })
    toast.show({ variant: "info", message: "c" })
    expect(toast.depth).toBe(3)
  })

  test("queue capped at 5 items", () => {
    for (let i = 0; i < 7; i++) {
      toast.show({ variant: "info", message: `msg-${i}` })
    }
    expect(toast.depth).toBe(5)
  })

  test("oldest dropped when exceeding cap", () => {
    for (let i = 0; i < 6; i++) {
      toast.show({ variant: "info", message: `msg-${i}` })
    }
    // msg-0 was dropped when msg-5 pushed (queue was at 5 with msg-0..msg-4)
    expect(toast.currentToast!.message).toBe("msg-1")
  })

  test("dismissAll() clears entire queue", () => {
    toast.show({ variant: "info", message: "a" })
    toast.show({ variant: "info", message: "b" })
    toast.dismissAll()
    expect(toast.currentToast).toBeNull()
    expect(toast.depth).toBe(0)
  })

  test("error() with Error instance uses message", () => {
    toast.error(new Error("something broke"))
    expect(toast.currentToast!.variant).toBe("error")
    expect(toast.currentToast!.message).toBe("something broke")
  })

  test("error() with non-Error uses fallback message", () => {
    toast.error("random string")
    expect(toast.currentToast!.variant).toBe("error")
    expect(toast.currentToast!.message).toBe("An unknown error has occurred")
  })

  test("error() with null uses fallback message", () => {
    toast.error(null)
    expect(toast.currentToast!.variant).toBe("error")
    expect(toast.currentToast!.message).toBe("An unknown error has occurred")
  })

  test("auto-dismiss removes expired head after interval tick", async () => {
    toast.show({ variant: "info", message: "ephemeral", duration: 50 })
    expect(toast.depth).toBe(1)
    await new Promise((r) => setTimeout(r, 250))
    expect(toast.depth).toBe(0)
    expect(toast.currentToast).toBeNull()
  })

  test("auto-dismiss promotes next item after head expires", async () => {
    toast.show({ variant: "info", message: "short", duration: 50 })
    toast.show({ variant: "info", message: "long", duration: 5000 })
    expect(toast.depth).toBe(2)
    await new Promise((r) => setTimeout(r, 250))
    expect(toast.depth).toBe(1)
    expect(toast.currentToast!.message).toBe("long")
  })

  test("created timestamp is set", () => {
    const before = Date.now()
    toast.show({ variant: "info", message: "timed" })
    const after = Date.now()
    expect(toast.currentToast!.created).toBeGreaterThanOrEqual(before)
    expect(toast.currentToast!.created).toBeLessThanOrEqual(after)
  })

  test("multiple inits have independent queues", () => {
    const other = init()
    toast.show({ variant: "info", message: "only here" })
    expect(other.depth).toBe(0)
    expect(toast.depth).toBe(1)
  })
})
