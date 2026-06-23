# HLD: /insights — Built-in Session Analytics & Reporting

## Tech Stack

| Category  | Technology          | Purpose                                                   |
| --------- | ------------------- | --------------------------------------------------------- |
| Language  | TypeScript 5.8      | Existing codebase standard                                |
| Runtime   | Bun 1.3.11          | Native SQLite via `bun:sqlite`, fast FS ops               |
| Framework | Effect-ts 4.0-beta  | Not used — plugin is pure async (no fibers)               |
| AI SDK    | `ai` (v6)           | `generateText()` for direct LLM calls                     |
| Database  | `bun:sqlite`        | Read-only queries on existing opencode.db                 |
| Provider  | Provider namespace  | `getSmallModel()` + `getLanguage()` resolution            |
| Plugin    | @opencode-ai/plugin | `tool()`, `Plugin`, `PluginInput` registration            |
| Cache     | Filesystem JSON     | Facet cache at `~/.local/share/opencode/insights/facets/` |

## Components

| Component      | Responsibility                                           | Dependencies                    |
| -------------- | -------------------------------------------------------- | ------------------------------- |
| InsightsPlugin | Plugin entry, tool + command registration                | @opencode-ai/plugin, config     |
| Orchestrator   | Pipeline coordination: filter→extract→analyze→report     | db, llm, cache, extract, report |
| LLM            | Direct `generateText()` wrapper, JSON extraction         | AI SDK, Provider namespace      |
| DB             | Read-only SQLite queries on session/message/part         | bun:sqlite                      |
| Extract        | Session filtering, transcript reconstruction, stats      | db                              |
| Analyze        | Facet extraction + aggregate analysis via LLM            | llm, prompts, cache, extract    |
| Cache          | Filesystem-backed facet cache with version key           | node:fs                         |
| Config         | Config resolution from opencode.json `insights` key      | none                            |
| Prompts        | All LLM prompt templates (facet, aggregate, at-a-glance) | types                           |
| Report         | Self-contained HTML generation from analysis data        | types                           |
| Types          | Type definitions, category constants                     | none                            |

## Architecture

```
User: /insights --days 14
         │
         ▼
┌─────────────────────────────────────────────────────┐
│  InsightsPlugin (built-in, internalPlugins[])        │
│  Registers: tool.insights + command.insights         │
│  Resolves config → builds InsightsConfig             │
└──────────┬──────────────────────────────────────────┘
           ▼
┌─────────────────────────────────────────────────────┐
│  Orchestrator.runInsights(deps, config, onProgress)  │
│  1. openDb() → read-only bun:sqlite handle           │
│  2. filterSessions(db, {since, projectDir})          │
│  3. aggregateAll(db, sessionIds) → AggregatedStats   │
│  4. extractFacets(db, llm, ids, config, cache)       │
│     └─ mapLimit(concurrency): transcript → LLM → facet
│  5. runAggregateAnalysis(facets, stats, config, llm) │
│     └─ mapLimit(concurrency): 8 aggregate prompts    │
│  6. generateAtAGlance(aggregates, stats, config, llm)│
│  7. generateReport() → HTML + JSON                   │
└──────────┬──────────────────────────────────────────┘
           ▼
┌─────────────────────────────────────────────────────┐
│  LLM Layer (direct generateText)                     │
│  - Provider.getSmallModel(providerID) → Model        │
│  - Provider.getLanguage(model) → LanguageModelV3     │
│  - generateText({model, system, messages})           │
│  - No session creation, no DB writes                 │
│  - mapLimit() for parallel concurrency               │
└──────────┬──────────────────────────────────────────┘
           ▼
┌─────────────────────────────────────────────────────┐
│  Output                                              │
│  - HTML report (self-contained, opens in browser)    │
│  - insights.json (diffable raw data)                 │
│  - TUI toast with at-a-glance summary               │
└─────────────────────────────────────────────────────┘
```

