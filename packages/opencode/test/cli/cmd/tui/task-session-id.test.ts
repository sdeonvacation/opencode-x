import { beforeEach, describe, expect, test } from "bun:test"
import {
  resolveTaskSessionId,
  type MinimalSession,
  type MinimalToolPart,
  type ResolveTaskSessionIdArgs,
} from "../../../../src/cli/cmd/tui/routes/session/task-session-id"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePart(id: string, sessionID: string, startTime?: number): MinimalToolPart {
  return {
    id,
    type: "tool",
    tool: "task",
    sessionID,
    state: startTime !== undefined ? { time: { start: startTime } } : {},
  }
}

function makeSession(id: string, parentID: string): MinimalSession {
  return { id, parentID }
}

function makeArgs(overrides: Partial<ResolveTaskSessionIdArgs> = {}): ResolveTaskSessionIdArgs {
  return {
    partId: "prt_1",
    metadataSessionId: undefined,
    cache: new Map(),
    partState: {},
    syncDataSession: [],
    syncDataPart: {},
    parentSessionID: "ses_parent",
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveTaskSessionId", () => {
  // --- Tier 1: authoritative metadata ---

  describe("tier 1 — metadata sessionId", () => {
    test("returns metadataSessionId when present", () => {
      const args = makeArgs({ metadataSessionId: "ses_abc" })
      expect(resolveTaskSessionId(args)).toBe("ses_abc")
    })

    test("populates cache with metadataSessionId", () => {
      const cache = new Map<string, string>()
      const args = makeArgs({ partId: "prt_1", metadataSessionId: "ses_abc", cache })
      resolveTaskSessionId(args)
      expect(cache.get("prt_1")).toBe("ses_abc")
    })

    test("ignores cache and fallback when metadataSessionId is present", () => {
      const cache = new Map([["prt_1", "ses_stale"]])
      const args = makeArgs({ metadataSessionId: "ses_fresh", cache })
      expect(resolveTaskSessionId(args)).toBe("ses_fresh")
    })
  })

  // --- Tier 2: cache ---

  describe("tier 2 — cache hit", () => {
    test("returns cached value when metadata is absent", () => {
      const cache = new Map([["prt_1", "ses_cached"]])
      const args = makeArgs({ cache })
      expect(resolveTaskSessionId(args)).toBe("ses_cached")
    })

    test("does not touch syncData when cache hits", () => {
      const cache = new Map([["prt_1", "ses_cached"]])
      // syncDataSession and syncDataPart are deliberately empty — if fallback
      // were consulted it would return undefined
      const args = makeArgs({ cache, syncDataSession: [], syncDataPart: {} })
      expect(resolveTaskSessionId(args)).toBe("ses_cached")
    })
  })

  // --- Tier 3: time-ordered index fallback ---

  describe("tier 3 — time-ordered index fallback", () => {
    test("returns undefined when partState has no time.start", () => {
      const args = makeArgs({ partState: {} })
      expect(resolveTaskSessionId(args)).toBeUndefined()
    })

    test("returns undefined when there are no child sessions", () => {
      const args = makeArgs({
        partId: "prt_1",
        partState: { time: { start: 100 } },
        syncDataSession: [],
        syncDataPart: {
          msg1: [makePart("prt_1", "ses_parent", 100)],
        },
      })
      expect(resolveTaskSessionId(args)).toBeUndefined()
    })

    test("maps first task part to first child session (single subagent)", () => {
      const args = makeArgs({
        partId: "prt_1",
        partState: { time: { start: 100 } },
        syncDataSession: [makeSession("ses_child_1", "ses_parent")],
        syncDataPart: {
          msg1: [makePart("prt_1", "ses_parent", 100)],
        },
      })
      expect(resolveTaskSessionId(args)).toBe("ses_child_1")
    })

    test("maps second task part to second child session (multiple subagents)", () => {
      // Two task parts started at different times; two child sessions.
      // prt_2 started later → index 1 → ses_child_2
      const args = makeArgs({
        partId: "prt_2",
        partState: { time: { start: 200 } },
        syncDataSession: [makeSession("ses_child_1", "ses_parent"), makeSession("ses_child_2", "ses_parent")],
        syncDataPart: {
          msg1: [makePart("prt_1", "ses_parent", 100)],
          msg2: [makePart("prt_2", "ses_parent", 200)],
        },
      })
      expect(resolveTaskSessionId(args)).toBe("ses_child_2")
    })

    test("ignores task parts belonging to other sessions", () => {
      // prt_other belongs to a sibling session, should not affect index
      const args = makeArgs({
        partId: "prt_1",
        partState: { time: { start: 100 } },
        syncDataSession: [makeSession("ses_child_1", "ses_parent")],
        syncDataPart: {
          msg1: [makePart("prt_1", "ses_parent", 100)],
          msgX: [makePart("prt_other", "ses_sibling", 50)],
        },
      })
      expect(resolveTaskSessionId(args)).toBe("ses_child_1")
    })

    test("returns undefined when part index exceeds child session count", () => {
      // Only 1 child session but 2 task parts — second part has no match
      const args = makeArgs({
        partId: "prt_2",
        partState: { time: { start: 200 } },
        syncDataSession: [makeSession("ses_child_1", "ses_parent")],
        syncDataPart: {
          msg1: [makePart("prt_1", "ses_parent", 100)],
          msg2: [makePart("prt_2", "ses_parent", 200)],
        },
      })
      expect(resolveTaskSessionId(args)).toBeUndefined()
    })

    test("populates cache on successful fallback resolution", () => {
      const cache = new Map<string, string>()
      const args = makeArgs({
        partId: "prt_1",
        cache,
        partState: { time: { start: 100 } },
        syncDataSession: [makeSession("ses_child_1", "ses_parent")],
        syncDataPart: {
          msg1: [makePart("prt_1", "ses_parent", 100)],
        },
      })
      resolveTaskSessionId(args)
      expect(cache.get("prt_1")).toBe("ses_child_1")
    })
  })

  // --- Cache persistence across calls ---

  describe("cache persistence (simulates unmount/remount)", () => {
    let cache: Map<string, string>

    beforeEach(() => {
      cache = new Map()
    })

    test("cached value from tier-1 call is returned on subsequent tier-2 call", () => {
      // First call: metadata present → populates cache
      resolveTaskSessionId(makeArgs({ partId: "prt_1", metadataSessionId: "ses_abc", cache }))

      // Second call: metadata absent (simulates remount) → cache hit
      const result = resolveTaskSessionId(makeArgs({ partId: "prt_1", cache }))
      expect(result).toBe("ses_abc")
    })

    test("cached value from tier-3 call is returned on subsequent tier-2 call", () => {
      const syncDataSession = [makeSession("ses_child_1", "ses_parent")]
      const syncDataPart = { msg1: [makePart("prt_1", "ses_parent", 100)] }

      // First call: no metadata, uses fallback → populates cache
      resolveTaskSessionId(
        makeArgs({ partId: "prt_1", cache, partState: { time: { start: 100 } }, syncDataSession, syncDataPart }),
      )

      // Second call: no metadata, no syncData → pure cache hit
      const result = resolveTaskSessionId(makeArgs({ partId: "prt_1", cache }))
      expect(result).toBe("ses_child_1")
    })
  })
})
