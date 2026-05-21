// [fork-perf] Phase 4 tests: snapshot gate
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SnapshotGate } from "../../src/session/snapshot-gate"
import type { Snapshot } from "../../src/snapshot"

// Minimal mock for Snapshot.Interface
function mockSnapshot(opts?: { trackReturns?: string | undefined; patchFiles?: string[] }) {
  let trackCallCount = 0
  let patchCallCount = 0
  const svc: Snapshot.Interface = {
    init: () => Effect.void,
    cleanup: () => Effect.void,
    track: () => {
      trackCallCount++
      return Effect.succeed(opts?.trackReturns ?? "hash_abc")
    },
    patch: (_hash: string) => {
      patchCallCount++
      return Effect.succeed({ hash: "patch_hash", files: opts?.patchFiles ?? ["file.ts"] })
    },
    restore: () => Effect.void,
    revert: () => Effect.void,
    diff: () => Effect.succeed(""),
    diffFull: () => Effect.succeed([]),
  }
  return { svc, getTrackCount: () => trackCallCount, getPatchCount: () => patchCallCount }
}

function makeCtx(overrides?: Partial<SnapshotGate.RunStateLike>): SnapshotGate.RunStateLike {
  return {
    fsToolFired: false,
    snapshot: undefined,
    lastSnapshotAt: undefined,
    ...overrides,
  }
}

describe("SnapshotGate.onToolCall", () => {
  test("sets fsToolFired for FS tools", () => {
    const ctx = makeCtx()
    SnapshotGate.onToolCall(ctx, "edit")
    expect(ctx.fsToolFired).toBe(true)
  })

  test("sets fsToolFired for all FS_TOOLS members", () => {
    for (const tool of ["edit", "write", "bash", "patch", "multiedit"]) {
      const ctx = makeCtx()
      SnapshotGate.onToolCall(ctx, tool)
      expect(ctx.fsToolFired).toBe(true)
    }
  })

  test("does not set fsToolFired for read-only tools", () => {
    const ctx = makeCtx()
    SnapshotGate.onToolCall(ctx, "read")
    SnapshotGate.onToolCall(ctx, "grep")
    SnapshotGate.onToolCall(ctx, "glob")
    expect(ctx.fsToolFired).toBe(false)
  })

  test("remains true once set (3 grep + 1 edit)", () => {
    const ctx = makeCtx()
    SnapshotGate.onToolCall(ctx, "grep")
    SnapshotGate.onToolCall(ctx, "grep")
    SnapshotGate.onToolCall(ctx, "read")
    expect(ctx.fsToolFired).toBe(false)
    SnapshotGate.onToolCall(ctx, "edit")
    expect(ctx.fsToolFired).toBe(true)
  })
})

describe("SnapshotGate.track", () => {
  test("flag=false: always delegates to snapshot.track()", async () => {
    const { svc, getTrackCount } = mockSnapshot()
    const ctx = makeCtx({ fsToolFired: false, snapshot: "existing" })
    await Effect.runPromise(SnapshotGate.track(ctx, svc, false))
    expect(getTrackCount()).toBe(1)
  })

  test("flag=true: skips track() when snapshot exists and no FS tool fired", async () => {
    const { svc, getTrackCount } = mockSnapshot()
    const ctx = makeCtx({ fsToolFired: false, snapshot: "existing" })
    const result = await Effect.runPromise(SnapshotGate.track(ctx, svc, true))
    expect(getTrackCount()).toBe(0)
    // returns existing snapshot unchanged
    expect(result).toBe("existing")
  })

  test("flag=true: calls track() when no snapshot yet (first step)", async () => {
    const { svc, getTrackCount } = mockSnapshot({ trackReturns: "new_hash" })
    const ctx = makeCtx({ fsToolFired: false, snapshot: undefined })
    const result = await Effect.runPromise(SnapshotGate.track(ctx, svc, true))
    expect(getTrackCount()).toBe(1)
    expect(result).toBe("new_hash")
  })

  test("flag=true: calls track() when FS tool fired", async () => {
    const { svc, getTrackCount } = mockSnapshot({ trackReturns: "new_hash" })
    const ctx = makeCtx({ fsToolFired: true, snapshot: "existing" })
    const result = await Effect.runPromise(SnapshotGate.track(ctx, svc, true))
    expect(getTrackCount()).toBe(1)
    expect(result).toBe("new_hash")
  })
})

