import { describe, expect, test } from "bun:test"
import { acquire, release } from "../../src/orchestration/patch-lock"

describe("orchestration/patch-lock", () => {
  test("acquire succeeds immediately when not held", async () => {
    const key = `project:${crypto.randomUUID()}`
    await acquire(key)
    release(key)
  })

  test("second acquire waits until release", async () => {
    const key = `project:${crypto.randomUUID()}`
    await acquire(key)

    let resumed = false
    const wait = acquire(key).then(() => {
      resumed = true
    })

    await Promise.resolve()
    expect(resumed).toBe(false)

    release(key)
    await wait
    expect(resumed).toBe(true)

    release(key)
  })

  test("queued acquires resolve in order", async () => {
    const key = `project:${crypto.randomUUID()}`
    await acquire(key)

    const order: number[] = []
    const w1 = acquire(key).then(() => order.push(1))
    const w2 = acquire(key).then(() => order.push(2))

    await Promise.resolve()
    expect(order).toEqual([])

    release(key)
    await w1
    release(key)
    await w2
    release(key)

    expect(order).toEqual([1, 2])
  })

  test("release with no held lock is a no-op", () => {
    const key = `project:${crypto.randomUUID()}`
    release(key)
  })

  test("independent projects do not block each other", async () => {
    const a = `project:${crypto.randomUUID()}`
    const b = `project:${crypto.randomUUID()}`

    await acquire(a)
    await acquire(b)

    let resumed = false
    const wait = acquire(a).then(() => {
      resumed = true
    })

    await Promise.resolve()
    expect(resumed).toBe(false)

    release(a)
    await wait
    expect(resumed).toBe(true)

    release(a)
    release(b)
  })

  test("lock is cleaned up after final release", async () => {
    const key = `project:${crypto.randomUUID()}`
    await acquire(key)
    release(key)

    // Acquiring again should succeed immediately (no stale state)
    await acquire(key)
    release(key)
  })
})