**Description**: The plugin registers via `internalPlugins[]` array in `plugin/index.ts`. When `/insights` is invoked, the tool handler resolves config (from `opencode.json` `insights` key), builds `InsightsConfig`, and calls `runInsights()`. The orchestrator opens the DB read-only, filters sessions by time range and project, aggregates stats from raw SQL, then uses LLM calls (via `generateText()`) to extract per-session facets and run 8 aggregate analysis prompts plus a synthesis. Results are written as HTML + JSON. Progress updates flow via `toolCtx.metadata()` and toast notifications.

## Interfaces

### InsightsPlugin (index.ts)

| Method                | Input                                    | Output            | Behavior                                         | Errors                        |
| --------------------- | ---------------------------------------- | ----------------- | ------------------------------------------------ | ----------------------------- |
| plugin(ctx)           | `PluginInput`                            | `Hooks`           | Registers tool + command, lazily resolves config | Plugin load failure           |
| tool.insights.execute | `{days?, force?, model?, output?, all?}` | `{title, output}` | Runs full pipeline, opens report                 | LLM unavailable, DB not found |

### Orchestrator (orchestrator.ts)

| Method      | Input                                           | Output           | Behavior                | Errors                                              |
| ----------- | ----------------------------------------------- | ---------------- | ----------------------- | --------------------------------------------------- |
| runInsights | `OrchestratorDeps, InsightsConfig, onProgress?` | `InsightsResult` | Full pipeline execution | DB open failure, LLM errors (non-fatal per session) |

### LLM (llm.ts)

| Method      | Input                                                       | Output    | Behavior                                | Errors                    |
| ----------- | ----------------------------------------------------------- | --------- | --------------------------------------- | ------------------------- |
| callLlm     | `{model: LanguageModelV3, prompt: string, system?: string}` | `string`  | Direct `generateText()` call            | Timeout, auth, rate limit |
| extractJson | `string`                                                    | `unknown` | Parse JSON from LLM text response       | JsonParseError            |
| mapLimit    | `T[], limit, fn`                                            | `R[]`     | Parallel execution with concurrency cap | Propagates fn errors      |

### DB (db.ts)

| Method               | Input                     | Output                | Behavior                                   | Errors         |
| -------------------- | ------------------------- | --------------------- | ------------------------------------------ | -------------- |
| openDb               | `path: string`            | `Database`            | Opens read-only SQLite connection          | File not found |
| resolveDbPath        | `stateDir?: string`       | `string`              | Resolves DB path from XDG/env              | None           |
| filterSessions       | `db, {since, projectDir}` | `string[]`            | Lists session IDs matching criteria        | None           |
| getTokenTotals       | `db, sessionIds`          | `TokenTotals`         | Aggregates token/cost data                 | None           |
| getByAgentModel      | `db, sessionIds`          | `AgentModelRow[]`     | Groups by agent+model from messages        | None           |
| getToolErrorRates    | `db, sessionIds`          | `ToolErrorRateRow[]`  | Tool call success/failure rates            | None           |
| getPartsWithMessages | `db, sessionId`           | `PartWithRole[]`      | All parts with message role for transcript | None           |
| getSessionMeta       | `db, sessionId`           | `SessionMeta \| null` | Full session metadata                      | None           |

### Config (config.ts)

| Method                | Input                  | Output          | Behavior                               | Errors                             |
| --------------------- | ---------------------- | --------------- | -------------------------------------- | ---------------------------------- |
| resolveInsightsConfig | `opencode.json config` | `PluginConfig`  | Reads `insights` section with defaults | None (falls back to defaults)      |
| parseModel            | `string?`              | `InsightsModel` | Parses "provider/model" string         | None (falls back to DEFAULT_MODEL) |

## Data Flow

