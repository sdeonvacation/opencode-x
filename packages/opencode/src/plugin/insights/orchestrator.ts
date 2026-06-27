import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { generateReport as generateHtmlReport } from "./report"
import { dateStamp } from "./config"
import { FacetCache, FACET_CACHE_VERSION } from "./cache"
import { callLlm, extractJsonSafe, mapLimit } from "./llm"
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
  getChildSessionIds,
} from "./db"
import {
  buildFacetPrompt,
  buildChunkSummaryPrompt,
  buildProjectAreasPrompt,
  buildInteractionStylePrompt,
  buildAgentPerformancePrompt,
  buildFrictionPrompt,
  buildSuggestionsPrompt,
  buildToolHealthPrompt,
  buildRoomToLearnPrompt,
  buildHorizonPrompt,
  buildAtAGlancePrompt,
} from "./prompts"
import type { SessionFacet, SessionMeta, AggregatedStats, InsightsResult, InsightsConfig } from "./types"
import { GOAL_CATEGORIES, FRICTION_CATEGORIES, SATISFACTION_LEVELS } from "./types"
import type { Database } from "bun:sqlite"

export interface OrchestratorDeps {
  model: LanguageModelV3
  stateDir: string
  dbPath?: string
  projectDir?: string
}

type ProgressFn = (stage: string, current: number, total: number) => void

const MAX_TRANSCRIPT_CHARS = 60_000
const CHUNK_SIZE = 30_000

function buildTranscript(db: Database, sessionId: string): string {
  // Include parent + child session parts for full picture
  const childIds = getChildSessionIds(db, [sessionId])
  const allIds = [sessionId, ...childIds]

  let transcript = ""
  for (const id of allIds) {
    const parts = getPartsWithMessages(db, id)
    if (parts.length === 0) continue

    if (id !== sessionId) transcript += `\n--- [subagent] ---\n`

    let prevMsgId = ""
    let currentRole = ""

    for (const p of parts) {
      if (p.messageId !== prevMsgId) {
        prevMsgId = p.messageId
        currentRole = p.role === "user" ? "User" : "Assistant"
      }

      const data = JSON.parse(p.data) as {
        type: string
        text?: string
        tool?: string
        state?: { status: string; title?: string; error?: string }
      }

      if (data.type === "text" && data.text) {
        const text = data.text.length > 2000 ? data.text.slice(0, 2000) + "..." : data.text
        transcript += `[${currentRole}]: ${text}\n\n`
      }
      if (data.type === "tool" && data.tool && data.state) {
        const status =
          data.state.status === "error"
            ? `ERROR: ${data.state.error?.slice(0, 200) ?? "unknown"}`
            : (data.state.title ?? data.state.status)
        transcript += `[tool:${data.tool}] ${status}\n`
      }

      if (transcript.length > MAX_TRANSCRIPT_CHARS) break
    }
    if (transcript.length > MAX_TRANSCRIPT_CHARS) break
  }

  return transcript.slice(0, MAX_TRANSCRIPT_CHARS)
}

function buildMetaSummary(meta: SessionMeta): string {
  return [
    `Session ID: ${meta.id}`,
    `Title: ${meta.title}`,
    `Duration: ${meta.durationMinutes} minutes`,
    `Cost: $${meta.cost.toFixed(4)}`,
    `Messages: ${meta.userMsgCount} user, ${meta.assistantMsgCount} assistant`,
    `Agents: ${
      Object.entries(meta.agentCounts)
        .map(([a, c]) => `${a}=${c}`)
        .join(", ") || "none"
    }`,
  ].join("\n")
}

async function summarizeChunks(model: LanguageModelV3, transcript: string): Promise<string> {
  if (transcript.length <= CHUNK_SIZE) return transcript

  const chunks: string[] = []
  for (let i = 0; i < transcript.length; i += CHUNK_SIZE) {
    chunks.push(transcript.slice(i, i + CHUNK_SIZE))
  }

  const summaries = await mapLimit(chunks, 2, async (chunk) =>
    callLlm({ model, prompt: buildChunkSummaryPrompt(chunk), timeout: 30_000 }),
  )

  return summaries.join("\n\n")
}

function normalizeCategories<T extends string>(raw: unknown, valid: readonly T[]): Partial<Record<T, number>> {
  if (!raw || typeof raw !== "object") return {}
  const result: Partial<Record<T, number>> = {}
  for (const key of valid) {
    const val = (raw as Record<string, unknown>)[key]
    if (typeof val === "number" && val > 0) result[key] = val
  }
  return result
}

