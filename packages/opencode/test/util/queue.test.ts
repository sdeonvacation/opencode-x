import { describe, expect, test } from "bun:test"
import { AsyncQueue } from "../../src/util/queue"

describe("util/queue", () => {
  test("drops oldest non-terminal item when bounded queue is full", async () => {
    const q = new AsyncQueue<number | null>({ maxSize: 2 })
    q.push(1)
    q.push(2)
    q.push(3)

    expect(await q.next()).toBe(2)
    expect(await q.next()).toBe(3)
  })

  test("always enqueues terminal null even when full", async () => {
    const q = new AsyncQueue<number | null>({ maxSize: 1 })
    q.push(1)
    q.push(null)

    expect(await q.next()).toBe(1)
    expect(await q.next()).toBe(null)
  })

  test("remains unbounded when maxSize is not provided", async () => {
    const q = new AsyncQueue<number>()
    for (let i = 0; i < 1100; i++) q.push(i)

    expect(await q.next()).toBe(0)
    expect(await q.next()).toBe(1)
  })

  test("drops oldest item at maxSize 1000 and preserves newest", async () => {
    const q = new AsyncQueue<number>({ maxSize: 1000 })
    for (let i = 0; i < 1001; i++) q.push(i)

    expect(await q.next()).toBe(1)
    for (let i = 2; i < 1001; i++) {
      expect(await q.next()).toBe(i)
    }
  })
})
