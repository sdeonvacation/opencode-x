import { describe, expect, test } from "bun:test"
import { Database } from "../../src/storage/db"
import { SessionTable } from "../../src/session/session.sql"
import { ProjectTable } from "../../src/project/project.sql"
import { Loop } from "../../src/loop/loop"
import { LoopID } from "../../src/loop/schema"
import { SessionID } from "../../src/session/schema"
import { ProjectID } from "../../src/project/schema"
import { Log } from "../../src/util/log"

Log.init({ print: false })

const PROJECT = ProjectID.make("proj_loop_test_" + Date.now())

function uid() {
  return SessionID.make(crypto.randomUUID())
}

function setupSession(id: SessionID) {
  Database.use((db) =>
    db
      .insert(ProjectTable)
      .values({
        id: PROJECT,
        worktree: "/tmp",
        time_created: Date.now(),
        time_updated: Date.now(),
        sandboxes: [],
      })
      .onConflictDoNothing()
      .run(),
  )
  Database.use((db) =>
    db
      .insert(SessionTable)
      .values({
        id,
        project_id: PROJECT,
        parent_id: null,
        slug: id as string,
        directory: "/tmp",
        title: "test",
        version: "1",
        time_created: Date.now(),
        time_updated: Date.now(),
        cost: 0,
        tokens_input: 0,
        tokens_output: 0,
        tokens_reasoning: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
      })
      .onConflictDoNothing()
      .run(),
  )
}

describe("LoopID", () => {
  test("generate produces prefixed id", () => {
    const id = LoopID.generate()
    expect(id).toMatch(/^loop_/)
  })

  test("make casts string", () => {
    const id = LoopID.make("loop_abc")
    expect(id).toBe("loop_abc" as unknown as LoopID)
  })

  test("zod validates prefix", () => {
    const result = LoopID.zod.safeParse("loop_test123")
    expect(result.success).toBe(true)
  })

  test("zod rejects invalid prefix", () => {
    const result = LoopID.zod.safeParse("bad_prefix")
    expect(result.success).toBe(false)
  })
})

describe("Loop.create", () => {
  test("creates loop with correct fields", () => {
    const sessionID = uid()
    setupSession(sessionID)

    const loop = Loop.create({
      sessionID,
      prompt: "check status",
      intervalMs: 60_000,
    })

    expect(loop.id).toMatch(/^loop_/)
    expect(loop.session_id).toBe(sessionID)
    expect(loop.prompt).toBe("check status")
    expect(loop.interval_ms).toBe(60_000)
    expect(loop.status).toBe("active")
    expect(loop.model).toBeNull()
    expect(loop.token_budget).toBeNull()
    expect(loop.tokens_used).toBe(0)
    expect(loop.iteration_count).toBe(0)
    expect(loop.last_run_at).toBeNull()
    expect(loop.last_subagent_session_id).toBeNull()
    expect(loop.next_run_at).toBeGreaterThan(Date.now() - 1000)
    expect(loop.expires_at).toBeGreaterThan(Date.now())
  })

  test("creates loop with model and budget", () => {
    const sessionID = uid()
    setupSession(sessionID)

    const loop = Loop.create({
      sessionID,
      prompt: "test",
      intervalMs: 120_000,
      model: "gpt-4o",
      tokenBudget: 100_000,
    })

    expect(loop.model).toBe("gpt-4o")
    expect(loop.token_budget).toBe(100_000)
  })

  test("sets next_run_at to now + intervalMs", () => {
    const sessionID = uid()
    setupSession(sessionID)

    const before = Date.now()
    const loop = Loop.create({ sessionID, prompt: "x", intervalMs: 300_000 })
    const after = Date.now()

    expect(loop.next_run_at).toBeGreaterThanOrEqual(before + 300_000)
    expect(loop.next_run_at).toBeLessThanOrEqual(after + 300_000)
  })

  test("sets expires_at to 7 days from now", () => {
    const sessionID = uid()
    setupSession(sessionID)

    const before = Date.now()
    const loop = Loop.create({ sessionID, prompt: "x", intervalMs: 60_000 })
    const sevenDays = 7 * 24 * 60 * 60 * 1000

    expect(loop.expires_at).toBeGreaterThanOrEqual(before + sevenDays)
    expect(loop.expires_at).toBeLessThanOrEqual(Date.now() + sevenDays)
  })

  test("throws when max loops exceeded", () => {
    const sessionID = uid()
    setupSession(sessionID)

    for (let i = 0; i < 20; i++) {
      Loop.create({ sessionID, prompt: `loop ${i}`, intervalMs: 60_000 })
    }

    expect(() => Loop.create({ sessionID, prompt: "overflow", intervalMs: 60_000 })).toThrow(
      "Maximum of 20 loops per session reached",
    )
  })
})

