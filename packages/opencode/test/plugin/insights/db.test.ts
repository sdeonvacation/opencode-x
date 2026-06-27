import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { Database } from "bun:sqlite"
import {
  openDb,
  resolveDbPath,
  listSessionIds,
  listSessionIdsWithDir,
  getSessionDateRange,
  getTokenTotals,
  getByAgentModel,
  getToolErrorRates,
  getCacheEfficiency,
  getCostPer1k,
  getAgentDelegation,
  getPartsWithMessages,
  getSessionMeta,
} from "../../../src/plugin/insights/db"

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
    timeUpdated?: number
    cost?: number
    tokensInput?: number
    tokensOutput?: number
    tokensReasoning?: number
    tokensCacheRead?: number
    tokensCacheWrite?: number
    costByModel?: Record<string, unknown>
    parentId?: string
    directory?: string
    title?: string
  } = {},
) {
  db.run(
    `INSERT INTO session (id, time_created, time_updated, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, cost_by_model, parent_id, directory, title)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.timeCreated ?? 1000,
      opts.timeUpdated ?? 2000,
      opts.cost ?? 0,
      opts.tokensInput ?? 0,
      opts.tokensOutput ?? 0,
      opts.tokensReasoning ?? 0,
      opts.tokensCacheRead ?? 0,
      opts.tokensCacheWrite ?? 0,
      opts.costByModel ? JSON.stringify(opts.costByModel) : null,
      opts.parentId ?? null,
      opts.directory ?? "/tmp/test",
      opts.title ?? "Test Session",
    ],
  )
}

function insertMessage(db: Database, id: string, sessionId: string, data: Record<string, unknown>, timeCreated = 1000) {
  db.run(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`, [
    id,
    sessionId,
    timeCreated,
    timeCreated,
    JSON.stringify(data),
  ])
}

