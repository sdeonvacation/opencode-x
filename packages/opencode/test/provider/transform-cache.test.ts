import { afterEach, describe, expect, test } from "bun:test"
import { TransformCache } from "../../src/provider/transform-cache"

afterEach(() => {
  // Reset module-level cache between tests.
  TransformCache._reset()
})

const keyA: TransformCache.Key = { modelID: "claude-3", toolHash: "abc123", sessionID: "sess-1" }
const keyB: TransformCache.Key = { modelID: "claude-3", toolHash: "def456", sessionID: "sess-1" }
const keyC: TransformCache.Key = { modelID: "gpt-4", toolHash: "abc123", sessionID: "sess-1" }

describe("TransformCache.memo", () => {
  test("miss: calls fn and returns its value", () => {
    let calls = 0
    const result = TransformCache.memo(keyA, () => {
      calls++
      return "computed"
    })
    expect(result).toBe("computed")
    expect(calls).toBe(1)
  })

  test("hit: returns cached value without calling fn again", () => {
    let calls = 0
    TransformCache.memo(keyA, () => { calls++; return "first" })
    const result = TransformCache.memo(keyA, () => { calls++; return "second" })
    expect(result).toBe("first")
    expect(calls).toBe(1)
  })

  test("different keys are cached independently", () => {
    const r1 = TransformCache.memo(keyA, () => "value-a")
    const r2 = TransformCache.memo(keyB, () => "value-b")
    expect(r1).toBe("value-a")
    expect(r2).toBe("value-b")
  })

  test("LRU eviction: recently-accessed entry survives, least-recently-used is evicted", () => {
    // Fill cache with 256 entries.
    for (let i = 0; i < 256; i++) {
      TransformCache.memo({ modelID: "m", toolHash: "h", sessionID: `sess-${i}` }, () => `val-${i}`)
    }

    // Access sess-0 to make it most-recently-used.
    TransformCache.memo({ modelID: "m", toolHash: "h", sessionID: "sess-0" }, () => "should-not-be-called")

    // Adding sess-256 triggers eviction of the LRU entry, which is now sess-1
    // (sess-0 was just promoted to tail).
    TransformCache.memo({ modelID: "m", toolHash: "h", sessionID: "sess-256" }, () => "val-256")

    // sess-0 should still be cached (it was recently accessed).
    let sess0Recalculated = false
    TransformCache.memo({ modelID: "m", toolHash: "h", sessionID: "sess-0" }, () => {
      sess0Recalculated = true
      return "recomputed-0"
    })
    expect(sess0Recalculated).toBe(false)

    // sess-1 should have been evicted (was LRU when sess-256 was inserted).
    let sess1Recalculated = false
    TransformCache.memo({ modelID: "m", toolHash: "h", sessionID: "sess-1" }, () => {
      sess1Recalculated = true
      return "recomputed-1"
    })
    expect(sess1Recalculated).toBe(true)
  })
})

describe("TransformCache.invalidate", () => {
  test("drops all entries matching modelID", () => {
    TransformCache.memo(keyA, () => "a")   // modelID: claude-3
    TransformCache.memo(keyB, () => "b")   // modelID: claude-3
    TransformCache.memo(keyC, () => "c")   // modelID: gpt-4

    TransformCache.invalidate("claude-3")

    let callsA = 0
    let callsC = 0
    TransformCache.memo(keyA, () => { callsA++; return "new-a" })
    TransformCache.memo(keyC, () => { callsC++; return "new-c" })

    // claude-3 entries were invalidated → fn is called
    expect(callsA).toBe(1)
    // gpt-4 entry was NOT invalidated → fn not called (cached)
    expect(callsC).toBe(0)
  })

  test("invalidate unknown modelID is a no-op", () => {
    TransformCache.memo(keyA, () => "a")
    expect(() => TransformCache.invalidate("unknown-model")).not.toThrow()

    // Original entry still cached
    let calls = 0
    TransformCache.memo(keyA, () => { calls++; return "new" })
    expect(calls).toBe(0)
  })
})

describe("TransformCache.hash", () => {
  test("same tool list → same hash", () => {
    expect(TransformCache.hash(["read", "bash", "edit"])).toBe(TransformCache.hash(["read", "bash", "edit"]))
  })

  test("order-independent (sorts before hashing)", () => {
    expect(TransformCache.hash(["bash", "read", "edit"])).toBe(TransformCache.hash(["edit", "bash", "read"]))
  })

  test("different tool lists → different hashes", () => {
    expect(TransformCache.hash(["read"])).not.toBe(TransformCache.hash(["bash"]))
  })

  test("empty list produces a consistent hash", () => {
    const h1 = TransformCache.hash([])
    const h2 = TransformCache.hash([])
    expect(h1).toBe(h2)
    expect(typeof h1).toBe("string")
  })
})
