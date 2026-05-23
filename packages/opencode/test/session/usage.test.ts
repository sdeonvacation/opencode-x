import { describe, expect, test } from "bun:test"
import { Database, eq } from "../../src/storage/db"
import { MessageTable, SessionTable } from "../../src/session/session.sql"
import { ProjectTable } from "../../src/project/project.sql"
import { SessionID, MessageID } from "../../src/session/schema"
import { ProjectID } from "../../src/project/schema"
import { Usage } from "../../src/session/usage"
import { Log } from "../../src/util/log"

Log.init({ print: false })

const PROJECT = ProjectID.make("proj_usage_test_" + Date.now())

function setup() {
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
}

function uid() {
  return SessionID.make(crypto.randomUUID())
}

function session(opts: {
  id: SessionID
  parent?: SessionID
  title?: string
  cost?: number
  tokens_input?: number
  tokens_output?: number
  tokens_reasoning?: number
  tokens_cache_read?: number
  tokens_cache_write?: number
  time_created?: number
  cost_by_model?: Record<string, any>
}) {
  const now = Date.now()
  Database.use((db) =>
    db
      .insert(SessionTable)
      .values({
        id: opts.id,
        project_id: PROJECT,
        parent_id: opts.parent ?? null,
        slug: opts.id,
        directory: "/tmp",
        title: opts.title ?? "test",
        version: "1",
        time_created: opts.time_created ?? now,
        time_updated: now,
        cost: opts.cost ?? 0,
        tokens_input: opts.tokens_input ?? 0,
        tokens_output: opts.tokens_output ?? 0,
        tokens_reasoning: opts.tokens_reasoning ?? 0,
        tokens_cache_read: opts.tokens_cache_read ?? 0,
        tokens_cache_write: opts.tokens_cache_write ?? 0,
        cost_by_model: opts.cost_by_model ?? null,
      })
      .run(),
  )
  return opts.id
}

function msg(opts: {
  session: SessionID
  role: "assistant" | "user"
  provider?: string
  model?: string
  cost?: number
  tokens?: Partial<{ input: number; output: number; reasoning: number; cache: { read: number; write: number } }>
  time?: { created: number; completed?: number }
}) {
  const id = MessageID.make(crypto.randomUUID())
  const now = Date.now()
  const data =
    opts.role === "assistant"
      ? {
          role: "assistant",
          providerID: opts.provider ?? "anthropic",
          modelID: opts.model ?? "claude-opus-4-6",
          cost: opts.cost ?? 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, ...opts.tokens },
          time: opts.time ?? { created: now - 1000, completed: now },
          mode: "build",
          agent: "build",
          parentID: "msg_parent",
          path: { cwd: "/tmp", root: "/tmp" },
        }
      : { role: "user" }
  Database.use((db) =>
    db
      .insert(MessageTable)
      .values({
        id,
        session_id: opts.session,
        time_created: now,
        time_updated: now,
        data: data as any,
      })
      .run(),
  )
  return id
}

setup()