| Step | Component      | Action                                                                                                                                                             | Next           |
| ---- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| 1    | InsightsPlugin | User invokes `/insights --days 14`; resolves config from `opencode.json`                                                                                           | Orchestrator   |
| 2    | Orchestrator   | Opens DB read-only via `bun:sqlite`                                                                                                                                | DB             |
| 3    | DB             | `filterSessions()` returns session IDs within time range + project filter                                                                                          | Extract        |
| 4    | Extract        | `aggregateAll()` runs SQL queries for stats (tokens, costs, tools, agents)                                                                                         | Analyze        |
| 5    | Analyze        | `extractFacets()` — for each uncached session: reconstruct transcript → prepareTranscript (chunk if >30k chars) → build facet prompt → callLlm → normalize → cache | LLM            |
| 6    | LLM            | `callLlm()` — `Provider.getSmallModel()` → `Provider.getLanguage()` → `generateText()` → return text                                                               | Analyze        |
| 7    | Analyze        | `runAggregateAnalysis()` — 8 parallel prompts (project_areas, friction, suggestions, etc.)                                                                         | LLM            |
| 8    | Analyze        | `generateAtAGlance()` — synthesis prompt over all aggregates                                                                                                       | LLM            |
| 9    | Report         | `generateReport()` — produces self-contained HTML from stats + facets + aggregates                                                                                 | Orchestrator   |
| 10   | Orchestrator   | Writes HTML + JSON to output path, returns InsightsResult                                                                                                          | InsightsPlugin |
| 11   | InsightsPlugin | Opens report in browser, shows toast, returns summary to agent                                                                                                     | User           |

**Error Flows**:

- **DB not found**: `openDb()` throws → caught in tool execute → returns error message to user
- **LLM unavailable** (no small_model configured): `resolveModel()` returns undefined → graceful error: "No model available for insights. Configure `small_model` in opencode.json"
- **Per-session LLM failure**: `extractFacets()` catches per-session errors silently, skips session, continues pipeline
- **Aggregate LLM failure**: Individual aggregate prompts fail → that key gets `{}`, report renders "(analysis unavailable)"
- **Large transcript**: If >30k chars, chunked and summarized first; if chunk-summary fails, hard-truncated
- **Cache miss on force**: Cache cleared, all sessions re-extracted

## Data Model

| Entity          | Fields                                                                                                                                                                                                                                                                            | Relationships              | Constraints               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------- |
| SessionFacet    | sessionId: string, underlyingGoal: string, goalCategories: Record<GoalCategory, number>, outcome: string, satisfaction: Record<SatisfactionLevel, number>, frictionCounts: Record<FrictionCategory, number>, frictionDetail: string, primarySuccess: string, briefSummary: string | Keyed by session ID        | Cached as JSON files      |
| AggregatedStats | totalSessions, analyzedSessions, dateRange, totalMessages, totalCost, totalTokens, topTools, topAgents, topModels, byAgentModel, toolErrorRates, cacheEfficiency, costPer1k, agentDelegation                                                                                      | Computed from session IDs  | Ephemeral (not persisted) |
| InsightsConfig  | model: InsightsModel, days: number, force: boolean, concurrency: number, maxSessions: number, projectOnly: boolean, output: string                                                                                                                                                | References provider config | Validated with defaults   |
| InsightsResult  | reportPath, jsonPath, atAGlance, sessionCount, analyzedCount, totalCost                                                                                                                                                                                                           | Output of pipeline         | Ephemeral                 |

**Note**: No new DB tables. Insights reads from existing `session`, `message`, and `part` tables read-only.

## DB Query Compatibility — Schema Mapping

**Critical divergence**: opencode-x session table does NOT have `agent` or `model` columns. These are stored in message `data` JSON.