describe("Loop.get", () => {
  test("returns loop by id", () => {
    const sessionID = uid()
    setupSession(sessionID)

    const created = Loop.create({ sessionID, prompt: "get test", intervalMs: 60_000 })
    const found = Loop.get(created.id)

    expect(found).not.toBeNull()
    expect(found!.id).toBe(created.id)
    expect(found!.prompt).toBe("get test")
  })

  test("returns null for unknown id", () => {
    const result = Loop.get(LoopID.make("loop_nonexistent"))
    expect(result).toBeNull()
  })
})

describe("Loop.list", () => {
  test("returns all loops for session", () => {
    const sessionID = uid()
    setupSession(sessionID)

    Loop.create({ sessionID, prompt: "a", intervalMs: 60_000 })
    Loop.create({ sessionID, prompt: "b", intervalMs: 120_000 })

    const loops = Loop.list(sessionID)
    expect(loops.length).toBe(2)
  })

  test("does not return loops from other sessions", () => {
    const s1 = uid()
    const s2 = uid()
    setupSession(s1)
    setupSession(s2)

    Loop.create({ sessionID: s1, prompt: "s1", intervalMs: 60_000 })
    Loop.create({ sessionID: s2, prompt: "s2", intervalMs: 60_000 })

    const loops = Loop.list(s1)
    expect(loops.length).toBe(1)
    expect(loops[0].prompt).toBe("s1")
  })
})

describe("Loop.listDue", () => {
  test("returns active loops past next_run_at", () => {
    const sessionID = uid()
    setupSession(sessionID)

    const loop = Loop.create({ sessionID, prompt: "due", intervalMs: 60_000 })
    // Query with time in the future
    const due = Loop.listDue(loop.next_run_at + 1000)
    expect(due.some((l) => l.id === loop.id)).toBe(true)
  })

  test("does not return loops not yet due", () => {
    const sessionID = uid()
    setupSession(sessionID)

    const loop = Loop.create({ sessionID, prompt: "not due", intervalMs: 60_000 })
    const due = Loop.listDue(loop.next_run_at - 1000)
    expect(due.some((l) => l.id === loop.id)).toBe(false)
  })

  test("does not return paused loops", () => {
    const sessionID = uid()
    setupSession(sessionID)

    const loop = Loop.create({ sessionID, prompt: "paused", intervalMs: 60_000 })
    Loop.pause({ id: loop.id })
    const due = Loop.listDue(loop.next_run_at + 1000)
    expect(due.some((l) => l.id === loop.id)).toBe(false)
  })
})

describe("Loop.tick", () => {
  test("updates last_subagent_session_id", () => {
    const sessionID = uid()
    setupSession(sessionID)

    const loop = Loop.create({ sessionID, prompt: "tick", intervalMs: 60_000 })
    const updated = Loop.tick({ id: loop.id, subagentSessionID: "sub_123" })

    expect(updated.last_subagent_session_id).toBe("sub_123")
  })

  test("throws for unknown loop", () => {
    expect(() => Loop.tick({ id: LoopID.make("loop_missing"), subagentSessionID: "x" })).toThrow("Loop not found")
  })
})