async function extractFacets(
  model: LanguageModelV3,
  sessionIds: string[],
  db: Database,
  cache: FacetCache,
  concurrency: number,
  onProgress?: ProgressFn,
): Promise<SessionFacet[]> {
  const total = sessionIds.length
  let completed = 0

  const facets = await mapLimit(sessionIds, concurrency, async (sessionId) => {
    const cached = cache.get(sessionId)
    if (cached) {
      completed++
      onProgress?.("extracting facets", completed, total)
      return cached
    }

    const transcript = buildTranscript(db, sessionId)
    if (transcript.trim().length < 50) {
      completed++
      onProgress?.("extracting facets", completed, total)
      return null
    }

    const meta = getSessionMeta(db, sessionId)
    if (!meta) {
      completed++
      onProgress?.("extracting facets", completed, total)
      return null
    }

    const summarized = await summarizeChunks(model, transcript)
    const metaStr = buildMetaSummary(meta)
    const raw = await callLlm({ model, prompt: buildFacetPrompt(summarized, metaStr), timeout: 60_000 })
    const parsed = extractJsonSafe(raw) as Record<string, unknown>

    const facet: SessionFacet = {
      sessionId,
      underlyingGoal: String(parsed.underlying_goal ?? ""),
      goalCategories: normalizeCategories(parsed.goal_categories, GOAL_CATEGORIES),
      outcome: String(parsed.outcome ?? "unclear"),
      satisfaction: normalizeCategories(parsed.satisfaction, SATISFACTION_LEVELS),
      frictionCounts: normalizeCategories(parsed.friction_counts, FRICTION_CATEGORIES),
      frictionDetail: String(parsed.friction_detail ?? ""),
      primarySuccess: String(parsed.primary_success ?? ""),
      briefSummary: String(parsed.brief_summary ?? ""),
    }

    cache.put(sessionId, facet)
    completed++
    onProgress?.("extracting facets", completed, total)
    return facet
  })

  return facets.filter((f): f is SessionFacet => f !== null)
}

function aggregateAll(db: Database, sessionIds: string[], facets: SessionFacet[]): AggregatedStats {
  const dateRange = getSessionDateRange(db, sessionIds)
  // Include child sessions for tokens/messages/tools (not rolled up into parents)
  const childIds = getChildSessionIds(db, sessionIds)
  const allIds = [...sessionIds, ...childIds]

  const costTotals = getTokenTotals(db, sessionIds) // cost from parents only (rolled up)
  const tokenTotals = getTokenTotals(db, allIds) // tokens from all
  const totalTokens = tokenTotals.tokensInput + tokenTotals.tokensOutput + tokenTotals.tokensReasoning

  const toolErrorRates = getToolErrorRates(db, allIds)
  const topTools = toolErrorRates.map((t) => ({ tool: t.tool, count: t.totalCalls })).sort((a, b) => b.count - a.count)

  // Count messages across all sessions (parent + child)
  let totalMessages = 0
  const allMetas = allIds.map((id) => getSessionMeta(db, id)).filter((m): m is SessionMeta => m !== null)
  for (const m of allMetas) {
    totalMessages += m.userMsgCount + m.assistantMsgCount
  }

  // Aggregate agent counts
  const agentMap = new Map<string, number>()
  for (const m of allMetas) {
    for (const [agent, count] of Object.entries(m.agentCounts)) {
      agentMap.set(agent, (agentMap.get(agent) ?? 0) + (count as number))
    }
  }
  const topAgents = [...agentMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([agent, count]) => ({ agent, count }))

  // Model counts from cost_by_model
  const modelMap = new Map<string, number>()
  for (const m of allMetas) {
    for (const model of Object.keys(m.tokensByModel)) {
      modelMap.set(model, (modelMap.get(model) ?? 0) + 1)
    }
  }
  const topModels = [...modelMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([model, count]) => ({ model, count }))

  return {
    totalSessions: sessionIds.length,
    analyzedSessions: facets.length,
    childSessions: childIds.length,
    dateRange,
    totalMessages,
    totalCost: costTotals.cost,
    totalTokens,
    topTools: topTools.slice(0, 15),
    topAgents,
    topModels,
    byAgentModel: getByAgentModel(db, sessionIds).slice(0, 20),
    toolErrorRates: toolErrorRates.filter((t) => t.errorCalls > 0),
    cacheEfficiency: getCacheEfficiency(db, sessionIds),
    costPer1k: getCostPer1k(db, sessionIds),
    agentDelegation: getAgentDelegation(db, sessionIds),
  }
}

