import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { listSessionIds, getChildSessionIds, getTokenTotals, getSessionMeta } from "../../../src/plugin/insights/db"

function createTestDb(): Database {
  const db = new Database(":memory:")
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT 'proj1',
      workspace_id TEXT,
      parent_id TEXT,
      slug TEXT NOT NULL DEFAULT 'test',
      directory TEXT NOT NULL DEFAULT '/tmp/test',
      title TEXT NOT NULL DEFAULT 'Test Session',
      version TEXT NOT NULL DEFAULT '1',
      cost REAL NOT NULL DEFAULT 0,
      tokens_input INTEGER NOT NULL DEFAULT 0,
      tokens_output INTEGER NOT NULL DEFAULT 0,
      tokens_reasoning INTEGER NOT NULL DEFAULT 0,
      tokens_cache_read INTEGER NOT NULL DEFAULT 0,
      tokens_cache_write INTEGER NOT NULL DEFAULT 0,
      cost_by_model TEXT,
      time_created INTEGER NOT NULL DEFAULT 0,
      time_updated INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL DEFAULT 0,
      time_updated INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL DEFAULT 0,
      time_updated INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL
    );
  `)
  return db
}

function insertSession(
  db: Database,
  id: string,
  opts: {
    timeCreated?: number
    cost?: number
    tokensInput?: number
    tokensOutput?: number
    tokensReasoning?: number
    tokensCacheRead?: number
    tokensCacheWrite?: number
    parentId?: string
  } = {},
) {
  db.run(
    `INSERT INTO session (id, time_created, time_updated, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, parent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.timeCreated ?? 1000,
      (opts.timeCreated ?? 1000) + 60000,
      opts.cost ?? 0,
      opts.tokensInput ?? 0,
      opts.tokensOutput ?? 0,
      opts.tokensReasoning ?? 0,
      opts.tokensCacheRead ?? 0,
      opts.tokensCacheWrite ?? 0,
      opts.parentId ?? null,
    ],
  )
}