describe("Loop.tickComplete", () => {
  test("increments iteration_count and tokens_used", () => {
    const sessionID = uid()
    setupSession(sessionID)

    const loop = Loop.create({ sessionID, prompt: "complete", intervalMs: 60_000 })
    const updated = Loop.tickComplete({ id: loop.id, tokens: 500, sessionID: "sub_1" })

    expect(updated.iteration_count).toBe(1)
    expect(updated.tokens_used).toBe(500)
    expect(updated.last_run_at).not.toBeNull()
    expect(updated.last_subagent_session_id).toBe("sub_1")
  })

  test("accumulates tokens across ticks", () => {
    const sessionID = uid()
    setupSession(sessionID)

    const loop = Loop.create({ sessionID, prompt: "accumulate", intervalMs: 60_000 })
    Loop.tickComplete({ id: loop.id, tokens: 100, sessionID: "sub_1" })
    const updated = Loop.tickComplete({ id: loop.id, tokens: 200, sessionID: "sub_2" })

    expect(updated.iteration_count).toBe(2)
    expect(updated.tokens_used).toBe(300)
  })

  test("adds jitter to next_run_at", () => {
    const sessionID = uid()
    setupSession(sessionID)

    const loop = Loop.create({ sessionID, prompt: "jitter", intervalMs: 60_000 })
    const before = Date.now()
    const updated = Loop.tickComplete({ id: loop.id, tokens: 50, sessionID: "sub_1" })

    // next_run_at should be at least now + interval
    expect(updated.next_run_at).toBeGreaterThanOrEqual(before + 60_000)
    // jitter max is min(6000, 300000) = 6000 for 60s interval
    expect(updated.next_run_at).toBeLessThanOrEqual(Date.now() + 60_000 + 6000)
  })

  test("triggers budget_exhausted when budget exceeded", () => {
    const sessionID = uid()
    setupSession(sessionID)

    const loop = Loop.create({ sessionID, prompt: "budget", intervalMs: 60_000, tokenBudget: 1000 })
    const updated = Loop.tickComplete({ id: loop.id, tokens: 1000, sessionID: "sub_1" })

    expect(updated.status).toBe("budget_exhausted")
  })

  test("throws for unknown loop", () => {
    expect(() => Loop.tickComplete({ id: LoopID.make("loop_missing"), tokens: 100, sessionID: "x" })).toThrow(
      "Loop not found",
    )
  })
})

describe("Loop.pause", () => {
  test("sets status to paused", () => {
    const sessionID = uid()
    setupSession(sessionID)

    const loop = Loop.create({ sessionID, prompt: "pause me", intervalMs: 60_000 })
    const paused = Loop.pause({ id: loop.id })

    expect(paused.status).toBe("paused")
  })

  test("throws for unknown loop", () => {
    expect(() => Loop.pause({ id: LoopID.make("loop_missing") })).toThrow("Loop not found")
  })
})

describe("Loop.resume", () => {
  test("sets status to active and updates next_run_at", () => {
    const sessionID = uid()
    setupSession(sessionID)

    const loop = Loop.create({ sessionID, prompt: "resume me", intervalMs: 120_000 })
    Loop.pause({ id: loop.id })

    const before = Date.now()
    const resumed = Loop.resume({ id: loop.id })

    expect(resumed.status).toBe("active")
    expect(resumed.next_run_at).toBeGreaterThanOrEqual(before + 120_000)
  })

  test("throws for unknown loop", () => {
    expect(() => Loop.resume({ id: LoopID.make("loop_missing") })).toThrow("Loop not found")
  })
})

describe("Loop.cancel", () => {
  test("sets status to cancelled", () => {
    const sessionID = uid()
    setupSession(sessionID)

    const loop = Loop.create({ sessionID, prompt: "cancel me", intervalMs: 60_000 })
    const cancelled = Loop.cancel({ id: loop.id })

    expect(cancelled.status).toBe("cancelled")
  })

  test("throws for unknown loop", () => {
    expect(() => Loop.cancel({ id: LoopID.make("loop_missing") })).toThrow("Loop not found")
  })
})

describe("Loop.expire", () => {
  test("sets status to expired", () => {
    const sessionID = uid()
    setupSession(sessionID)

    const loop = Loop.create({ sessionID, prompt: "expire me", intervalMs: 60_000 })
    const expired = Loop.expire({ id: loop.id })

    expect(expired.status).toBe("expired")
  })

  test("throws for unknown loop", () => {
    expect(() => Loop.expire({ id: LoopID.make("loop_missing") })).toThrow("Loop not found")
  })
})

describe("Loop.budgetExhaust", () => {
  test("sets status to budget_exhausted", () => {
    const sessionID = uid()
    setupSession(sessionID)

    const loop = Loop.create({ sessionID, prompt: "exhaust", intervalMs: 60_000, tokenBudget: 5000 })
    const exhausted = Loop.budgetExhaust({ id: loop.id })

    expect(exhausted.status).toBe("budget_exhausted")
  })

  test("throws for unknown loop", () => {
    expect(() => Loop.budgetExhaust({ id: LoopID.make("loop_missing") })).toThrow("Loop not found")
  })
})
