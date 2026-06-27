import { Database } from "bun:sqlite"
import path from "node:path"
import { xdgData } from "xdg-basedir"
import type { SessionMeta } from "./types"

export interface TokenTotals {
  cost: number
  tokensInput: number
  tokensOutput: number
  tokensReasoning: number
  tokensCacheRead: number
  tokensCacheWrite: number
}

export interface AgentModelRow {
  agent: string
  model: string
  sessions: number
  cost: number
  tokens: number
}

export interface ToolErrorRateRow {
  tool: string
  totalCalls: number
  errorCalls: number
  errorRate: number
}

export interface CacheEfficiencyRow {
  model: string
  cacheRatio: number
}

export interface CostPer1kRow {
  model: string
  costPer1kTokens: number
}

export interface AgentDelegationRow {
  parentAgent: string
  childAgent: string
  count: number
}

export interface PartWithRole {
  partId: string
  messageId: string
  role: string
  data: string
  timeCreated: number
}

function chunks<T>(arr: T[], size: number): T[][] {
  const result: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size))
  }
  return result
}

function placeholders(count: number): string {
  return Array(count).fill("?").join(",")
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function openDb(dbPath: string): Database {
  return new Database(dbPath, { readonly: true })
}

export function resolveDbPath(stateDir?: string): string {
  const dataDir = stateDir ?? path.join(xdgData!, "opencode")
  return path.join(dataDir, "opencode.db")
}

export function listSessionIds(db: Database, since: number): string[] {
  const rows = db
    .query<{ id: string }, [number]>("SELECT id FROM session WHERE time_created >= ? AND parent_id IS NULL")
    .all(since)
  return rows.map((r) => r.id)
}

export function listSessionIdsWithDir(db: Database, since: number): Array<{ id: string; directory: string }> {
  return db
    .query<
      { id: string; directory: string },
      [number]
    >("SELECT id, directory FROM session WHERE time_created >= ? AND parent_id IS NULL")
    .all(since)
}

export function getChildSessionIds(db: Database, parentIds: string[]): string[] {
  if (parentIds.length === 0) return []
  const batches = chunks(parentIds, 500)
  const result: string[] = []
  for (const batch of batches) {
    const rows = db
      .query<{ id: string }, string[]>(`SELECT id FROM session WHERE parent_id IN (${placeholders(batch.length)})`)
      .all(...batch)
    for (const r of rows) result.push(r.id)
  }
  return result
}

export function getSessionDateRange(db: Database, sessionIds: string[]): { from: string; to: string } {
  if (sessionIds.length === 0) return { from: "", to: "" }
  const batches = chunks(sessionIds, 500)
  let min = Infinity
  let max = -Infinity
  for (const batch of batches) {
    const row = db
      .query<
        { mn: number; mx: number },
        string[]
      >(`SELECT MIN(time_created) as mn, MAX(time_created) as mx FROM session WHERE id IN (${placeholders(batch.length)})`)
      .get(...batch)
    if (row) {
      if (row.mn < min) min = row.mn
      if (row.mx > max) max = row.mx
    }
  }
  return { from: formatDate(min), to: formatDate(max) }
}

export function getTokenTotals(db: Database, sessionIds: string[]): TokenTotals {
  if (sessionIds.length === 0)
    return { cost: 0, tokensInput: 0, tokensOutput: 0, tokensReasoning: 0, tokensCacheRead: 0, tokensCacheWrite: 0 }
  const batches = chunks(sessionIds, 500)
  let cost = 0
  let tokensInput = 0
  let tokensOutput = 0
  let tokensReasoning = 0
  let tokensCacheRead = 0
  let tokensCacheWrite = 0
  for (const batch of batches) {
    const row = db
      .query<
        {
          cost: number
          tokens_input: number
          tokens_output: number
          tokens_reasoning: number
          tokens_cache_read: number
          tokens_cache_write: number
        },
        string[]
      >(
        `SELECT
          COALESCE(SUM(cost), 0) as cost,
          COALESCE(SUM(tokens_input), 0) as tokens_input,
          COALESCE(SUM(tokens_output), 0) as tokens_output,
          COALESCE(SUM(tokens_reasoning), 0) as tokens_reasoning,
          COALESCE(SUM(tokens_cache_read), 0) as tokens_cache_read,
          COALESCE(SUM(tokens_cache_write), 0) as tokens_cache_write
        FROM session WHERE id IN (${placeholders(batch.length)})`,
      )
      .get(...batch)
    if (row) {
      cost += row.cost
      tokensInput += row.tokens_input
      tokensOutput += row.tokens_output
      tokensReasoning += row.tokens_reasoning
      tokensCacheRead += row.tokens_cache_read
      tokensCacheWrite += row.tokens_cache_write
    }
  }
  return { cost, tokensInput, tokensOutput, tokensReasoning, tokensCacheRead, tokensCacheWrite }
}

export function getByAgentModel(db: Database, sessionIds: string[]): AgentModelRow[] {
  if (sessionIds.length === 0) return []
  const batches = chunks(sessionIds, 500)
  const acc = new Map<string, { sessions: Set<string>; cost: number; tokens: number }>()

  for (const batch of batches) {
    const rows = db
      .query<
        { id: string; cost_by_model: string | null },
        string[]
      >(`SELECT id, cost_by_model FROM session WHERE id IN (${placeholders(batch.length)})`)
      .all(...batch)

    // Get agent for each session (first assistant message's agent field)
    const agentRows = db
      .query<{ session_id: string; agent: string | null }, string[]>(
        `SELECT session_id, json_extract(data, '$.agent') as agent
         FROM message
         WHERE session_id IN (${placeholders(batch.length)})
           AND json_extract(data, '$.role') = 'assistant'
         GROUP BY session_id
         HAVING MIN(time_created)`,
      )
      .all(...batch)

    const agentMap = new Map(agentRows.map((r) => [r.session_id, r.agent ?? "unknown"]))

    for (const row of rows) {
      if (!row.cost_by_model) continue
      const parsed = JSON.parse(row.cost_by_model) as Record<
        string,
        { cost: number; tokens_input: number; tokens_output: number; tokens_reasoning: number }
      >
      const agent = agentMap.get(row.id) ?? "unknown"

      for (const [model, data] of Object.entries(parsed)) {
        const key = `${agent}::${model}`
        const existing = acc.get(key)
        const tokens = data.tokens_input + data.tokens_output + data.tokens_reasoning
        if (existing) {
          existing.sessions.add(row.id)
          existing.cost += data.cost
          existing.tokens += tokens
        } else {
          acc.set(key, { sessions: new Set([row.id]), cost: data.cost, tokens })
        }
      }
    }
  }

  return Array.from(acc.entries()).map(([key, val]) => {
    const [agent, model] = key.split("::")
    return { agent, model, sessions: val.sessions.size, cost: val.cost, tokens: val.tokens }
  })
}

export function getToolErrorRates(db: Database, sessionIds: string[]): ToolErrorRateRow[] {
  if (sessionIds.length === 0) return []
  const batches = chunks(sessionIds, 500)
  const acc = new Map<string, { total: number; errors: number }>()

  for (const batch of batches) {
    const rows = db
      .query<{ tool: string; status: string | null }, string[]>(
        `SELECT
          json_extract(data, '$.tool') as tool,
          json_extract(data, '$.state.status') as status
        FROM part
        WHERE session_id IN (${placeholders(batch.length)})
          AND json_extract(data, '$.tool') IS NOT NULL`,
      )
      .all(...batch)

    for (const row of rows) {
      if (!row.tool) continue
      const existing = acc.get(row.tool)
      const isError = row.status === "error"
      if (existing) {
        existing.total++
        if (isError) existing.errors++
      } else {
        acc.set(row.tool, { total: 1, errors: isError ? 1 : 0 })
      }
    }
  }

  return Array.from(acc.entries())
    .map(([tool, val]) => ({
      tool,
      totalCalls: val.total,
      errorCalls: val.errors,
      errorRate: val.total > 0 ? val.errors / val.total : 0,
    }))
    .sort((a, b) => b.totalCalls - a.totalCalls)
}

export function getCacheEfficiency(db: Database, sessionIds: string[]): CacheEfficiencyRow[] {
  if (sessionIds.length === 0) return []
  const batches = chunks(sessionIds, 500)
  const acc = new Map<string, { input: number; cacheRead: number }>()

  for (const batch of batches) {
    const rows = db
      .query<
        { cost_by_model: string | null },
        string[]
      >(`SELECT cost_by_model FROM session WHERE id IN (${placeholders(batch.length)}) AND cost_by_model IS NOT NULL`)
      .all(...batch)

    for (const row of rows) {
      const parsed = JSON.parse(row.cost_by_model!) as Record<
        string,
        { tokens_input: number; tokens_cache_read: number }
      >
      for (const [model, data] of Object.entries(parsed)) {
        const existing = acc.get(model)
        if (existing) {
          existing.input += data.tokens_input
          existing.cacheRead += data.tokens_cache_read
        } else {
          acc.set(model, { input: data.tokens_input, cacheRead: data.tokens_cache_read })
        }
      }
    }
  }

  return Array.from(acc.entries())
    .map(([model, val]) => ({
      model,
      cacheRatio: val.input > 0 ? val.cacheRead / val.input : 0,
    }))
    .sort((a, b) => b.cacheRatio - a.cacheRatio)
}

export function getCostPer1k(db: Database, sessionIds: string[]): CostPer1kRow[] {
  if (sessionIds.length === 0) return []
  const batches = chunks(sessionIds, 500)
  const acc = new Map<string, { cost: number; tokens: number }>()

  for (const batch of batches) {
    const rows = db
      .query<
        { cost_by_model: string | null },
        string[]
      >(`SELECT cost_by_model FROM session WHERE id IN (${placeholders(batch.length)}) AND cost_by_model IS NOT NULL`)
      .all(...batch)

    for (const row of rows) {
      const parsed = JSON.parse(row.cost_by_model!) as Record<
        string,
        { cost: number; tokens_input: number; tokens_output: number; tokens_reasoning: number }
      >
      for (const [model, data] of Object.entries(parsed)) {
        const totalTokens = data.tokens_input + data.tokens_output + data.tokens_reasoning
        const existing = acc.get(model)
        if (existing) {
          existing.cost += data.cost
          existing.tokens += totalTokens
        } else {
          acc.set(model, { cost: data.cost, tokens: totalTokens })
        }
      }
    }
  }

  return Array.from(acc.entries())
    .map(([model, val]) => ({
      model,
      costPer1kTokens: val.tokens > 0 ? (val.cost / val.tokens) * 1000 : 0,
    }))
    .sort((a, b) => b.costPer1kTokens - a.costPer1kTokens)
}

export function getAgentDelegation(db: Database, sessionIds: string[]): AgentDelegationRow[] {
  if (sessionIds.length === 0) return []
  const batches = chunks(sessionIds, 500)
  const acc = new Map<string, number>()

  for (const batch of batches) {
    // Find sessions with parent_id that are in our set, derive agent from first assistant message
    const rows = db
      .query<{ parent_id: string; child_session_id: string }, string[]>(
        `SELECT s.parent_id, s.id as child_session_id
         FROM session s
         WHERE s.id IN (${placeholders(batch.length)})
           AND s.parent_id IS NOT NULL`,
      )
      .all(...batch)

    if (rows.length === 0) continue

    // Get agents for both parent and child sessions
    const allIds = [...new Set(rows.flatMap((r) => [r.parent_id, r.child_session_id]))]
    const agentBatches = chunks(allIds, 500)
    const agentMap = new Map<string, string>()

    for (const agentBatch of agentBatches) {
      const agentRows = db
        .query<{ session_id: string; agent: string | null }, string[]>(
          `SELECT session_id, json_extract(data, '$.agent') as agent
           FROM message
           WHERE session_id IN (${placeholders(agentBatch.length)})
             AND json_extract(data, '$.role') = 'assistant'
           GROUP BY session_id
           HAVING MIN(time_created)`,
        )
        .all(...agentBatch)
      for (const r of agentRows) {
        agentMap.set(r.session_id, r.agent ?? "unknown")
      }
    }

    for (const row of rows) {
      const parentAgent = agentMap.get(row.parent_id) ?? "unknown"
      const childAgent = agentMap.get(row.child_session_id) ?? "unknown"
      const key = `${parentAgent}::${childAgent}`
      acc.set(key, (acc.get(key) ?? 0) + 1)
    }
  }

  return Array.from(acc.entries())
    .map(([key, count]) => {
      const [parentAgent, childAgent] = key.split("::")
      return { parentAgent, childAgent, count }
    })
    .sort((a, b) => b.count - a.count)
}

export function getPartsWithMessages(db: Database, sessionId: string): PartWithRole[] {
  return db
    .query<{ part_id: string; message_id: string; role: string; data: string; time_created: number }, [string]>(
      `SELECT
        p.id as part_id,
        p.message_id,
        json_extract(m.data, '$.role') as role,
        p.data,
        p.time_created
      FROM part p
      JOIN message m ON m.id = p.message_id
      WHERE p.session_id = ?
      ORDER BY p.time_created ASC`,
    )
    .all(sessionId)
    .map((r) => ({
      partId: r.part_id,
      messageId: r.message_id,
      role: r.role,
      data: r.data,
      timeCreated: r.time_created,
    }))
}

export function getSessionMeta(db: Database, sessionId: string): SessionMeta | null {
  const row = db
    .query<
      {
        id: string
        title: string
        directory: string | null
        parent_id: string | null
        time_created: number
        time_updated: number
        cost: number
        cost_by_model: string | null
      },
      [string]
    >(
      `SELECT id, title, directory, parent_id, time_created, time_updated, cost, cost_by_model
       FROM session WHERE id = ?`,
    )
    .get(sessionId)

  if (!row) return null

  const durationMinutes = Math.round((row.time_updated - row.time_created) / 60000)

  // Count user and assistant messages
  const msgCounts = db
    .query<{ role: string; cnt: number }, [string]>(
      `SELECT json_extract(data, '$.role') as role, COUNT(*) as cnt
       FROM message WHERE session_id = ? GROUP BY role`,
    )
    .all(sessionId)

  let userMsgCount = 0
  let assistantMsgCount = 0
  for (const m of msgCounts) {
    if (m.role === "user") userMsgCount = m.cnt
    if (m.role === "assistant") assistantMsgCount = m.cnt
  }

  // Parse cost_by_model for tokensByModel
  const tokensByModel: Record<string, number> = {}
  if (row.cost_by_model) {
    const parsed = JSON.parse(row.cost_by_model) as Record<
      string,
      { tokens_input: number; tokens_output: number; tokens_reasoning: number }
    >
    for (const [model, data] of Object.entries(parsed)) {
      tokensByModel[model] = data.tokens_input + data.tokens_output + data.tokens_reasoning
    }
  }

  // Derive agent counts from assistant messages
  const agentRows = db
    .query<{ agent: string | null }, [string]>(
      `SELECT json_extract(data, '$.agent') as agent
       FROM message
       WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant'`,
    )
    .all(sessionId)

  const agentCounts: Record<string, number> = {}
  for (const r of agentRows) {
    const agent = r.agent ?? "unknown"
    agentCounts[agent] = (agentCounts[agent] ?? 0) + 1
  }

  return {
    id: row.id,
    title: row.title,
    projectDir: row.directory,
    parentId: row.parent_id,
    durationMinutes,
    userMsgCount,
    assistantMsgCount,
    cost: row.cost,
    tokensByModel,
    agentCounts,
  }
}