| insights `db.ts` query                                                | opencode-x column               | Adaptation needed                                                                   |
| --------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------- |
| `session.cost`                                                        | `session.cost`                  | ✅ Direct match                                                                     |
| `session.tokens_input`                                                | `session.tokens_input`          | ✅ Direct match                                                                     |
| `session.tokens_output`                                               | `session.tokens_output`         | ✅ Direct match                                                                     |
| `session.tokens_reasoning`                                            | `session.tokens_reasoning`      | ✅ Direct match                                                                     |
| `session.tokens_cache_read`                                           | `session.tokens_cache_read`     | ✅ Direct match                                                                     |
| `session.tokens_cache_write`                                          | `session.tokens_cache_write`    | ✅ Direct match                                                                     |
| `session.id, title, directory, parent_id, time_created, time_updated` | Same columns                    | ✅ Direct match                                                                     |
| `session.agent`                                                       | ❌ Does not exist               | ⚠️ Must derive from `message.data → $.agent` (first assistant msg or most frequent) |
| `session.model` (JSON or string)                                      | ❌ Does not exist               | ⚠️ Must derive from `message.data → $.model` or use `session.cost_by_model` JSON    |
| `message.session_id`                                                  | `message.session_id`            | ✅ Direct match                                                                     |
| `message.data` (JSON with role)                                       | `message.data` (JSON with role) | ✅ Direct match — `json_extract(data, '$.role')` works                              |
| `part.session_id, data`                                               | `part.session_id, data`         | ✅ Direct match                                                                     |
| `json_extract(part.data, '$.type')`                                   | Same                            | ✅ Part data schema unchanged                                                       |
| `json_extract(part.data, '$.tool')`                                   | Same                            | ✅ Tool parts have `$.tool` field                                                   |
| `json_extract(part.data, '$.state.status')`                           | Same                            | ✅ Tool state tracking unchanged                                                    |

### Required Query Rewrites

1. **`getByAgentModel()`** — Currently queries `session.agent` and `session.model` directly.
   - **Rewrite**: Join to `message` table, extract agent/model from first assistant message JSON:
     ```sql
     SELECT
       json_extract(m.data, '$.agent') as agent,
       json_extract(m.data, '$.modelID') as model,
       ...
     FROM session s
     JOIN message m ON m.session_id = s.id
     WHERE json_extract(m.data, '$.role') = 'assistant'
     ```
   - **Alternative**: Use `session.cost_by_model` JSON column (has per-model breakdowns already computed). Parse keys for model names.

2. **`getCacheEfficiency()`** — Groups by `session.model`.
   - **Rewrite**: Use `session.cost_by_model` JSON keys as model identifiers, or aggregate from message data.

3. **`getCostPer1k()`** — Groups by `session.model`.
   - **Rewrite**: Same approach as getCacheEfficiency.

4. **`getAgentDelegation()`** — Uses `session.agent` on parent and child.
   - **Rewrite**: For each session, find the first assistant message's `$.agent` field.

5. **`getSessionMeta()` → modelCounts, agentCounts** — Already queries message JSON (`json_extract(m.data, '$.agent')`). ✅ Works as-is.

6. **`MODEL_NAME_SQL`** — Parses `session.model` as JSON.
   - **Rewrite**: Not applicable at session level. Model name comes from message data or `cost_by_model` keys.

### Recommended Strategy

Use `session.cost_by_model` (JSON column, key = `"providerID/modelID"`) for model-level aggregations where possible. For agent-level: derive from first assistant message per session via subquery. This avoids N+1 and keeps queries efficient.

## Config Schema Integration

Add `insights` key to the config schema (alongside `experimental`, `mcp`, etc.):

```typescript
// In config.ts schema, add to the root config object:
insights: z.object({
  model: z
    .string()
    .optional()
    .describe("Model for insights analysis (format: provider/model). Falls back to small_model"),
  days: z.number().int().min(1).max(365).default(30).optional().describe("Days of history to analyze"),
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(16)
    .default(4)
    .optional()
    .describe("Max parallel LLM calls during extraction"),
  max_sessions: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(200)
    .optional()
    .describe("Max sessions to extract per run (cost brake)"),
}).optional()
```

**Config resolution precedence**:

1. Tool args (`--days`, `--model`, `--force`, `--output`, `--all`)
2. `opencode.json` → `insights` section
3. Defaults (days=30, concurrency=4, maxSessions=200)
4. Model fallback: `insights.model` → `small_model` → provider-specific priority list

**Removal**: Standalone `~/.config/opencode/insights.json` is eliminated. Config folds into main `opencode.json`.

