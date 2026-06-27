import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "../../fixture/fixture"
import { runInsights, type OrchestratorDeps } from "../../../src/plugin/insights/orchestrator"
import type { LanguageModelV3 } from "@ai-sdk/provider"

function createTestDb(dbPath: string): Database {
  const db = new Database(dbPath)
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
    directory?: string
    title?: string
    parentId?: string
    costByModel?: Record<string, unknown>
  } = {},
) {
  db.run(
    `INSERT INTO session (id, time_created, time_updated, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, cost_by_model, parent_id, directory, title)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?)`,
    [
      id,
      opts.timeCreated ?? Date.now(),
      opts.timeUpdated ?? Date.now() + 60_000,
      opts.cost ?? 0.01,
      opts.tokensInput ?? 100,
      opts.tokensOutput ?? 50,
      opts.costByModel ? JSON.stringify(opts.costByModel) : null,
      opts.parentId ?? null,
      opts.directory ?? "/tmp/test",
      opts.title ?? "Test Session",
    ],
  )
}

function insertMessage(
  db: Database,
  id: string,
  sessionId: string,
  data: Record<string, unknown>,
  timeCreated?: number,
) {
  db.run(`INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)`, [
    id,
    sessionId,
    timeCreated ?? Date.now(),
    timeCreated ?? Date.now(),
    JSON.stringify(data),
  ])
}

function insertPart(
  db: Database,
  id: string,
  messageId: string,
  sessionId: string,
  data: Record<string, unknown>,
  timeCreated?: number,
) {
  db.run(`INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)`, [
    id,
    messageId,
    sessionId,
    timeCreated ?? Date.now(),
    timeCreated ?? Date.now(),
    JSON.stringify(data),
  ])
}

const FACET_RESPONSE = JSON.stringify({
  session_id: "s1",
  underlying_goal: "implement feature",
  goal_categories: { implement_feature: 1 },
  outcome: "fully_achieved",
  satisfaction: { happy: 1 },
  friction_counts: {},
  friction_detail: "",
  primary_success: "implemented the feature",
  brief_summary: "User asked to implement a feature. Agent did it.",
})

const SECTION_RESPONSE = JSON.stringify({
  areas: [{ name: "backend", description: "API work", session_count: 1, example_goals: ["implement feature"] }],
})

const AT_A_GLANCE_RESPONSE = JSON.stringify({
  whats_working: { your_direction: "Clear requests", agent_execution: "Good tool use" },
  whats_hindering: { agent: "Sometimes verbose", user_side: "", tooling: "" },
  quick_wins: "Use skills more",
  ambitious_workflows: "Automated testing",
})

function makeMockModel(responses?: string[]): LanguageModelV3 {
  let callIndex = 0
  const defaultResponse = SECTION_RESPONSE

  return {
    specificationVersion: "v1" as "v1",
    provider: "test",
    modelId: "test-model",
    defaultObjectGenerationMode: "json" as "json",
    doGenerate: async () => {
      const response = responses?.[callIndex] ?? defaultResponse
      callIndex++
      return {
        text: response,
        usage: { promptTokens: 10, completionTokens: 10 },
        finishReason: "stop" as "stop",
        rawCall: { rawPrompt: "", rawSettings: {} },
        response: { id: "test", modelId: "test-model" },
      }
    },
  } as unknown as LanguageModelV3
}

