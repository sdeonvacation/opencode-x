import { describe, expect, test } from "bun:test"
import { Database } from "../../src/storage/db"
import { SessionTable } from "../../src/session/session.sql"
import { ProjectTable } from "../../src/project/project.sql"
import { Loop } from "../../src/loop/loop"
import { SessionID } from "../../src/session/schema"
import { ProjectID } from "../../src/project/schema"
import { eq } from "drizzle-orm"
import { Log } from "../../src/util/log"

Log.init({ print: false })

const PROJECT = ProjectID.make("proj_sched_test_" + Date.now())

function uid() {
  return SessionID.make(crypto.randomUUID())
}

function setupSession(id: SessionID, tokens?: { input: number; output: number; reasoning: number }) {
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
        tokens_input: tokens?.input ?? 0,
        tokens_output: tokens?.output ?? 0,
        tokens_reasoning: tokens?.reasoning ?? 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
      })
      .onConflictDoNothing()
      .run(),
  )
}

describe("scheduler token tracking", () => {
  test("reads session tokens after population", () => {
    const sessionID = uid()
    const subSessionID = uid()
    setupSession(sessionID)
    setupSession(subSessionID, { input: 1500, output: 800, reasoning: 200 })

    // Simulate what scheduler does after wait completes:
    // read tokens from subagent session
    const sessions = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, subSessionID)).all())
    const s = sessions[0]
    const tokens = s ? s.tokens_input + s.tokens_output + s.tokens_reasoning : 0

    expect(tokens).toBe(2500)
  })

  test("returns 0 tokens when session not found", () => {
    const missingID = uid()
    const sessions = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, missingID)).all())
    const s = sessions[0]
    const tokens = s ? s.tokens_input + s.tokens_output + s.tokens_reasoning : 0

    expect(tokens).toBe(0)
  })

  test("tickComplete records tokens from session correctly", () => {
    const sessionID = uid()
    const subSessionID = uid()
    setupSession(sessionID)
    setupSession(subSessionID, { input: 3000, output: 1000, reasoning: 500 })

    const loop = Loop.create({ sessionID, prompt: "token test", intervalMs: 60_000, tokenBudget: 10_000 })

    // Read tokens same way scheduler does
    const sessions = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, subSessionID)).all())
    const s = sessions[0]
    const tokens = s ? s.tokens_input + s.tokens_output + s.tokens_reasoning : 0

    const updated = Loop.tickComplete({ id: loop.id, tokens, sessionID: subSessionID as string })

    expect(updated.tokens_used).toBe(4500)
    expect(updated.iteration_count).toBe(1)
    expect(updated.last_subagent_session_id).toBe(subSessionID as string)
  })

  test("session with zero tokens before completion gives 0", () => {
    const subSessionID = uid()
    setupSession(subSessionID, { input: 0, output: 0, reasoning: 0 })

    const sessions = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, subSessionID)).all())
    const s = sessions[0]
    const tokens = s ? s.tokens_input + s.tokens_output + s.tokens_reasoning : 0

    expect(tokens).toBe(0)
  })

  test("budget exhaustion triggered by token sum from session", () => {
    const sessionID = uid()
    const subSessionID = uid()
    setupSession(sessionID)
    setupSession(subSessionID, { input: 4000, output: 1500, reasoning: 500 })

    const loop = Loop.create({ sessionID, prompt: "budget", intervalMs: 60_000, tokenBudget: 5000 })

    const sessions = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, subSessionID)).all())
    const s = sessions[0]
    const tokens = s ? s.tokens_input + s.tokens_output + s.tokens_reasoning : 0

    const updated = Loop.tickComplete({ id: loop.id, tokens, sessionID: subSessionID as string })

    // 6000 > 5000 budget → exhausted
    expect(updated.status).toBe("budget_exhausted")
    expect(updated.tokens_used).toBe(6000)
  })
})
