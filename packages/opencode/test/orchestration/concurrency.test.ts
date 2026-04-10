import { describe, expect, spyOn, test } from "bun:test"
import { Bus } from "../../src/bus"
import { acquire, cancelWaiters, ConcurrencyCancelledError, release, stats } from "../../src/orchestration/concurrency"

describe("orchestration/concurrency", () => {
  test("acquires immediately under the limit", async () => {
    const key = `model:${crypto.randomUUID()}`
    const publish = spyOn(Bus, "publish").mockResolvedValue()

    try {
      await acquire(key, 2)
      expect(stats(key)).toEqual({ active: 1, queued: 0 })

      release(key)
      expect(stats(key)).toEqual({ active: 0, queued: 0 })
      expect(publish).toHaveBeenCalledTimes(1)
    } finally {
      publish.mockRestore()
    }
  })

  test("queues when limit is reached and resumes on release", async () => {
    const key = `model:${crypto.randomUUID()}`
    const publish = spyOn(Bus, "publish").mockResolvedValue()

    try {
      await acquire(key, 1)
      let resumed = false
      const wait = acquire(key, 1).then(() => {
        resumed = true
      })

      await Promise.resolve()
      expect(stats(key)).toEqual({ active: 1, queued: 1 })
      expect(resumed).toBe(false)

      release(key)
      await wait
      expect(resumed).toBe(true)
      expect(stats(key)).toEqual({ active: 1, queued: 0 })

      release(key)
    } finally {
      publish.mockRestore()
    }
  })

  test("cancelWaiters rejects queued acquires", async () => {
    const key = `model:${crypto.randomUUID()}`
    const publish = spyOn(Bus, "publish").mockResolvedValue()

    try {
      await acquire(key, 1)
      const wait = acquire(key, 1)
      await Promise.resolve()

      cancelWaiters(key)

      await expect(wait).rejects.toEqual(new ConcurrencyCancelledError(key))
      expect(stats(key)).toEqual({ active: 1, queued: 0 })

      release(key)
    } finally {
      publish.mockRestore()
    }
  })

  test("aborting one queued acquire does not cancel siblings", async () => {
    const key = `model:${crypto.randomUUID()}`
    const publish = spyOn(Bus, "publish").mockResolvedValue()

    try {
      await acquire(key, 1)

      const first = new AbortController()
      const second = new AbortController()
      const wait1 = acquire(key, 1, first.signal)
      const wait2 = acquire(key, 1, second.signal)
      await Promise.resolve()

      expect(stats(key)).toEqual({ active: 1, queued: 2 })

      first.abort()
      await expect(wait1).rejects.toEqual(new ConcurrencyCancelledError(key))
      expect(stats(key)).toEqual({ active: 1, queued: 1 })

      let resumed = false
      const resumedWait = wait2.then(() => {
        resumed = true
      })

      release(key)
      await resumedWait

      expect(resumed).toBe(true)
      expect(stats(key)).toEqual({ active: 1, queued: 0 })

      release(key)
    } finally {
      publish.mockRestore()
    }
  })

  test("release after cancel does not double resolve waiters", async () => {
    const key = `model:${crypto.randomUUID()}`
    const publish = spyOn(Bus, "publish").mockResolvedValue()

    try {
      await acquire(key, 1)
      let resolved = false
      const wait = acquire(key, 1).then(() => {
        resolved = true
      })
      await Promise.resolve()

      cancelWaiters(key)
      await expect(wait).rejects.toEqual(new ConcurrencyCancelledError(key))

      release(key)
      await Promise.resolve()

      expect(resolved).toBe(false)
      expect(stats(key)).toEqual({ active: 0, queued: 0 })
    } finally {
      publish.mockRestore()
    }
  })

  test("tracks multiple keys independently", async () => {
    const a = `model:${crypto.randomUUID()}`
    const b = `model:${crypto.randomUUID()}`
    const publish = spyOn(Bus, "publish").mockResolvedValue()

    try {
      await acquire(a, 1)
      await acquire(b, 1)

      expect(stats(a)).toEqual({ active: 1, queued: 0 })
      expect(stats(b)).toEqual({ active: 1, queued: 0 })

      release(a)
      release(b)
    } finally {
      publish.mockRestore()
    }
  })

  test("release with no active slot is a no-op", () => {
    const key = `model:${crypto.randomUUID()}`
    const publish = spyOn(Bus, "publish").mockResolvedValue()

    try {
      release(key)

      expect(stats(key)).toEqual({ active: 0, queued: 0 })
    } finally {
      publish.mockRestore()
    }
  })
})