## LLM Layer Design

### Current (to be replaced)

```typescript
// Creates temp session → prompts → deletes session (writes to DB, cleanup)
async function runLlm(client: LlmClient, opts: LlmCallOptions): Promise<string> {
  const session = await client.session.create({...})
  const result = await client.session.prompt({...})
  await client.session.delete({...})
  return text
}
```

### New (direct generateText)

```typescript
import { generateText, wrapLanguageModel } from "ai"
import { Provider } from "@/provider/provider"

export interface LlmCallOptions {
  model: LanguageModelV3 // Already resolved
  prompt: string
  system?: string
  timeout?: number // Default: 30_000ms
}

export async function callLlm(opts: LlmCallOptions): Promise<string> {
  const response = await generateText({
    model: wrapLanguageModel({ model: opts.model, middleware: [] }),
    system: opts.system,
    messages: [{ role: "user", content: opts.prompt }],
    temperature: 0,
    maxOutputTokens: 4096,
    abortSignal: AbortSignal.timeout(opts.timeout ?? 30_000),
  })
  return response.text
}
```

**Model resolution** (done once at pipeline start):

```typescript
// In InsightsPlugin.execute():
const model = await resolveInsightsModel(args.model, config.insights?.model)

async function resolveInsightsModel(argModel?: string, configModel?: string): Promise<LanguageModelV3> {
  // 1. Explicit model arg: parse "provider/model"
  // 2. Config insights.model
  // 3. Provider.getSmallModel(defaultProviderID)
  // 4. Error: no model available
  const parsed = parseModel(argModel ?? configModel)
  const providerModel = await Provider.getModel(parsed.providerID, parsed.modelID)
  return Provider.getLanguage(providerModel)
}
```

**Key differences from existing `llm-compress.ts` pattern**:

- Same `generateText()` + `wrapLanguageModel()` pattern (proven in codebase)
- No Auth.get() needed — `getLanguage()` handles auth internally
- No session DB writes (no ghost sessions)
- `mapLimit()` for concurrency (retained from original)

## Plugin Registration

### File: `src/plugin/insights/index.ts`

Plugin follows same pattern as `CodexAuthPlugin`:

```typescript
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

export const InsightsPlugin: Plugin = async (ctx) => {
  return {
    async config(cfg) {
      cfg.command ??= {}
      cfg.command.insights = {
        description: "Generate a usage insights report",
        template: "Call the insights tool with these arguments: $ARGUMENTS..."
      }
    },
    tool: {
      insights: tool({ description: "...", args: {...}, execute: async (args, toolCtx) => {...} })
    }
  }
}
```

### Registration in `src/plugin/index.ts`

```typescript
import { InsightsPlugin } from "./insights"

function internalPlugins(flags: {...}): PluginInstance[] {
  return [
    (input) => CodexAuthPlugin(input, {...}),
    CopilotAuthPlugin,
    GitlabAuthPlugin,
    PoeAuthPlugin,
    CloudflareWorkersAuthPlugin,
    CloudflareAIGatewayAuthPlugin,
    XaiAuthPlugin,
    InsightsPlugin,  // ← added
  ]
}
```

## Module Layout

```
packages/opencode/src/plugin/insights/
├── index.ts          # Plugin entry, tool + command registration
├── orchestrator.ts   # Pipeline coordination
├── analyze.ts        # Facet extraction + aggregate analysis
├── extract.ts        # Session filtering, transcript reconstruction, stats aggregation
├── db.ts             # Read-only SQLite queries (adapted for opencode-x schema)
├── llm.ts            # Direct generateText wrapper, extractJson, mapLimit
├── cache.ts          # Filesystem facet cache
├── config.ts         # Config resolution (parseModel, dateStamp)
├── prompts.ts        # All LLM prompt templates
├── report.ts         # HTML report generation
└── types.ts          # Type definitions, category constants
```

## File-by-File Port Guide