async function runAggregateAnalysis(
  model: LanguageModelV3,
  facets: SessionFacet[],
  stats: AggregatedStats,
  metas: SessionMeta[],
  onProgress?: ProgressFn,
): Promise<Record<string, unknown>> {
  const data = { facets, stats, metas }
  const sections: Record<string, unknown> = {}

  const analyses: Array<{ key: string; prompt: string }> = [
    { key: "project_areas", prompt: buildProjectAreasPrompt(data) },
    { key: "interaction_style", prompt: buildInteractionStylePrompt(data) },
    { key: "agent_performance", prompt: buildAgentPerformancePrompt(data) },
    { key: "friction", prompt: buildFrictionPrompt(data) },
    { key: "suggestions", prompt: buildSuggestionsPrompt(data) },
    { key: "tool_health", prompt: buildToolHealthPrompt(data) },
    { key: "room_to_learn", prompt: buildRoomToLearnPrompt(data) },
    { key: "horizon", prompt: buildHorizonPrompt(data) },
  ]

  let completed = 0
  const total = analyses.length

  await mapLimit(analyses, 3, async (item) => {
    const raw = await callLlm({ model, prompt: item.prompt, timeout: 60_000 })
    sections[item.key] = extractJsonSafe(raw)
    completed++
    onProgress?.("aggregate analysis", completed, total)
  })

  return sections
}

async function generateAtAGlance(
  model: LanguageModelV3,
  allInsights: Record<string, unknown>,
  stats: AggregatedStats,
): Promise<Record<string, unknown>> {
  const raw = await callLlm({ model, prompt: buildAtAGlancePrompt(allInsights, stats), timeout: 60_000 })
  return extractJsonSafe(raw) as Record<string, unknown>
}

export async function runInsights(
  deps: OrchestratorDeps,
  opts: {
    days?: number
    force?: boolean
    concurrency?: number
    maxSessions?: number
    projectOnly?: boolean
  },
  onProgress?: ProgressFn,
): Promise<InsightsResult> {
  const days = opts.days ?? 7
  const concurrency = opts.concurrency ?? 4
  const maxSessions = opts.maxSessions ?? 200
  const force = opts.force ?? false

  const outputDir = join(deps.stateDir, "insights")
  mkdirSync(outputDir, { recursive: true })

  const cacheDir = join(deps.stateDir, "insights", `cache-${FACET_CACHE_VERSION}`)
  const cache = new FacetCache(cacheDir)
  if (force) cache.clear()

  // Resolve DB path
  const dbPath = deps.dbPath ?? resolveDbPath(deps.stateDir)
  const db = openDb(dbPath)

  onProgress?.("loading sessions", 0, 1)

  const since = Date.now() - days * 86_400_000

  // Get sessions, optionally filtered by project directory
  const allIds =
    opts.projectOnly && deps.projectDir
      ? listSessionIdsWithDir(db, since)
          .filter((r) => r.directory === deps.projectDir)
          .map((r) => r.id)
      : listSessionIds(db, since)

  const sessionIds = allIds.slice(0, maxSessions)

  if (sessionIds.length === 0) {
    db.close()
    return {
      reportPath: "",
      jsonPath: "",
      atAGlance: { error: "No sessions found in date range" },
      sessionCount: 0,
      analyzedCount: 0,
      totalCost: 0,
    }
  }

  onProgress?.("loading sessions", 1, 1)

  // Build session metas
  const metas = sessionIds.map((id) => getSessionMeta(db, id)).filter((m): m is SessionMeta => m !== null)

  // Extract per-session facets
  const facets = await extractFacets(deps.model, sessionIds, db, cache, concurrency, onProgress)

  // Aggregate stats
  onProgress?.("aggregating stats", 0, 1)
  const stats = aggregateAll(db, sessionIds, facets)
  onProgress?.("aggregating stats", 1, 1)

  db.close()

  // Run aggregate LLM analysis
  const sections = await runAggregateAnalysis(deps.model, facets, stats, metas, onProgress)

  // Generate at-a-glance
  onProgress?.("generating summary", 0, 1)
  const atAGlance = await generateAtAGlance(deps.model, { ...sections, stats }, stats)
  onProgress?.("generating summary", 1, 1)

  // Generate HTML report
  const stamp = dateStamp()
  const facetMap = new Map(facets.map((f) => [f.sessionId, f]))
  const reportData = {
    stats,
    facets: facetMap,
    aggregates: sections,
    atAGlance,
    config: {
      model: { providerID: "unknown", modelID: "unknown" },
      days,
      force,
      concurrency,
      maxSessions,
      projectOnly: opts.projectOnly ?? false,
      output: "",
    } satisfies InsightsConfig,
    generatedAt: Date.now(),
  }
  const jsonOutput = { generated: stamp, atAGlance, sections, stats, facets }
  const insightsJson = JSON.stringify(jsonOutput, null, 2)
  const report = generateHtmlReport(reportData, insightsJson)

  // Write outputs
  const reportPath = join(outputDir, `insights-${stamp}.html`)
  const jsonPath = join(outputDir, `insights-${stamp}.json`)

  writeFileSync(reportPath, report, "utf-8")
  writeFileSync(jsonPath, insightsJson, "utf-8")

  return {
    reportPath,
    jsonPath,
    atAGlance,
    sessionCount: sessionIds.length,
    analyzedCount: facets.length,
    totalCost: stats.totalCost,
  }
}