function insertPart(
  db: Database,
  id: string,
  messageId: string,
  sessionId: string,
  data: Record<string, unknown>,
  timeCreated = 1000,
) {
  db.run(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`, [
    id,
    messageId,
    sessionId,
    timeCreated,
    timeCreated,
    JSON.stringify(data),
  ])
}

describe("resolveDbPath", () => {
  test("uses provided stateDir", () => {
    const result = resolveDbPath("/custom/dir")
    expect(result).toBe("/custom/dir/opencode.db")
  })

  test("falls back to xdg data dir", () => {
    const result = resolveDbPath()
    expect(result).toContain("opencode")
    expect(result).toEndWith("opencode.db")
  })
})

describe("listSessionIds", () => {
  test("returns sessions created after since", () => {
    const db = createTestDb()
    insertSession(db, "s1", { timeCreated: 500 })
    insertSession(db, "s2", { timeCreated: 1000 })
    insertSession(db, "s3", { timeCreated: 1500 })

    const ids = listSessionIds(db, 1000)
    expect(ids).toContain("s2")
    expect(ids).toContain("s3")
    expect(ids).not.toContain("s1")
    db.close()
  })

  test("returns empty for no matches", () => {
    const db = createTestDb()
    insertSession(db, "s1", { timeCreated: 100 })

    const ids = listSessionIds(db, 200)
    expect(ids).toHaveLength(0)
    db.close()
  })
})

describe("listSessionIdsWithDir", () => {
  test("returns id and directory", () => {
    const db = createTestDb()
    insertSession(db, "s1", { timeCreated: 1000, directory: "/projects/foo" })
    insertSession(db, "s2", { timeCreated: 2000, directory: "/projects/bar" })

    const results = listSessionIdsWithDir(db, 1000)
    expect(results).toHaveLength(2)
    expect(results.find((r) => r.id === "s1")?.directory).toBe("/projects/foo")
    expect(results.find((r) => r.id === "s2")?.directory).toBe("/projects/bar")
    db.close()
  })
})

describe("getSessionDateRange", () => {
  test("returns formatted min and max dates", () => {
    const db = createTestDb()
    // 2024-01-15T00:00:00Z = 1705276800000
    // 2024-03-20T00:00:00Z = 1710892800000
    insertSession(db, "s1", { timeCreated: 1705276800000 })
    insertSession(db, "s2", { timeCreated: 1710892800000 })

    const range = getSessionDateRange(db, ["s1", "s2"])
    expect(range.from).toBe("2024-01-15")
    expect(range.to).toBe("2024-03-20")
    db.close()
  })

  test("returns empty strings for empty input", () => {
    const db = createTestDb()
    const range = getSessionDateRange(db, [])
    expect(range.from).toBe("")
    expect(range.to).toBe("")
    db.close()
  })
})

describe("getTokenTotals", () => {
  test("aggregates token data across sessions", () => {
    const db = createTestDb()
    insertSession(db, "s1", {
      cost: 0.5,
      tokensInput: 100,
      tokensOutput: 50,
      tokensReasoning: 20,
      tokensCacheRead: 30,
      tokensCacheWrite: 10,
    })
    insertSession(db, "s2", {
      cost: 0.3,
      tokensInput: 200,
      tokensOutput: 100,
      tokensReasoning: 40,
      tokensCacheRead: 60,
      tokensCacheWrite: 20,
    })

    const totals = getTokenTotals(db, ["s1", "s2"])
    expect(totals.cost).toBeCloseTo(0.8)
    expect(totals.tokensInput).toBe(300)
    expect(totals.tokensOutput).toBe(150)
    expect(totals.tokensReasoning).toBe(60)
    expect(totals.tokensCacheRead).toBe(90)
    expect(totals.tokensCacheWrite).toBe(30)
    db.close()
  })

  test("returns zeros for empty input", () => {
    const db = createTestDb()
    const totals = getTokenTotals(db, [])
    expect(totals.cost).toBe(0)
    expect(totals.tokensInput).toBe(0)
    db.close()
  })
})

describe("getByAgentModel", () => {
  test("parses cost_by_model and derives agent from first assistant message", () => {
    const db = createTestDb()
    insertSession(db, "s1", {
      costByModel: {
        "claude-sonnet-4-20250514": { cost: 0.1, tokens_input: 500, tokens_output: 200, tokens_reasoning: 0 },
      },
    })
    insertMessage(db, "m1", "s1", { role: "assistant", agent: "coder" }, 100)

    const rows = getByAgentModel(db, ["s1"])
    expect(rows).toHaveLength(1)
    expect(rows[0].agent).toBe("coder")
    expect(rows[0].model).toBe("claude-sonnet-4-20250514")
    expect(rows[0].sessions).toBe(1)
    expect(rows[0].cost).toBeCloseTo(0.1)
    expect(rows[0].tokens).toBe(700)
    db.close()
  })

  test("uses 'unknown' when no assistant message found", () => {
    const db = createTestDb()
    insertSession(db, "s1", {
      costByModel: { "gpt-4o": { cost: 0.05, tokens_input: 100, tokens_output: 50, tokens_reasoning: 0 } },
    })

    const rows = getByAgentModel(db, ["s1"])
    expect(rows).toHaveLength(1)
    expect(rows[0].agent).toBe("unknown")
    db.close()
  })

  test("returns empty for empty input", () => {
    const db = createTestDb()
    expect(getByAgentModel(db, [])).toHaveLength(0)
    db.close()
  })
})

describe("getToolErrorRates", () => {
  test("calculates error rates per tool", () => {
    const db = createTestDb()
    insertSession(db, "s1", {})
    insertMessage(db, "m1", "s1", { role: "assistant" })
    insertPart(db, "p1", "m1", "s1", { tool: "bash", state: { status: "done" } })
    insertPart(db, "p2", "m1", "s1", { tool: "bash", state: { status: "error" } })
    insertPart(db, "p3", "m1", "s1", { tool: "bash", state: { status: "done" } })
    insertPart(db, "p4", "m1", "s1", { tool: "edit", state: { status: "error" } })

    const rows = getToolErrorRates(db, ["s1"])
    const bash = rows.find((r) => r.tool === "bash")!
    expect(bash.totalCalls).toBe(3)
    expect(bash.errorCalls).toBe(1)
    expect(bash.errorRate).toBeCloseTo(1 / 3)

    const edit = rows.find((r) => r.tool === "edit")!
    expect(edit.totalCalls).toBe(1)
    expect(edit.errorCalls).toBe(1)
    expect(edit.errorRate).toBe(1)
    db.close()
  })

  test("ignores parts without tool field", () => {
    const db = createTestDb()
    insertSession(db, "s1", {})
    insertMessage(db, "m1", "s1", { role: "assistant" })
    insertPart(db, "p1", "m1", "s1", { type: "text", text: "hello" })

    const rows = getToolErrorRates(db, ["s1"])
    expect(rows).toHaveLength(0)
    db.close()
  })
})

describe("getCacheEfficiency", () => {
  test("computes cache ratio per model", () => {
    const db = createTestDb()
    insertSession(db, "s1", {
      costByModel: {
        "claude-sonnet-4-20250514": {
          cost: 0.1,
          tokens_input: 1000,
          tokens_output: 200,
          tokens_reasoning: 0,
          tokens_cache_read: 800,
          tokens_cache_write: 100,
        },
      },
    })

    const rows = getCacheEfficiency(db, ["s1"])
    expect(rows).toHaveLength(1)
    expect(rows[0].model).toBe("claude-sonnet-4-20250514")
    expect(rows[0].cacheRatio).toBeCloseTo(0.8)
    db.close()
  })

  test("aggregates across sessions", () => {
    const db = createTestDb()
    insertSession(db, "s1", {
      costByModel: {
        m1: {
          cost: 0,
          tokens_input: 500,
          tokens_cache_read: 200,
          tokens_output: 0,
          tokens_reasoning: 0,
          tokens_cache_write: 0,
        },
      },
    })
    insertSession(db, "s2", {
      costByModel: {
        m1: {
          cost: 0,
          tokens_input: 500,
          tokens_cache_read: 300,
          tokens_output: 0,
          tokens_reasoning: 0,
          tokens_cache_write: 0,
        },
      },
    })

    const rows = getCacheEfficiency(db, ["s1", "s2"])
    expect(rows[0].cacheRatio).toBeCloseTo(0.5) // 500/1000
    db.close()
  })
})

describe("getCostPer1k", () => {
  test("computes cost per 1k tokens per model", () => {
    const db = createTestDb()
    insertSession(db, "s1", {
      costByModel: {
        "gpt-4o": { cost: 0.01, tokens_input: 500, tokens_output: 300, tokens_reasoning: 200 },
      },
    })

    const rows = getCostPer1k(db, ["s1"])
    expect(rows).toHaveLength(1)
    expect(rows[0].model).toBe("gpt-4o")
    // cost 0.01, tokens 1000 → 0.01/1000*1000 = 0.01
    expect(rows[0].costPer1kTokens).toBeCloseTo(0.01)
    db.close()
  })
})

describe("getAgentDelegation", () => {
  test("counts parent-child agent relationships", () => {
    const db = createTestDb()
    insertSession(db, "parent1", {})
    insertSession(db, "child1", { parentId: "parent1" })
    insertSession(db, "child2", { parentId: "parent1" })

    insertMessage(db, "m-p1", "parent1", { role: "assistant", agent: "planner" }, 100)
    insertMessage(db, "m-c1", "child1", { role: "assistant", agent: "coder" }, 100)
    insertMessage(db, "m-c2", "child2", { role: "assistant", agent: "coder" }, 100)

    const rows = getAgentDelegation(db, ["parent1", "child1", "child2"])
    expect(rows).toHaveLength(1)
    expect(rows[0].parentAgent).toBe("planner")
    expect(rows[0].childAgent).toBe("coder")
    expect(rows[0].count).toBe(2)
    db.close()
  })

  test("returns empty when no parent sessions", () => {
    const db = createTestDb()
    insertSession(db, "s1", {})
    expect(getAgentDelegation(db, ["s1"])).toHaveLength(0)
    db.close()
  })
})

describe("getPartsWithMessages", () => {
  test("joins parts with message role", () => {
    const db = createTestDb()
    insertSession(db, "s1", {})
    insertMessage(db, "m1", "s1", { role: "assistant" }, 1000)
    insertMessage(db, "m2", "s1", { role: "user" }, 2000)
    insertPart(db, "p1", "m1", "s1", { type: "text", text: "hello" }, 1000)
    insertPart(db, "p2", "m2", "s1", { type: "text", text: "world" }, 2000)

    const parts = getPartsWithMessages(db, "s1")
    expect(parts).toHaveLength(2)
    expect(parts[0].role).toBe("assistant")
    expect(parts[0].partId).toBe("p1")
    expect(parts[1].role).toBe("user")
    expect(parts[1].partId).toBe("p2")
    db.close()
  })

  test("returns empty for nonexistent session", () => {
    const db = createTestDb()
    expect(getPartsWithMessages(db, "nonexistent")).toHaveLength(0)
    db.close()
  })
})

describe("getSessionMeta", () => {
  test("returns full session metadata", () => {
    const db = createTestDb()
    insertSession(db, "s1", {
      timeCreated: 1000000,
      timeUpdated: 1060000, // 1 minute later
      cost: 0.25,
      title: "My Session",
      directory: "/projects/test",
      costByModel: {
        "claude-sonnet-4-20250514": { cost: 0.2, tokens_input: 1000, tokens_output: 500, tokens_reasoning: 100 },
        "gpt-4o": { cost: 0.05, tokens_input: 200, tokens_output: 100, tokens_reasoning: 0 },
      },
    })
    insertMessage(db, "m1", "s1", { role: "user" }, 1000)
    insertMessage(db, "m2", "s1", { role: "assistant", agent: "coder" }, 2000)
    insertMessage(db, "m3", "s1", { role: "assistant", agent: "coder" }, 3000)
    insertMessage(db, "m4", "s1", { role: "user" }, 4000)

    const meta = getSessionMeta(db, "s1")!
    expect(meta.id).toBe("s1")
    expect(meta.title).toBe("My Session")
    expect(meta.projectDir).toBe("/projects/test")
    expect(meta.parentId).toBeNull()
    expect(meta.durationMinutes).toBe(1)
    expect(meta.userMsgCount).toBe(2)
    expect(meta.assistantMsgCount).toBe(2)
    expect(meta.cost).toBe(0.25)
    expect(meta.tokensByModel["claude-sonnet-4-20250514"]).toBe(1600)
    expect(meta.tokensByModel["gpt-4o"]).toBe(300)
    expect(meta.agentCounts["coder"]).toBe(2)
    db.close()
  })

  test("returns null for nonexistent session", () => {
    const db = createTestDb()
    expect(getSessionMeta(db, "nope")).toBeNull()
    db.close()
  })

  test("handles session with no cost_by_model", () => {
    const db = createTestDb()
    insertSession(db, "s1", { cost: 0 })
    const meta = getSessionMeta(db, "s1")!
    expect(meta.tokensByModel).toEqual({})
    db.close()
  })
})

describe("chunks helper (via getTokenTotals with many IDs)", () => {
  test("handles more than 500 session IDs", () => {
    const db = createTestDb()
    const ids: string[] = []
    for (let i = 0; i < 600; i++) {
      const id = `s${i}`
      ids.push(id)
      insertSession(db, id, { cost: 0.001, tokensInput: 1 })
    }

    const totals = getTokenTotals(db, ids)
    expect(totals.tokensInput).toBe(600)
    expect(totals.cost).toBeCloseTo(0.6)
    db.close()
  })
})