describe("SnapshotGate.patch", () => {
  test("flag=false: always delegates to snapshot.patch()", async () => {
    const { svc, getPatchCount } = mockSnapshot()
    const ctx = makeCtx({ fsToolFired: false, snapshot: "hash" })
    await Effect.runPromise(SnapshotGate.patch(ctx, svc, false))
    expect(getPatchCount()).toBe(1)
  })

  test("flag=false: returns undefined when no snapshot", async () => {
    const { svc, getPatchCount } = mockSnapshot()
    const ctx = makeCtx({ fsToolFired: false, snapshot: undefined })
    const result = await Effect.runPromise(SnapshotGate.patch(ctx, svc, false))
    expect(result).toBeUndefined()
    expect(getPatchCount()).toBe(0)
  })

  test("pure-read step: patch returns undefined, no patch() call", async () => {
    const { svc, getPatchCount } = mockSnapshot()
    const ctx = makeCtx({ fsToolFired: false, snapshot: "hash" })
    // simulate 3 grep + 1 read
    SnapshotGate.onToolCall(ctx, "grep")
    SnapshotGate.onToolCall(ctx, "grep")
    SnapshotGate.onToolCall(ctx, "grep")
    SnapshotGate.onToolCall(ctx, "read")
    const result = await Effect.runPromise(SnapshotGate.patch(ctx, svc, true))
    expect(result).toBeUndefined()
    expect(getPatchCount()).toBe(0)
  })

  test("mixed step (read + edit): exactly 1 patch() call", async () => {
    const { svc, getPatchCount } = mockSnapshot({ patchFiles: ["src/foo.ts"] })
    const ctx = makeCtx({ fsToolFired: false, snapshot: "hash" })
    SnapshotGate.onToolCall(ctx, "read")
    SnapshotGate.onToolCall(ctx, "edit")
    const result = await Effect.runPromise(SnapshotGate.patch(ctx, svc, true))
    expect(getPatchCount()).toBe(1)
    expect(result?.files).toEqual(["src/foo.ts"])
  })

  test("multiple FS tools in same step: fsToolFired stays true; patch fires once", async () => {
    const { svc, getPatchCount } = mockSnapshot()
    const ctx = makeCtx({ fsToolFired: false, snapshot: "hash" })
    SnapshotGate.onToolCall(ctx, "edit")
    SnapshotGate.onToolCall(ctx, "write")
    SnapshotGate.onToolCall(ctx, "bash")
    const result = await Effect.runPromise(SnapshotGate.patch(ctx, svc, true))
    expect(getPatchCount()).toBe(1)
    expect(result).toBeDefined()
    // fsToolFired reset after patch
    expect(ctx.fsToolFired).toBe(false)
  })

  test("after patch, fsToolFired is reset so next step starts clean", async () => {
    const { svc } = mockSnapshot()
    const ctx = makeCtx({ fsToolFired: false, snapshot: "hash" })
    SnapshotGate.onToolCall(ctx, "edit")
    await Effect.runPromise(SnapshotGate.patch(ctx, svc, true))
    expect(ctx.fsToolFired).toBe(false)
  })

  test("patch returns undefined when no snapshot regardless of fsToolFired", async () => {
    const { svc, getPatchCount } = mockSnapshot()
    const ctx = makeCtx({ fsToolFired: true, snapshot: undefined })
    const result = await Effect.runPromise(SnapshotGate.patch(ctx, svc, true))
    expect(result).toBeUndefined()
    expect(getPatchCount()).toBe(0)
  })

  test("second patch site (sliding-window cleanup path) is symmetric with first", async () => {
    // Both patch sites use the same SnapshotGate.patch call with the same ctx;
    // this tests that calling patch twice with fsToolFired=false on second call returns undefined
    const { svc, getPatchCount } = mockSnapshot()
    const ctx = makeCtx({ fsToolFired: false, snapshot: "hash" })
    // First site (finish-step): FS tool fired
    SnapshotGate.onToolCall(ctx, "edit")
    const p1 = await Effect.runPromise(SnapshotGate.patch(ctx, svc, true))
    expect(p1).toBeDefined()
    expect(getPatchCount()).toBe(1)
    // After first patch, fsToolFired is reset
    // Second site (cleanup): no new FS tool fired
    ctx.snapshot = "hash2"
    const p2 = await Effect.runPromise(SnapshotGate.patch(ctx, svc, true))
    expect(p2).toBeUndefined()
    expect(getPatchCount()).toBe(1) // no second patch call
  })
})