describe("runInsights", () => {
  test("returns empty result when no sessions in date range", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const db = createTestDb(dbPath)
    insertSession(db, "s1", { timeCreated: 1000 }) // very old
    db.close()

    const deps: OrchestratorDeps = {
      model: makeMockModel(),
      stateDir: tmp.path,
      dbPath,
    }

    const result = await runInsights(deps, { days: 1 })
    expect(result.sessionCount).toBe(0)
    expect(result.analyzedCount).toBe(0)
    expect(result.reportPath).toBe("")
    expect(result.atAGlance).toHaveProperty("error")
  })

  test("returns result with sessions in date range", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const db = createTestDb(dbPath)
    const now = Date.now()
    insertSession(db, "s1", { timeCreated: now - 1000, timeUpdated: now, title: "Build feature" })
    insertMessage(db, "m1", "s1", { role: "user", agent: "build" }, now - 900)
    insertMessage(db, "m2", "s1", { role: "assistant", agent: "build" }, now - 800)
    insertPart(
      db,
      "p1",
      "m1",
      "s1",
      { type: "text", text: "Please implement the login feature with OAuth support for Google and GitHub" },
      now - 900,
    )
    insertPart(
      db,
      "p2",
      "m2",
      "s1",
      { type: "text", text: "I'll implement the OAuth login feature for you." },
      now - 800,
    )
    insertPart(
      db,
      "p3",
      "m2",
      "s1",
      { type: "tool", tool: "edit", state: { status: "completed", title: "Edited auth.ts" } },
      now - 700,
    )
    db.close()

    // Model returns facet first, then 8 section responses, then at-a-glance
    const responses = [FACET_RESPONSE, ...Array(8).fill(SECTION_RESPONSE), AT_A_GLANCE_RESPONSE]

    const deps: OrchestratorDeps = {
      model: makeMockModel(responses),
      stateDir: tmp.path,
      dbPath,
    }

    const result = await runInsights(deps, { days: 7 })
    expect(result.sessionCount).toBe(1)
    expect(result.analyzedCount).toBe(1)
    expect(result.reportPath).toEndWith(".md")
    expect(result.jsonPath).toEndWith(".json")
    expect(existsSync(result.reportPath)).toBe(true)
    expect(existsSync(result.jsonPath)).toBe(true)
  })

  test("filters sessions by project directory when projectOnly set", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const db = createTestDb(dbPath)
    const now = Date.now()
    insertSession(db, "s1", { timeCreated: now - 1000, directory: "/projects/a", title: "Session A" })
    insertSession(db, "s2", { timeCreated: now - 500, directory: "/projects/b", title: "Session B" })
    insertMessage(db, "m1", "s1", { role: "user" }, now - 900)
    insertPart(
      db,
      "p1",
      "m1",
      "s1",
      {
        type: "text",
        text: "Work on project A with some substantial text content that is at least fifty characters long.",
      },
      now - 900,
    )
    insertMessage(db, "m2", "s1", { role: "assistant", agent: "build" }, now - 800)
    insertPart(
      db,
      "p2",
      "m2",
      "s1",
      { type: "text", text: "Working on project A now with some substantial response text content." },
      now - 800,
    )
    db.close()

    const responses = [FACET_RESPONSE, ...Array(8).fill(SECTION_RESPONSE), AT_A_GLANCE_RESPONSE]
    const deps: OrchestratorDeps = {
      model: makeMockModel(responses),
      stateDir: tmp.path,
      dbPath,
      projectDir: "/projects/a",
    }

    const result = await runInsights(deps, { days: 7, projectOnly: true })
    expect(result.sessionCount).toBe(1)
  })

  test("skips sessions with very short transcripts", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const db = createTestDb(dbPath)
    const now = Date.now()
    insertSession(db, "s1", { timeCreated: now - 1000, title: "Empty Session" })
    insertMessage(db, "m1", "s1", { role: "user" }, now - 900)
    insertPart(db, "p1", "m1", "s1", { type: "text", text: "hi" }, now - 900) // too short
    db.close()

    const deps: OrchestratorDeps = {
      model: makeMockModel([...Array(9).fill(SECTION_RESPONSE), AT_A_GLANCE_RESPONSE]),
      stateDir: tmp.path,
      dbPath,
    }

    const result = await runInsights(deps, { days: 7 })
    expect(result.sessionCount).toBe(1)
    expect(result.analyzedCount).toBe(0) // skipped due to short transcript
  })

  test("uses cache for previously analyzed sessions", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const db = createTestDb(dbPath)
    const now = Date.now()
    insertSession(db, "s1", { timeCreated: now - 1000, title: "Cached Session" })
    insertMessage(db, "m1", "s1", { role: "user" }, now - 900)
    insertPart(
      db,
      "p1",
      "m1",
      "s1",
      { type: "text", text: "A long enough message to pass the transcript length check for session facet extraction." },
      now - 900,
    )
    insertMessage(db, "m2", "s1", { role: "assistant", agent: "build" }, now - 800)
    insertPart(
      db,
      "p2",
      "m2",
      "s1",
      { type: "text", text: "Here is a response with enough content to pass the minimum threshold for analysis." },
      now - 800,
    )
    db.close()

    // First run: facet + 8 sections + at-a-glance
    const responses1 = [FACET_RESPONSE, ...Array(8).fill(SECTION_RESPONSE), AT_A_GLANCE_RESPONSE]
    const deps: OrchestratorDeps = {
      model: makeMockModel(responses1),
      stateDir: tmp.path,
      dbPath,
    }
    await runInsights(deps, { days: 7 })

    // Second run: should skip facet extraction (cached), only sections + at-a-glance
    const responses2 = [...Array(8).fill(SECTION_RESPONSE), AT_A_GLANCE_RESPONSE]
    const deps2: OrchestratorDeps = {
      model: makeMockModel(responses2),
      stateDir: tmp.path,
      dbPath,
    }
    const result = await runInsights(deps2, { days: 7 })
    expect(result.analyzedCount).toBe(1)
  })

  test("force option clears cache", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const db = createTestDb(dbPath)
    const now = Date.now()
    insertSession(db, "s1", { timeCreated: now - 1000, title: "Force Session" })
    insertMessage(db, "m1", "s1", { role: "user" }, now - 900)
    insertPart(
      db,
      "p1",
      "m1",
      "s1",
      {
        type: "text",
        text: "A long enough message to pass the transcript length check for session facet extraction pipeline.",
      },
      now - 900,
    )
    insertMessage(db, "m2", "s1", { role: "assistant", agent: "build" }, now - 800)
    insertPart(
      db,
      "p2",
      "m2",
      "s1",
      { type: "text", text: "Here is a detailed response with enough content to be worth analyzing for insights." },
      now - 800,
    )
    db.close()

    // First run
    const responses1 = [FACET_RESPONSE, ...Array(8).fill(SECTION_RESPONSE), AT_A_GLANCE_RESPONSE]
    const deps: OrchestratorDeps = { model: makeMockModel(responses1), stateDir: tmp.path, dbPath }
    await runInsights(deps, { days: 7 })

    // Second run with force: will re-extract facets (needs facet response again)
    const responses2 = [FACET_RESPONSE, ...Array(8).fill(SECTION_RESPONSE), AT_A_GLANCE_RESPONSE]
    const deps2: OrchestratorDeps = { model: makeMockModel(responses2), stateDir: tmp.path, dbPath }
    const result = await runInsights(deps2, { days: 7, force: true })
    expect(result.analyzedCount).toBe(1)
  })

  test("calls onProgress callback", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const db = createTestDb(dbPath)
    const now = Date.now()
    insertSession(db, "s1", { timeCreated: now - 1000, title: "Progress Session" })
    insertMessage(db, "m1", "s1", { role: "user" }, now - 900)
    insertPart(
      db,
      "p1",
      "m1",
      "s1",
      {
        type: "text",
        text: "A sufficiently long user message to ensure the transcript passes the minimum character threshold for analysis.",
      },
      now - 900,
    )
    insertMessage(db, "m2", "s1", { role: "assistant", agent: "build" }, now - 800)
    insertPart(
      db,
      "p2",
      "m2",
      "s1",
      {
        type: "text",
        text: "Agent responds with detailed information that makes this a substantial assistant message for the test.",
      },
      now - 800,
    )
    db.close()

    const responses = [FACET_RESPONSE, ...Array(8).fill(SECTION_RESPONSE), AT_A_GLANCE_RESPONSE]
    const deps: OrchestratorDeps = { model: makeMockModel(responses), stateDir: tmp.path, dbPath }

    const progressCalls: Array<{ stage: string; current: number; total: number }> = []
    await runInsights(deps, { days: 7 }, (stage, current, total) => {
      progressCalls.push({ stage, current, total })
    })

    const stages = [...new Set(progressCalls.map((p) => p.stage))]
    expect(stages).toContain("loading sessions")
    expect(stages).toContain("extracting facets")
    expect(stages).toContain("aggregating stats")
    expect(stages).toContain("aggregate analysis")
    expect(stages).toContain("generating summary")
  })

  test("report contains expected markdown sections", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const db = createTestDb(dbPath)
    const now = Date.now()
    insertSession(db, "s1", {
      timeCreated: now - 1000,
      timeUpdated: now,
      title: "Report Test",
      cost: 0.5,
      tokensInput: 1000,
      tokensOutput: 500,
    })
    insertMessage(db, "m1", "s1", { role: "user" }, now - 900)
    insertPart(
      db,
      "p1",
      "m1",
      "s1",
      {
        type: "text",
        text: "Implement a comprehensive feature with OAuth integration, database migrations, and unit tests please.",
      },
      now - 900,
    )
    insertMessage(db, "m2", "s1", { role: "assistant", agent: "build" }, now - 800)
    insertPart(
      db,
      "p2",
      "m2",
      "s1",
      {
        type: "text",
        text: "I will implement the feature with OAuth integration, database migrations, and unit tests as requested.",
      },
      now - 800,
    )
    db.close()

    const responses = [FACET_RESPONSE, ...Array(8).fill(SECTION_RESPONSE), AT_A_GLANCE_RESPONSE]
    const deps: OrchestratorDeps = { model: makeMockModel(responses), stateDir: tmp.path, dbPath }

    const result = await runInsights(deps, { days: 7 })
    const report = readFileSync(result.reportPath, "utf-8")

    expect(report).toContain("# OpenCode Insights Report")
    expect(report).toContain("## At a Glance")
    expect(report).toContain("### What's Working")
    expect(report).toContain("## Goal Distribution")
    expect(report).toContain("## Satisfaction Distribution")
    expect(report).toContain("## Tool Usage")
  })

  test("json output contains all expected fields", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const db = createTestDb(dbPath)
    const now = Date.now()
    insertSession(db, "s1", { timeCreated: now - 1000, title: "JSON Test" })
    insertMessage(db, "m1", "s1", { role: "user" }, now - 900)
    insertPart(
      db,
      "p1",
      "m1",
      "s1",
      {
        type: "text",
        text: "A long message for JSON output test with enough content to pass the fifty character minimum threshold.",
      },
      now - 900,
    )
    insertMessage(db, "m2", "s1", { role: "assistant", agent: "build" }, now - 800)
    insertPart(
      db,
      "p2",
      "m2",
      "s1",
      { type: "text", text: "Agent provides a comprehensive response for the JSON output validation test scenario." },
      now - 800,
    )
    db.close()

    const responses = [FACET_RESPONSE, ...Array(8).fill(SECTION_RESPONSE), AT_A_GLANCE_RESPONSE]
    const deps: OrchestratorDeps = { model: makeMockModel(responses), stateDir: tmp.path, dbPath }

    const result = await runInsights(deps, { days: 7 })
    const json = JSON.parse(readFileSync(result.jsonPath, "utf-8"))

    expect(json).toHaveProperty("generated")
    expect(json).toHaveProperty("atAGlance")
    expect(json).toHaveProperty("sections")
    expect(json).toHaveProperty("stats")
    expect(json).toHaveProperty("facets")
    expect(json.stats).toHaveProperty("totalSessions")
    expect(json.stats).toHaveProperty("dateRange")
    expect(json.facets).toHaveLength(1)
  })

  test("respects maxSessions limit", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "test.db")
    const db = createTestDb(dbPath)
    const now = Date.now()

    for (let i = 0; i < 10; i++) {
      insertSession(db, `s${i}`, { timeCreated: now - (10 - i) * 1000, title: `Session ${i}` })
      insertMessage(db, `m${i}`, `s${i}`, { role: "user" }, now - (10 - i) * 1000 + 100)
      insertPart(
        db,
        `p${i}`,
        `m${i}`,
        `s${i}`,
        {
          type: "text",
          text: `Message ${i} with enough content to meet the minimum transcript length requirement for analysis.`,
        },
        now - (10 - i) * 1000 + 100,
      )
      insertMessage(db, `ma${i}`, `s${i}`, { role: "assistant", agent: "build" }, now - (10 - i) * 1000 + 200)
      insertPart(
        db,
        `pa${i}`,
        `ma${i}`,
        `s${i}`,
        {
          type: "text",
          text: `Response ${i} with enough text content to ensure this passes all minimum requirements for insight analysis.`,
        },
        now - (10 - i) * 1000 + 200,
      )
    }
    db.close()

    // 3 facets + 8 sections + at-a-glance
    const responses = [...Array(3).fill(FACET_RESPONSE), ...Array(8).fill(SECTION_RESPONSE), AT_A_GLANCE_RESPONSE]
    const deps: OrchestratorDeps = { model: makeMockModel(responses), stateDir: tmp.path, dbPath }

    const result = await runInsights(deps, { days: 7, maxSessions: 3 })
    expect(result.sessionCount).toBe(3)
  })

  test("throws for missing database file", async () => {
    await using tmp = await tmpdir()
    const deps: OrchestratorDeps = {
      model: makeMockModel(),
      stateDir: tmp.path,
      dbPath: path.join(tmp.path, "nonexistent.db"),
    }

    await expect(runInsights(deps, { days: 7 })).rejects.toThrow()
  })
})