| File              | Changes Required                                                                                                                                                                                                                                        | Effort      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `types.ts`        | Direct copy. No changes.                                                                                                                                                                                                                                | Trivial     |
| `prompts.ts`      | Direct copy. No changes.                                                                                                                                                                                                                                | Trivial     |
| `cache.ts`        | Direct copy. No changes (uses `node:fs`, `node:path`).                                                                                                                                                                                                  | Trivial     |
| `report.ts`       | Direct copy. No changes (pure HTML string generation).                                                                                                                                                                                                  | Trivial     |
| `config.ts`       | Remove `loadPluginConfig()` (replaced by opencode.json reading). Keep `parseModel()` and `dateStamp()`.                                                                                                                                                 | Low         |
| `extract.ts`      | Direct copy. `filterSessions()` and `reconstructTranscript()` unchanged.                                                                                                                                                                                | Trivial     |
| `llm.ts`          | **Major rewrite**. Replace `runLlm()` (session-based) with `callLlm()` (direct `generateText()`). Keep `extractJson()` and `mapLimit()` unchanged. Remove `LlmClient` interface.                                                                        | Medium      |
| `db.ts`           | **Significant adaptation**. Queries using `session.agent` and `session.model` must be rewritten to derive from message JSON or `cost_by_model`. Token/cost queries unchanged. `getPartsWithMessages()`, `getSessionMeta()` mostly work.                 | Medium-High |
| `analyze.ts`      | Update `runLlm()` calls to `callLlm()`. Change signature to accept `LanguageModelV3` instead of `LlmClient`. Rest of logic (prepareTranscript, normalizeCategories, AGGREGATE_PROMPTS) unchanged.                                                       | Low         |
| `orchestrator.ts` | Update to pass resolved `LanguageModelV3` instead of `LlmClient`. Remove `client` from `OrchestratorDeps`, add `model: LanguageModelV3`.                                                                                                                | Low         |
| `index.ts`        | **Significant rewrite**. Remove SDK client dependency (`ctx.client.session.*`). Resolve model via `Provider.getSmallModel()` + `Provider.getLanguage()`. Read config from `opencode.json` instead of standalone file. Keep tool registration structure. | Medium      |

## Decisions

| Decision               | Choice                                    | Reason                                                                   | Alternatives                             | Tradeoffs                                                                         |
| ---------------------- | ----------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------- | --------------------------------------------------------------------------------- |
| LLM approach           | Direct `generateText()`                   | Lightest weight: no DB writes, no session cleanup, no SDK round-trips    | Session-based (current), Effect-wrapped  | Loses token tracking for insights runs (acceptable — analysis cost is negligible) |
| Model resolution       | `Provider.getSmallModel()` with fallback  | Reuses existing resolution logic, respects `small_model` config          | Hardcoded model, custom resolution       | Depends on Provider being initialized                                             |
| DB access              | Direct `bun:sqlite` readonly              | Matches original approach, fast, no ORM overhead for read-only analytics | Drizzle queries, Effect DB service       | Bypasses Drizzle, raw SQL (fine for read-only analytics)                          |
| Agent/model derivation | Query from message JSON + `cost_by_model` | `session` table lacks agent/model columns                                | Add columns via migration                | Migration adds complexity, message JSON already has the data                      |
| Config location        | `opencode.json` → `insights` key          | Single config file, consistent with other features                       | Standalone file, env vars                | Users must migrate from `insights.json`                                           |
| Facet cache            | Filesystem JSON (unchanged)               | Simple, portable, version-keyed, survives restarts                       | SQLite table, in-memory                  | Disk I/O (fast for small JSON files)                                              |
| Plugin registration    | Built-in (`internalPlugins[]`)            | Always available, no install step, follows existing pattern              | External plugin, npm package             | Cannot be uninstalled (acceptable for core feature)                               |
| Concurrency            | `mapLimit()` (unchanged)                  | Simple, proven, configurable                                             | Effect.forEach with concurrency, p-limit | No Effect integration overhead                                                    |

## Risks