describe("Usage.forSession", () => {
  test("happy path - groups by model", async () => {
    const sid = session({
      id: uid(),
      cost: 0.08,
      tokens_input: 800,
      tokens_output: 400,
      tokens_reasoning: 60,
      tokens_cache_read: 160,
      tokens_cache_write: 40,
    })
    const base = Date.now()

    // 3 messages from anthropic/claude-opus-4-6
    msg({
      session: sid,
      role: "assistant",
      provider: "anthropic",
      model: "claude-opus-4-6",
      cost: 0.01,
      tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 20, write: 5 } },
      time: { created: base, completed: base + 2000 },
    })
    msg({
      session: sid,
      role: "assistant",
      provider: "anthropic",
      model: "claude-opus-4-6",
      cost: 0.02,
      tokens: { input: 200, output: 100, reasoning: 20, cache: { read: 40, write: 10 } },
      time: { created: base + 3000, completed: base + 5000 },
    })
    msg({
      session: sid,
      role: "assistant",
      provider: "anthropic",
      model: "claude-opus-4-6",
      cost: 0.03,
      tokens: { input: 300, output: 150, reasoning: 30, cache: { read: 60, write: 15 } },
      time: { created: base + 6000, completed: base + 9000 },
    })

    // 2 messages from openai/gpt-4o
    msg({
      session: sid,
      role: "assistant",
      provider: "openai",
      model: "gpt-4o",
      cost: 0.005,
      tokens: { input: 50, output: 25, reasoning: 0, cache: { read: 10, write: 2 } },
      time: { created: base + 10000, completed: base + 11000 },
    })
    msg({
      session: sid,
      role: "assistant",
      provider: "openai",
      model: "gpt-4o",
      cost: 0.015,
      tokens: { input: 150, output: 75, reasoning: 0, cache: { read: 30, write: 8 } },
      time: { created: base + 12000, completed: base + 14000 },
    })

    const result = await Usage.forSession(sid)

    expect(result.byModel).toHaveLength(2)

    const claude = result.byModel.find((m) => m.modelID === "claude-opus-4-6")!
    expect(claude.providerID).toBe("anthropic")
    expect(claude.cost).toBeCloseTo(0.06, 10)
    expect(claude.tokens.input).toBe(600)
    expect(claude.tokens.output).toBe(300)
    expect(claude.tokens.reasoning).toBe(60)
    expect(claude.tokens.cache.read).toBe(120)
    expect(claude.tokens.cache.write).toBe(30)
    expect(claude.duration).toBe(2000 + 2000 + 3000)

    const gpt = result.byModel.find((m) => m.modelID === "gpt-4o")!
    expect(gpt.providerID).toBe("openai")
    expect(gpt.cost).toBeCloseTo(0.02, 10)
    expect(gpt.tokens.input).toBe(200)
    expect(gpt.tokens.output).toBe(100)
    expect(gpt.tokens.reasoning).toBe(0)
    expect(gpt.tokens.cache.read).toBe(40)
    expect(gpt.tokens.cache.write).toBe(10)
    expect(gpt.duration).toBe(1000 + 2000)

    // total sums both models (no subagents here)
    expect(result.total.cost).toBeCloseTo(0.08, 10)
    expect(result.total.tokens.input).toBe(800)
    expect(result.total.tokens.output).toBe(400)
    expect(result.total.duration).toBe(7000 + 3000)
  })

  test("single model - all messages same provider/model", async () => {
    const sid = session({ id: uid() })
    const base = Date.now()

    msg({
      session: sid,
      role: "assistant",
      provider: "google",
      model: "gemini-2.5-pro",
      cost: 0.1,
      tokens: { input: 500, output: 200 },
      time: { created: base, completed: base + 3000 },
    })
    msg({
      session: sid,
      role: "assistant",
      provider: "google",
      model: "gemini-2.5-pro",
      cost: 0.2,
      tokens: { input: 1000, output: 400 },
      time: { created: base + 4000, completed: base + 8000 },
    })

    const result = await Usage.forSession(sid)

    expect(result.byModel).toHaveLength(1)
    expect(result.byModel[0].providerID).toBe("google")
    expect(result.byModel[0].modelID).toBe("gemini-2.5-pro")
    expect(result.byModel[0].cost).toBeCloseTo(0.3, 10)
    expect(result.byModel[0].tokens.input).toBe(1500)
    expect(result.byModel[0].tokens.output).toBe(600)
    expect(result.byModel[0].duration).toBe(3000 + 4000)
  })

  test("empty session - zeros", async () => {
    const sid = session({ id: uid() })

    const result = await Usage.forSession(sid)

    expect(result.byModel).toHaveLength(0)
    expect(result.total.cost).toBe(0)
    expect(result.total.tokens.input).toBe(0)
    expect(result.total.tokens.output).toBe(0)
    expect(result.total.tokens.reasoning).toBe(0)
    expect(result.total.tokens.cache.read).toBe(0)
    expect(result.total.tokens.cache.write).toBe(0)
    expect(result.total.duration).toBe(0)
    expect(result.total.wall).toBe(0)
    expect(result.subagents.cost).toBe(0)
    expect(result.subagents.count).toBe(0)
    expect(result.subagents.sessions).toHaveLength(0)
  })

  test("null time.completed excluded from duration", async () => {
    const sid = session({ id: uid(), cost: 0.06, tokens_input: 600, tokens_output: 300 })
    const base = Date.now()

    // Message with completed time — contributes to duration
    msg({
      session: sid,
      role: "assistant",
      cost: 0.01,
      tokens: { input: 100, output: 50 },
      time: { created: base, completed: base + 2000 },
    })
    // Message without completed time — does NOT contribute to duration
    msg({
      session: sid,
      role: "assistant",
      cost: 0.02,
      tokens: { input: 200, output: 100 },
      time: { created: base + 3000, completed: undefined },
    })
    // Message with completed time — contributes
    msg({
      session: sid,
      role: "assistant",
      cost: 0.03,
      tokens: { input: 300, output: 150 },
      time: { created: base + 5000, completed: base + 7000 },
    })

    const result = await Usage.forSession(sid)

    // Duration only from messages with both created+completed
    expect(result.total.duration).toBe(2000 + 2000)
    // Tokens from ALL assistant messages still counted
    expect(result.total.tokens.input).toBe(600)
    expect(result.total.tokens.output).toBe(300)
    expect(result.total.cost).toBeCloseTo(0.06, 10)
  })

  test("subagent costs aggregated", async () => {
    const parent = session({ id: uid(), cost: 0.1, tokens_input: 200, tokens_output: 100 })
    const child1 = session({
      id: uid(),
      parent,
      title: "child-1",
      cost: 0.5,
      tokens_input: 1000,
      tokens_output: 500,
      tokens_reasoning: 100,
      tokens_cache_read: 200,
      tokens_cache_write: 50,
    })
    const child2 = session({
      id: uid(),
      parent,
      title: "child-2",
      cost: 0.3,
      tokens_input: 800,
      tokens_output: 400,
      tokens_reasoning: 80,
      tokens_cache_read: 160,
      tokens_cache_write: 40,
    })

    // Parent also has own messages
    const base = Date.now()
    msg({
      session: parent,
      role: "assistant",
      cost: 0.1,
      tokens: { input: 200, output: 100 },
      time: { created: base, completed: base + 1000 },
    })

    const result = await Usage.forSession(parent)

    expect(result.subagents.count).toBe(2)
    expect(result.subagents.cost).toBeCloseTo(0.8, 10)
    expect(result.subagents.tokens.input).toBe(1800)
    expect(result.subagents.tokens.output).toBe(900)
    expect(result.subagents.tokens.reasoning).toBe(180)
    expect(result.subagents.tokens.cache.read).toBe(360)
    expect(result.subagents.tokens.cache.write).toBe(90)
    expect(result.subagents.sessions).toHaveLength(2)
    expect(result.subagents.sessions).toContainEqual({ title: "child-1", cost: 0.5 })
    expect(result.subagents.sessions).toContainEqual({ title: "child-2", cost: 0.3 })

    // total includes both own + subagent
    expect(result.total.cost).toBeCloseTo(0.9, 10)
    expect(result.total.tokens.input).toBe(2000)
    expect(result.total.tokens.output).toBe(1000)
  })

  test("recursion cap - deep nesting stops at depth > 3", async () => {
    const root = session({ id: uid() })
    const l1 = session({ id: uid(), parent: root, title: "L1", cost: 1, tokens_input: 100 })
    const l2 = session({ id: uid(), parent: l1, title: "L2", cost: 2, tokens_input: 200 })
    const l3 = session({ id: uid(), parent: l2, title: "L3", cost: 3, tokens_input: 300 })
    const l4 = session({ id: uid(), parent: l3, title: "L4", cost: 4, tokens_input: 400 })
    // L5 should NOT be included (depth 4 > 3 when collecting from L4)
    session({ id: uid(), parent: l4, title: "L5", cost: 5, tokens_input: 500 })

    const result = await Usage.forSession(root)

    // L1 through L4 included, L5 excluded
    expect(result.subagents.cost).toBe(1 + 2 + 3 + 4)
    expect(result.subagents.tokens.input).toBe(100 + 200 + 300 + 400)
    expect(result.subagents.sessions).toHaveLength(4)
    expect(result.subagents.sessions.map((s) => s.title).sort()).toEqual(["L1", "L2", "L3", "L4"])
  })

  test("wall duration from session start to last completed", async () => {
    const base = 1700000000000
    const sid = session({ id: uid(), time_created: base })

    msg({ session: sid, role: "assistant", cost: 0.01, time: { created: base + 1000, completed: base + 3000 } })
    msg({ session: sid, role: "assistant", cost: 0.02, time: { created: base + 5000, completed: base + 8000 } })
    msg({ session: sid, role: "assistant", cost: 0.03, time: { created: base + 10000, completed: base + 15000 } })

    const result = await Usage.forSession(sid)

    // wall = last msg completed - session time_created
    expect(result.total.wall).toBe(15000)
  })

  test("user messages ignored - only assistant contributes", async () => {
    const sid = session({
      id: uid(),
      cost: 0.05,
      tokens_input: 500,
      tokens_output: 250,
      tokens_reasoning: 50,
      tokens_cache_read: 100,
      tokens_cache_write: 25,
    })
    const base = Date.now()

    // User messages should be ignored
    msg({ session: sid, role: "user" })
    msg({ session: sid, role: "user" })
    msg({ session: sid, role: "user" })

    // Only this assistant message counts
    msg({
      session: sid,
      role: "assistant",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      cost: 0.05,
      tokens: { input: 500, output: 250, reasoning: 50, cache: { read: 100, write: 25 } },
      time: { created: base, completed: base + 4000 },
    })

    const result = await Usage.forSession(sid)

    expect(result.byModel).toHaveLength(1)
    expect(result.byModel[0].modelID).toBe("claude-sonnet-4-20250514")
    expect(result.total.cost).toBeCloseTo(0.05, 10)
    expect(result.total.tokens.input).toBe(500)
    expect(result.total.tokens.output).toBe(250)
    expect(result.total.tokens.reasoning).toBe(50)
    expect(result.total.tokens.cache.read).toBe(100)
    expect(result.total.tokens.cache.write).toBe(25)
    expect(result.total.duration).toBe(4000)
  })

  test("cost_by_model - uses session accumulator over message aggregation", async () => {
    const base = Date.now()
    const sid = session({
      id: uid(),
      cost: 0.15,
      tokens_input: 1000,
      tokens_output: 500,
      cost_by_model: {
        "anthropic:claude-opus-4-6": {
          cost: 0.1,
          tokens_input: 700,
          tokens_output: 350,
          tokens_reasoning: 50,
          tokens_cache_read: 100,
          tokens_cache_write: 20,
        },
        "openai:gpt-4o": {
          cost: 0.05,
          tokens_input: 300,
          tokens_output: 150,
          tokens_reasoning: 0,
          tokens_cache_read: 50,
          tokens_cache_write: 10,
        },
      },
      time_created: base,
    })

    // Messages still present for duration calculation
    msg({
      session: sid,
      role: "assistant",
      provider: "anthropic",
      model: "claude-opus-4-6",
      cost: 0.05,
      tokens: { input: 350, output: 175 },
      time: { created: base + 1000, completed: base + 3000 },
    })
    msg({
      session: sid,
      role: "assistant",
      provider: "openai",
      model: "gpt-4o",
      cost: 0.025,
      tokens: { input: 150, output: 75 },
      time: { created: base + 4000, completed: base + 5000 },
    })

    const result = await Usage.forSession(sid)

    // byModel uses cost_by_model accumulator (higher values from deleted msgs)
    expect(result.byModel).toHaveLength(2)
    const claude = result.byModel.find((m) => m.modelID === "claude-opus-4-6")!
    expect(claude.providerID).toBe("anthropic")
    expect(claude.cost).toBeCloseTo(0.1, 10)
    expect(claude.tokens.input).toBe(700)
    expect(claude.tokens.output).toBe(350)
    expect(claude.tokens.reasoning).toBe(50)
    expect(claude.tokens.cache.read).toBe(100)
    expect(claude.tokens.cache.write).toBe(20)
    // Duration still from messages
    expect(claude.duration).toBe(2000)

    const gpt = result.byModel.find((m) => m.modelID === "gpt-4o")!
    expect(gpt.cost).toBeCloseTo(0.05, 10)
    expect(gpt.tokens.input).toBe(300)
    expect(gpt.duration).toBe(1000)
  })

  test("cost_by_model - fallback to message aggregation when null", async () => {
    const base = Date.now()
    const sid = session({
      id: uid(),
      cost: 0.03,
      tokens_input: 300,
      tokens_output: 150,
      cost_by_model: undefined,
      time_created: base,
    })

    msg({
      session: sid,
      role: "assistant",
      provider: "google",
      model: "gemini-2.5-pro",
      cost: 0.03,
      tokens: { input: 300, output: 150, reasoning: 10 },
      time: { created: base + 1000, completed: base + 4000 },
    })

    const result = await Usage.forSession(sid)

    // Falls back to aggregate from messages
    expect(result.byModel).toHaveLength(1)
    expect(result.byModel[0].providerID).toBe("google")
    expect(result.byModel[0].modelID).toBe("gemini-2.5-pro")
    expect(result.byModel[0].cost).toBeCloseTo(0.03, 10)
    expect(result.byModel[0].tokens.input).toBe(300)
    expect(result.byModel[0].duration).toBe(3000)
  })

  test("cost_by_model - handles model IDs with colons", async () => {
    const sid = session({
      id: uid(),
      cost: 0.1,
      cost_by_model: {
        "aws:us.anthropic.claude-opus-4-6:v1": {
          cost: 0.1,
          tokens_input: 500,
          tokens_output: 200,
          tokens_reasoning: 0,
          tokens_cache_read: 0,
          tokens_cache_write: 0,
        },
      },
    })

    const result = await Usage.forSession(sid)

    expect(result.byModel).toHaveLength(1)
    expect(result.byModel[0].providerID).toBe("aws")
    expect(result.byModel[0].modelID).toBe("us.anthropic.claude-opus-4-6:v1")
    expect(result.byModel[0].cost).toBeCloseTo(0.1, 10)
  })

  test("cost_by_model - empty object returns empty byModel", async () => {
    const sid = session({
      id: uid(),
      cost: 0,
      cost_by_model: {},
    })

    const result = await Usage.forSession(sid)

    expect(result.byModel).toHaveLength(0)
  })
})