function insertMessage(db: Database, id: string, sessionId: string, role: string, timeCreated = 1000) {
  db.run(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`, [
    id,
    sessionId,
    timeCreated,
    timeCreated,
    JSON.stringify({ role }),
  ])
}

/**
 * Regression test: aggregateAll in orchestrator.ts uses different session sets
 * for cost vs tokens to avoid double-counting.
 *
 * - Cost: parent sessions only (parent.cost already includes rolled-up child costs)
 * - Tokens: all sessions (parent + child) because token counts are NOT rolled up
 * - Messages: all sessions (parent + child)
 */
describe("parent/child cost accounting (aggregateAll regression)", () => {
  function seedScenario(db: Database) {
    // Parent A: cost=10 (includes child costs already rolled up)
    insertSession(db, "parent_a", {
      cost: 10.0,
      tokensInput: 100,
      tokensOutput: 200,
      tokensReasoning: 50,
      tokensCacheRead: 10,
      tokensCacheWrite: 5,
    })
    // Child A1
    insertSession(db, "child_a1", {
      parentId: "parent_a",
      cost: 3.0,
      tokensInput: 50,
      tokensOutput: 100,
      tokensReasoning: 0,
      tokensCacheRead: 5,
      tokensCacheWrite: 2,
    })
    // Child A2
    insertSession(db, "child_a2", {
      parentId: "parent_a",
      cost: 4.0,
      tokensInput: 60,
      tokensOutput: 120,
      tokensReasoning: 0,
      tokensCacheRead: 8,
      tokensCacheWrite: 3,
    })
    // Parent B: cost=5 (includes child costs already rolled up)
    insertSession(db, "parent_b", {
      cost: 5.0,
      tokensInput: 80,
      tokensOutput: 150,
      tokensReasoning: 20,
      tokensCacheRead: 12,
      tokensCacheWrite: 4,
    })
    // Child B1
    insertSession(db, "child_b1", {
      parentId: "parent_b",
      cost: 2.0,
      tokensInput: 30,
      tokensOutput: 50,
      tokensReasoning: 0,
      tokensCacheRead: 3,
      tokensCacheWrite: 1,
    })

    // Messages: 2 per session (user + assistant)
    const sessions = ["parent_a", "child_a1", "child_a2", "parent_b", "child_b1"]
    for (const sid of sessions) {
      insertMessage(db, `${sid}_msg_user`, sid, "user", 1000)
      insertMessage(db, `${sid}_msg_asst`, sid, "assistant", 2000)
    }
  }

  test("listSessionIds excludes child sessions", () => {
    const db = createTestDb()
    seedScenario(db)

    const ids = listSessionIds(db, 0)
    expect(ids.sort()).toEqual(["parent_a", "parent_b"].sort())
    expect(ids).not.toContain("child_a1")
    expect(ids).not.toContain("child_a2")
    expect(ids).not.toContain("child_b1")
    db.close()
  })

  test("getChildSessionIds finds all children for given parents", () => {
    const db = createTestDb()
    seedScenario(db)

    const childIds = getChildSessionIds(db, ["parent_a", "parent_b"])
    expect(childIds.sort()).toEqual(["child_a1", "child_a2", "child_b1"].sort())
    db.close()
  })

  test("cost: sum parents only (already includes rolled-up child costs)", () => {
    const db = createTestDb()
    seedScenario(db)

    const parentIds = ["parent_a", "parent_b"]
    const costTotals = getTokenTotals(db, parentIds)

    // 10 + 5 = 15, NOT 10+3+4+5+2=24
    expect(costTotals.cost).toBeCloseTo(15.0)
    db.close()
  })

  test("tokens: sum ALL sessions (parent + child) since tokens are not rolled up", () => {
    const db = createTestDb()
    seedScenario(db)

    const parentIds = ["parent_a", "parent_b"]
    const childIds = getChildSessionIds(db, parentIds)
    const allIds = [...parentIds, ...childIds]
    const tokenTotals = getTokenTotals(db, allIds)

    // Input: 100+50+60+80+30 = 320
    expect(tokenTotals.tokensInput).toBe(320)
    // Output: 200+100+120+150+50 = 620
    expect(tokenTotals.tokensOutput).toBe(620)
    // Reasoning: 50+0+0+20+0 = 70
    expect(tokenTotals.tokensReasoning).toBe(70)
    // Cache read: 10+5+8+12+3 = 38
    expect(tokenTotals.tokensCacheRead).toBe(38)
    // Cache write: 5+2+3+4+1 = 15
    expect(tokenTotals.tokensCacheWrite).toBe(15)
    db.close()
  })

  test("messages: count from ALL sessions (parent + child)", () => {
    const db = createTestDb()
    seedScenario(db)

    const parentIds = ["parent_a", "parent_b"]
    const childIds = getChildSessionIds(db, parentIds)
    const allIds = [...parentIds, ...childIds]

    let totalMessages = 0
    for (const id of allIds) {
      const meta = getSessionMeta(db, id)
      if (meta) totalMessages += meta.userMsgCount + meta.assistantMsgCount
    }

    // 5 sessions × 2 messages each = 10
    expect(totalMessages).toBe(10)
    db.close()
  })

  test("cost from all sessions would double-count (incorrect approach)", () => {
    const db = createTestDb()
    seedScenario(db)

    const parentIds = ["parent_a", "parent_b"]
    const childIds = getChildSessionIds(db, parentIds)
    const allIds = [...parentIds, ...childIds]

    // This is the WRONG approach for cost - proves why we only use parent IDs
    const wrongCost = getTokenTotals(db, allIds)
    // 10+3+4+5+2 = 24 (double-counted)
    expect(wrongCost.cost).toBeCloseTo(24.0)
    // Correct cost is 15 (parents only)
    const correctCost = getTokenTotals(db, parentIds)
    expect(correctCost.cost).toBeCloseTo(15.0)
    expect(wrongCost.cost).not.toBeCloseTo(correctCost.cost)
    db.close()
  })

  test("getChildSessionIds returns empty for sessions without children", () => {
    const db = createTestDb()
    insertSession(db, "lonely_parent", { cost: 1.0, tokensInput: 10 })

    const childIds = getChildSessionIds(db, ["lonely_parent"])
    expect(childIds).toHaveLength(0)
    db.close()
  })

  test("getChildSessionIds handles empty input", () => {
    const db = createTestDb()
    seedScenario(db)

    const childIds = getChildSessionIds(db, [])
    expect(childIds).toHaveLength(0)
    db.close()
  })

  test("single parent with no children: cost equals token totals cost", () => {
    const db = createTestDb()
    insertSession(db, "solo", { cost: 7.5, tokensInput: 200, tokensOutput: 300, tokensReasoning: 50 })

    const parentIds = ["solo"]
    const childIds = getChildSessionIds(db, parentIds)
    const allIds = [...parentIds, ...childIds]

    const costTotals = getTokenTotals(db, parentIds)
    const tokenTotals = getTokenTotals(db, allIds)

    // No children, so both queries hit same set
    expect(costTotals.cost).toBeCloseTo(7.5)
    expect(tokenTotals.tokensInput).toBe(200)
    expect(tokenTotals.tokensOutput).toBe(300)
    expect(tokenTotals.tokensReasoning).toBe(50)
    db.close()
  })
})