| Risk                                                 | Impact                            | Likelihood       | Mitigation                                                |
| ---------------------------------------------------- | --------------------------------- | ---------------- | --------------------------------------------------------- |
| Schema divergence (no agent/model on session)        | Queries fail or return wrong data | High (confirmed) | Rewrite 4 queries to use message JSON + cost_by_model     |
| Provider not initialized when tool runs              | LLM calls fail                    | Low              | Plugin loads after providers; add guard with clear error  |
| Large DB (>1000 sessions)                            | Slow facet extraction             | Medium           | maxSessions cap (200), caching, concurrency               |
| Model not available                                  | Pipeline cannot run               | Medium           | Graceful error: "Configure small_model or insights.model" |
| Prompt injection via session transcripts             | LLM follows embedded instructions | Low              | UNTRUSTED nonce guards in prompts (already implemented)   |
| Report file write failure                            | No output                         | Low              | mkdirSync recursive, clear error message                  |
| cost_by_model column missing (old DBs pre-migration) | Model grouping queries fail       | Low              | Fallback to message-level derivation; COALESCE in SQL     |

## Test Plan

### Unit Tests

**File: `test/plugin/insights/llm.test.ts`**

- `extractJson()`: valid JSON, markdown-fenced JSON, no JSON object, nested fences, JSON with code fences in values
- `mapLimit()`: concurrency=1 (serial), concurrency>items, errors propagate, empty array
- `parseModel()`: "anthropic/claude-haiku-4-5", "claude-haiku-4-5" (no provider), empty string, undefined

**File: `test/plugin/insights/extract.test.ts`**

- `filterSessions()`: date filtering, project directory filtering, empty DB
- `reconstructTranscript()`: text parts, tool parts with status, reasoning parts (truncated), mixed roles
- `aggregateAll()`: token totals, tool error rates, agent delegation

**File: `test/plugin/insights/config.test.ts`**

- `resolveInsightsConfig()`: all defaults, partial config, invalid values (fall to defaults)
- `dateStamp()`: format matches YYYY-MM-DD

**File: `test/plugin/insights/analyze.test.ts`**

- `normalizeCategories()`: valid categories kept, invalid stripped, missing values → 0
- `normalizeFacet()`: both camelCase and snake_case field names, missing fields default to ""
- `prepareTranscript()`: short passthrough (<30k), long chunked, chunk failure → hard truncate

**File: `test/plugin/insights/report.test.ts`**

- `generateReport()`: produces valid HTML, escapes special characters, handles empty aggregates

**File: `test/plugin/insights/db.test.ts`**

- `getTokenTotals()`: empty IDs → zeros, chunked queries (>500 IDs), correct sums
- `getByAgentModel()`: derives agent/model from message JSON correctly
- `getToolErrorRates()`: error/success counting, chunk merge
- `getSessionMeta()`: null session, valid session with all fields

### Integration Tests

**File: `test/plugin/insights/pipeline.test.ts`**

- Full pipeline with seeded SQLite DB (create in-memory, insert test sessions/messages/parts)
- Mock `generateText()` to return canned JSON responses
- Verify: HTML file written, JSON file written, InsightsResult fields correct
- Verify: progress callback fired with correct phases
- Verify: cache populated after extraction, second run uses cache
- Verify: `force` flag bypasses cache

### End-to-End Tests

- Plugin loads successfully in `internalPlugins[]` (no import errors)
- `/insights` command registered and visible in command list
- Tool schema validates args correctly (days: 1-365, force: boolean, etc.)
- With real DB data: produces non-empty HTML report (requires actual sessions in test DB)

### Non-Functional Tests

- **Performance**: 200 sessions extracted within 5 minutes at concurrency=4 (dependent on LLM latency)
- **Cost**: Full run with haiku ≈ $0.10-0.50 (verify token counts in test)
- **Security**: Prompt injection guards (UNTRUSTED markers) present in all prompts that include session data
- **Idempotency**: Running twice with cache → second run fast (only cache reads)
- **Isolation**: No DB writes to opencode.db during insights run (verified by checking WAL after run)
