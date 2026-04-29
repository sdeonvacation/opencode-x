/**
 * Unit tests for the LSP idle-timer logic.
 *
 * The logic lives inside LSP.layer but is tested here by simulating the
 * same pattern: subscribe to SessionStatus.Event.Status, check all sessions,
 * start/cancel a timer, fire it to call ScopedCache.invalidate.
 *
 * We extract the logic into a helper that mirrors the production code so we
 * can drive it with fake timers without spinning up the full LSP layer.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { SessionStatus } from "../../src/session/status"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

// ---------------------------------------------------------------------------
// Helpers — mirror the production idle-timer logic
// ---------------------------------------------------------------------------

type IdleTimerState = {
  timer: ReturnType<typeof setTimeout> | undefined
  invalidated: boolean
  unsub: () => void
}

function makeIdleTimer(dir: string, invalidate: () => void, delay = 30 * 60 * 1000): IdleTimerState {
  const s: IdleTimerState = { timer: undefined, invalidated: false, unsub: () => {} }

  const idle = async () => {
    const all = await SessionStatus.list()
    const anyBusy = [...all.values()].some((v) => v.type !== "idle")
    if (anyBusy) {
      if (s.timer) {
        clearTimeout(s.timer)
        s.timer = undefined
      }
      return
    }
    if (!s.timer) {
      s.timer = setTimeout(() => {
        s.timer = undefined
        s.invalidated = true
        invalidate()
      }, delay)
    }
  }

  s.unsub = Bus.subscribe(SessionStatus.Event.Status, idle)
  void idle()

  return s
}

function clear(s: IdleTimerState) {
  s.unsub()
  if (!s.timer) return
  clearTimeout(s.timer)
  s.timer = undefined
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LSP idle timer", () => {
  afterEach(() => Instance.disposeAll())

  test("starts timer when all sessions become idle", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fired: string[] = []
        const s = makeIdleTimer(tmp.path, () => fired.push("invalidated"), 50)

        try {
          // Set a session busy then idle
          await SessionStatus.set("s1" as any, { type: "busy" })
          await SessionStatus.set("s1" as any, { type: "idle" })
          await Bun.sleep(10)

          // Timer should be set but not yet fired
          expect(s.timer).toBeDefined()
          expect(s.invalidated).toBe(false)

          // Wait for timer to fire (delay=50ms)
          await Bun.sleep(100)

          expect(s.invalidated).toBe(true)
          expect(fired).toEqual(["invalidated"])
        } finally {
          clear(s)
        }
      },
    })
  })

  test("cancels timer when a session becomes busy", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fired: string[] = []
        const s = makeIdleTimer(tmp.path, () => fired.push("invalidated"), 200)

        try {
          // All idle → timer starts
          await SessionStatus.set("s1" as any, { type: "idle" })
          await Bun.sleep(10)
          expect(s.timer).toBeDefined()

          // Session goes busy → timer cancelled
          await SessionStatus.set("s1" as any, { type: "busy" })
          await Bun.sleep(10)
          expect(s.timer).toBeUndefined()

          // Wait past original delay — should NOT have fired
          await Bun.sleep(250)
          expect(s.invalidated).toBe(false)
          expect(fired).toEqual([])
        } finally {
          clear(s)
        }
      },
    })
  })

  test("does not start duplicate timers on repeated idle events", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        let count = 0
        const s = makeIdleTimer(tmp.path, () => count++, 200)

        try {
          // Multiple idle events
          await SessionStatus.set("s1" as any, { type: "idle" })
          await Bun.sleep(5)
          const first = s.timer

          await SessionStatus.set("s2" as any, { type: "idle" })
          await Bun.sleep(5)

          // Same timer handle — no duplicate
          expect(s.timer).toBe(first)

          await Bun.sleep(250)
          expect(count).toBe(1)
        } finally {
          clear(s)
        }
      },
    })
  })

  test("starts timer when already idle at subscribe time", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fired: string[] = []
        await SessionStatus.set("s1" as any, { type: "idle" })
        const s = makeIdleTimer(tmp.path, () => fired.push("invalidated"), 50)

        try {
          await Bun.sleep(10)
          expect(s.timer).toBeDefined()
          expect(s.invalidated).toBe(false)

          await Bun.sleep(100)
          expect(s.invalidated).toBe(true)
          expect(fired).toEqual(["invalidated"])
        } finally {
          clear(s)
        }
      },
    })
  })

  test("does not duplicate timer when subscribe starts idle then idle event arrives", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        let count = 0
        await SessionStatus.set("s1" as any, { type: "idle" })
        const s = makeIdleTimer(tmp.path, () => count++, 200)

        try {
          await Bun.sleep(10)
          const first = s.timer
          expect(first).toBeDefined()

          await SessionStatus.set("s2" as any, { type: "idle" })
          await Bun.sleep(10)
          expect(s.timer).toBe(first)

          await Bun.sleep(250)
          expect(count).toBe(1)
        } finally {
          clear(s)
        }
      },
    })
  })

  test("restarts timer after busy→idle cycle", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fired: string[] = []
        const s = makeIdleTimer(tmp.path, () => fired.push("invalidated"), 50)

        try {
          // First idle → timer starts
          await SessionStatus.set("s1" as any, { type: "idle" })
          await Bun.sleep(10)
          expect(s.timer).toBeDefined()

          // Goes busy → timer cancelled
          await SessionStatus.set("s1" as any, { type: "busy" })
          await Bun.sleep(10)
          expect(s.timer).toBeUndefined()

          // Goes idle again → new timer
          await SessionStatus.set("s1" as any, { type: "idle" })
          await Bun.sleep(10)
          expect(s.timer).toBeDefined()

          // Wait for it to fire
          await Bun.sleep(100)
          expect(s.invalidated).toBe(true)
          expect(fired).toEqual(["invalidated"])
        } finally {
          clear(s)
        }
      },
    })
  })

  test("unsub cleans up subscription and pending timer", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fired: string[] = []
        const s = makeIdleTimer(tmp.path, () => fired.push("invalidated"), 50)

        // Start timer
        await SessionStatus.set("s1" as any, { type: "idle" })
        await Bun.sleep(10)
        expect(s.timer).toBeDefined()

        // Dispose (mirrors Effect.addFinalizer)
        clear(s)

        // Timer should be gone and invalidate never called
        await Bun.sleep(100)
        expect(fired).toEqual([])
      },
    })
  })

  test("no timer started when a session is busy at idle event time", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const fired: string[] = []
        const s = makeIdleTimer(tmp.path, () => fired.push("invalidated"), 50)

        try {
          // s2 is busy while s1 goes idle
          await SessionStatus.set("s2" as any, { type: "busy" })
          await SessionStatus.set("s1" as any, { type: "idle" })
          await Bun.sleep(10)

          // s1 idle event fires but s2 is still busy → no timer
          expect(s.timer).toBeUndefined()

          await Bun.sleep(100)
          expect(fired).toEqual([])
        } finally {
          clear(s)
          // clean up busy session
          await SessionStatus.set("s2" as any, { type: "idle" })
        }
      },
    })
  })
})