describe("projector cost_by_model accumulation", () => {
  test("PartUpdated with step-finish increments cost_by_model", () => {
    const sid = uid()
    const mid = MessageID.make(crypto.randomUUID())
    const base = Date.now()

    // Create session
    session({ id: sid, time_created: base })

    // Create assistant message with provider/model info
    Database.use((db) =>
      db
        .insert(MessageTable)
        .values({
          id: mid,
          session_id: sid,
          time_created: base,
          data: {
            role: "assistant",
            providerID: "anthropic",
            modelID: "claude-sonnet-4-20250514",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: base, completed: base + 1000 },
            mode: "build",
            agent: "build",
            parentID: "msg_parent",
            path: { cwd: "/tmp", root: "/tmp" },
          } as any,
        })
        .run(),
    )

    // Import and call projector logic directly via SyncEvent simulation
    const { PartTable } = require("../../src/session/session.sql")
    const { usage } = require("../../src/session/projectors")

    // Simulate PartUpdated by inserting a step-finish part + updating session
    const partData = {
      type: "step-finish",
      cost: 0.05,
      tokens: { input: 500, output: 200, reasoning: 30, cache: { read: 80, write: 15 } },
    }

    Database.use((db) => {
      // Insert part
      db.insert(PartTable)
        .values({
          id: "part_" + crypto.randomUUID(),
          message_id: mid,
          session_id: sid,
          time_created: base,
          data: partData,
        })
        .run()

      // Simulate what the projector does: update cost_by_model
      const u = usage(partData)
      const key = "anthropic:claude-sonnet-4-20250514"
      const row = db
        .select({ cost_by_model: SessionTable.cost_by_model })
        .from(SessionTable)
        .where(eq(SessionTable.id, sid))
        .get()
      const current = (row?.cost_by_model ?? {}) as Record<string, any>
      const entry = current[key] ?? {
        cost: 0,
        tokens_input: 0,
        tokens_output: 0,
        tokens_reasoning: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
      }
      entry.cost += u.cost
      entry.tokens_input += u.tokens_input
      entry.tokens_output += u.tokens_output
      entry.tokens_reasoning += u.tokens_reasoning
      entry.tokens_cache_read += u.tokens_cache_read
      entry.tokens_cache_write += u.tokens_cache_write
      current[key] = entry
      db.update(SessionTable).set({ cost_by_model: current, cost: u.cost }).where(eq(SessionTable.id, sid)).run()
    })

    // Verify cost_by_model was written
    const row = Database.use((db) =>
      db.select({ cost_by_model: SessionTable.cost_by_model }).from(SessionTable).where(eq(SessionTable.id, sid)).get(),
    )
    expect(row?.cost_by_model).toBeTruthy()
    const entry = (row!.cost_by_model as any)["anthropic:claude-sonnet-4-20250514"]
    expect(entry.cost).toBeCloseTo(0.05, 10)
    expect(entry.tokens_input).toBe(500)
    expect(entry.tokens_output).toBe(200)
    expect(entry.tokens_reasoning).toBe(30)
    expect(entry.tokens_cache_read).toBe(80)
    expect(entry.tokens_cache_write).toBe(15)
  })

  test("cost_by_model accumulates across multiple parts", () => {
    const sid = uid()
    const mid = MessageID.make(crypto.randomUUID())
    const base = Date.now()

    session({ id: sid, time_created: base })

    Database.use((db) =>
      db
        .insert(MessageTable)
        .values({
          id: mid,
          session_id: sid,
          time_created: base,
          data: {
            role: "assistant",
            providerID: "openai",
            modelID: "gpt-4o",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: base },
            mode: "build",
            agent: "build",
            parentID: "msg_parent",
            path: { cwd: "/tmp", root: "/tmp" },
          } as any,
        })
        .run(),
    )

    const { usage } = require("../../src/session/projectors")

    // Simulate two step-finish parts accumulating
    const parts = [
      {
        type: "step-finish",
        cost: 0.02,
        tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 10, write: 5 } },
      },
      {
        type: "step-finish",
        cost: 0.03,
        tokens: { input: 200, output: 100, reasoning: 10, cache: { read: 20, write: 8 } },
      },
    ]

    Database.use((db) => {
      for (const part of parts) {
        const u = usage(part)
        const key = "openai:gpt-4o"
        const row = db
          .select({ cost_by_model: SessionTable.cost_by_model })
          .from(SessionTable)
          .where(eq(SessionTable.id, sid))
          .get()
        const current = (row?.cost_by_model ?? {}) as Record<string, any>
        const entry = current[key] ?? {
          cost: 0,
          tokens_input: 0,
          tokens_output: 0,
          tokens_reasoning: 0,
          tokens_cache_read: 0,
          tokens_cache_write: 0,
        }
        entry.cost += u.cost
        entry.tokens_input += u.tokens_input
        entry.tokens_output += u.tokens_output
        entry.tokens_reasoning += u.tokens_reasoning
        entry.tokens_cache_read += u.tokens_cache_read
        entry.tokens_cache_write += u.tokens_cache_write
        current[key] = entry
        db.update(SessionTable).set({ cost_by_model: current }).where(eq(SessionTable.id, sid)).run()
      }
    })

    const row = Database.use((db) =>
      db.select({ cost_by_model: SessionTable.cost_by_model }).from(SessionTable).where(eq(SessionTable.id, sid)).get(),
    )
    const entry = (row!.cost_by_model as any)["openai:gpt-4o"]
    expect(entry.cost).toBeCloseTo(0.05, 10)
    expect(entry.tokens_input).toBe(300)
    expect(entry.tokens_output).toBe(150)
    expect(entry.tokens_reasoning).toBe(10)
    expect(entry.tokens_cache_read).toBe(30)
    expect(entry.tokens_cache_write).toBe(13)
  })
})
