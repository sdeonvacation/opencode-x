# HLD: Deep Research Workflow

## Summary

Multi-phase autonomous research orchestrator that splits a user question into parallel web searches, reads top sources, extracts falsifiable facts, cross-checks each via adversarial jury (majority-reject kills a fact), then synthesizes a cited report with certainty ratings. Gated by `experimental.deep_research` config flag. Exposed as a tool (`research`) and slash command (`/research`).

## Architecture Diagram

```
┌────────────────────────────────────────────────────────────────────────┐
│                           TUI Layer                                     │
│                                                                        │
│  /research ──▶ DialogPrompt ──▶ inject "use research tool" into session│
└────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────────────┐
│                     Tool: research (src/tool/research.ts)               │
│                                                                        │
│  - Validates flag gate                                                 │
│  - Asks permission once (batch-approve pattern)                        │
│  - Delegates to Engine.run()                                           │
│  - Returns formatted report + stats                                    │
└────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────────────┐
│                  Engine (src/research/engine.ts)                        │
│                                                                        │
│  Phase 1: Plan ──▶ generateObject → SearchPlan (queries + angles)      │
│  Phase 2: Search ──▶ parallel websearch calls (via McpExa)             │
│  Phase 3: Read ──▶ parallel webfetch for top URLs (budget-capped)      │
│  Phase 4: Extract ──▶ generateObject per source → facts[]              │
│  Phase 5: Group ──▶ generateObject → deduplicated fact groups          │
│  Phase 6: Crosscheck ──▶ Jury.evaluate() per fact (parallel jurors)    │
│  Phase 7: Report ──▶ generateObject → cited markdown report            │
│                                                                        │
│  Progress: Bus.publish(Research.Event.PhaseChanged, {...})              │
│  Abort: signal propagation to all in-flight LLM calls                  │
└────────────────────────────────────────────────────────────────────────┘
         │              │               │                │
         ▼              ▼               ▼                ▼
┌──────────────┐ ┌────────────┐ ┌─────────────┐ ┌──────────────────┐
│ Jury Module  │ │ URL Module │ │ Prompts     │ │ Tunables         │
│              │ │            │ │             │ │                  │
│ spawn jurors │ │ canonicalize│ │ per-phase   │ │ JURY_SIZE=3      │
│ tally votes  │ │ dedup map  │ │ prompt      │ │ REJECT_QUORUM=2  │
│ apply quorum │ │ budget     │ │ builders    │ │ SOURCE_BUDGET=15 │
│              │ │ tracking   │ │             │ │ FACT_CAP=25      │
└──────────────┘ └────────────┘ └─────────────┘ └──────────────────┘
         │
         ▼
┌────────────────────────────────────────────────────────────────────────┐
│                 SQLite: research_run table                              │
│                                                                        │
│  Stores full run metadata, stats, status for history/debugging         │
└────────────────────────────────────────────────────────────────────────┘
```

## Components

### Component 1: Schema

- **File**: `src/research/schema.ts`
- **Type**: Pure Module (zod schemas + branded types)
- **Exports**: `ResearchID`, `SearchPlan`, `SearchHit`, `SourceRead`, `Fact`, `FactGroup`, `JurorRuling`, `Report`, `RunStatus`, `RunStats`
- **Dependencies**: `zod`
- **Interface**:

  ```typescript
  export type ResearchID = string & { readonly __tag: "ResearchID" }
  export const ResearchID = {
    generate: (): ResearchID => `res_${crypto.randomUUID()}` as ResearchID,
    zod: z
      .string()
      .startsWith("res_")
      .transform((s) => s as ResearchID),
  }

  export const SearchPlan = z.object({
    queries: z
      .array(
        z.object({
          query: z.string(),
          angle: z.string(),
        }),
      )
      .min(1)
      .max(6),
  })

  export const SearchHit = z.object({
    url: z.string().url(),
    title: z.string(),
    snippet: z.string(),
  })

  export const SourceRead = z.object({
    url: z.string().url(),
    title: z.string(),
    content: z.string(),
    relevance: z.number().min(0).max(1),
  })

  export const Fact = z.object({
    claim: z.string(),
    source_urls: z.array(z.string().url()),
    confidence: z.enum(["high", "medium", "low"]),
  })

  export const FactGroup = z.object({
    facts: z.array(Fact),
    topic: z.string(),
  })

  export const JurorRuling = z.object({
    verdict: z.enum(["support", "reject", "abstain"]),
    reasoning: z.string(),
  })

  export const Report = z.object({
    title: z.string(),
    summary: z.string(),
    sections: z.array(
      z.object({
        heading: z.string(),
        body: z.string(),
        citations: z.array(z.number()),
      }),
    ),
    sources: z.array(
      z.object({
        index: z.number(),
        url: z.string().url(),
        title: z.string(),
      }),
    ),
    certainty: z.enum(["high", "medium", "low", "inconclusive"]),
  })

  export type RunStatus = "running" | "completed" | "failed" | "aborted" | "inconclusive"

  export const RunStats = z.object({
    queries: z.number(),
    sources_fetched: z.number(),
    facts_extracted: z.number(),
    facts_survived: z.number(),
    facts_rejected: z.number(),
    llm_calls: z.number(),
    duration_ms: z.number(),
  })
  ```

### Component 2: Database Table

- **File**: `src/research/research.sql.ts`
- **Type**: Schema (drizzle table definition)
- **Exports**: `ResearchRunTable`
- **Dependencies**: `drizzle-orm/sqlite-core`, `SessionTable`
- **Interface**:

  ```typescript
  import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
  import { SessionTable } from "../session/session.sql"
  import type { ResearchID } from "./schema"
  import type { SessionID } from "../session/schema"

  export const ResearchRunTable = sqliteTable(
    "research_run",
    {
      id: text().$type<ResearchID>().primaryKey(),
      session_id: text()
        .$type<SessionID>()
        .notNull()
        .references(() => SessionTable.id, { onDelete: "cascade" }),
      question: text().notNull(),
      status: text().notNull().default("running"),
      stats_json: text(),
      report_json: text(),
      created_at: integer().notNull(),
      completed_at: integer(),
    },
    (table) => [index("research_run_session_idx").on(table.session_id)],
  )
  ```

### Component 3: Tunables

- **File**: `src/research/tunables.ts`
- **Type**: Pure Module (constants + config override reader)
- **Exports**: `Tunables`, `resolve`
- **Dependencies**: `Config`
- **Interface**:

  ```typescript
  export const Tunables = {
    JURY_SIZE: 3,
    REJECT_QUORUM: 2,
    SOURCE_BUDGET: 15,
    FACT_CAP: 25,
    PHASE_TIMEOUT_MS: 60_000,
    MAX_QUERIES: 6,
  } as const

  export type Resolved = typeof Tunables

  export function resolve(overrides?: Partial<Resolved>): Resolved
  ```

### Component 4: URL Utilities

- **File**: `src/research/url.ts`
- **Type**: Pure Module (URL normalization + budget tracking)
- **Exports**: `canonicalize`, `DedupMap`, `allocate`
- **Dependencies**: none (pure functions)
- **Interface**:

  ```typescript
  /** Normalize URL: strip tracking params, lowercase host, remove trailing slash */
  export function canonicalize(raw: string): string

  /** Dedup map tracking seen URLs. Returns true if new, false if duplicate. */
  export class DedupMap {
    add(url: string): boolean
    has(url: string): boolean
    size(): number
  }

  /** Allocate budget slots across queries. Returns top N URLs by relevance. */
  export function allocate(input: { hits: Array<{ url: string; relevance?: number }>; budget: number }): string[]
  ```

### Component 5: Prompts

- **File**: `src/research/prompts.ts`
- **Type**: Pure Module (prompt template builders)
- **Exports**: `plan`, `extract`, `group`, `crosscheck`, `report`
- **Dependencies**: none (string builders)
- **Interface**:
  ```typescript
  export function plan(question: string): string
  export function extract(input: { question: string; source: { url: string; content: string } }): string
  export function group(input: { question: string; facts: Array<{ claim: string; source_urls: string[] }> }): string
  export function crosscheck(input: { claim: string; sources: string[] }): string
  export function report(input: {
    question: string
    facts: Array<{ claim: string; confidence: string; source_urls: string[] }>
  }): string
  ```

### Component 6: Jury

- **File**: `src/research/jury.ts`
- **Type**: Pure Module (crosscheck logic)
- **Exports**: `evaluate`, `Verdict`
- **Dependencies**: `schema.ts`, `tunables.ts`, `prompts.ts`
- **Interface**:

  ```typescript
  export type Verdict = "kept" | "rejected" | "unproven"

  export type JuryResult = {
    claim: string
    verdict: Verdict
    rulings: Array<{ verdict: string; reasoning: string }>
    support: number
    reject: number
    abstain: number
  }

  /** Run jury evaluation for a batch of facts. Returns verdicts per fact. */
  export async function evaluate(input: {
    facts: Array<{ claim: string; source_urls: string[] }>
    sources: Map<string, string>
    generate: GenerateFn
    tunables: Resolved
    signal?: AbortSignal
  }): Promise<JuryResult[]>

  type GenerateFn = (prompt: string, schema: z.ZodType) => Promise<unknown>
  ```

### Component 7: Engine

- **File**: `src/research/engine.ts`
- **Type**: Pure Module (main orchestrator)
- **Exports**: `run`, `RunResult`
- **Dependencies**: `schema.ts`, `tunables.ts`, `url.ts`, `prompts.ts`, `jury.ts`, AI SDK `generateObject`, `McpExa`, `Bus`, `Database`, concurrency module
- **Interface**:

  ```typescript
  export type RunResult = {
    id: ResearchID
    report: z.infer<typeof Report>
    stats: z.infer<typeof RunStats>
    status: RunStatus
  }

  export async function run(input: {
    question: string
    sessionID: SessionID
    signal: AbortSignal
    tunables?: Partial<Resolved>
  }): Promise<RunResult>
  ```

### Component 8: Tool Definition

- **File**: `src/tool/research.ts`
- **Type**: Tool (Tool.define pattern)
- **Exports**: `ResearchTool`
- **Dependencies**: `Tool`, `engine.ts`, `Config`, `Flag`
- **Interface**:
  ```typescript
  export const ResearchTool = Tool.define("research", {
    description: string, // loaded from research.txt
    parameters: z.object({
      question: z.string().describe("The research question to investigate"),
    }),
    async execute(args, ctx): Promise<{ title: string; metadata: {}; output: string }>
  })
  ```

### Component 9: Tool Description

- **File**: `src/tool/research.txt`
- **Type**: Static text asset
- **Exports**: default text string (imported as `DESCRIPTION`)
- **Dependencies**: none

### Component 10: Slash Command

- **File**: `src/cli/cmd/tui/command/research-command.tsx`
- **Type**: TUI Command (Solid.js pattern)
- **Exports**: `createResearchCommand`
- **Dependencies**: `DialogPrompt`, `DialogContext`, `ToastContext`
- **Interface**:

  ```typescript
  export type ResearchCommandDeps = {
    dialog: Pick<DialogContext, "clear" | "replace">
    toast: Pick<ToastContext, "show">
    route: { data: { type: string; sessionID?: string } }
    submit: (text: string) => void
  }

  export function createResearchCommand(deps: ResearchCommandDeps): CommandOption
  ```

### Component 11: Bus Events

- **File**: `src/research/events.ts`
- **Type**: Pure Module (BusEvent definitions)
- **Exports**: `ResearchEvent`
- **Dependencies**: `BusEvent`, `zod`
- **Interface**:
  ```typescript
  export const ResearchEvent = {
    PhaseChanged: BusEvent.define(
      "research.phase-changed",
      z.object({
        sessionID: SessionID.zod,
        runID: z.string(),
        phase: z.enum(["plan", "search", "read", "extract", "group", "crosscheck", "report"]),
        progress: z.string().optional(),
      }),
    ),
    Completed: BusEvent.define(
      "research.completed",
      z.object({
        sessionID: SessionID.zod,
        runID: z.string(),
        status: z.enum(["completed", "failed", "aborted", "inconclusive"]),
      }),
    ),
  }
  ```

## Data Flow

### Main Flow: `/research "What is X?"`

| Step | Component         | Action                                                                     | Next       |
| ---- | ----------------- | -------------------------------------------------------------------------- | ---------- |
| 1    | TUI `/research`   | Show dialog, get question, inject into session prompt                      | Tool call  |
| 2    | `research` tool   | Validate flag, ask permission (batch-approve `always: ["*"]`), call Engine | Engine     |
| 3    | Engine: Plan      | `generateObject` → `SearchPlan` (1-6 query angles)                         | Search     |
| 4    | Engine: Search    | `Promise.allSettled` → parallel websearch per query, collect hits          | URL alloc  |
| 5    | Engine: URL Alloc | Canonicalize, dedup, rank by relevance, cap to `SOURCE_BUDGET`             | Read       |
| 6    | Engine: Read      | `Promise.allSettled` → parallel webfetch for allocated URLs                | Extract    |
| 7    | Engine: Extract   | `generateObject` per source → extract falsifiable facts                    | Group      |
| 8    | Engine: Group     | `generateObject` → merge/dedup facts, cap to `FACT_CAP`                    | Crosscheck |
| 9    | Jury: Crosscheck  | Per fact: spawn `JURY_SIZE` jurors via `generateObject`, tally votes       | Filter     |
| 10   | Engine: Filter    | Apply quorum (≥`REJECT_QUORUM` reject → kill; all-abstain → unproven)      | Report     |
| 11   | Engine: Report    | `generateObject` → final cited markdown with certainty rating              | Persist    |
| 12   | Engine: Persist   | Write `research_run` row (stats, report JSON), publish completion event    | Return     |
| 13   | Tool: Format      | Format report markdown + stats summary, return to session                  | Session    |

### Error Flows

- **Structured output parse failure**: zod `.safeParse()` → log warning, treat as empty/skip, continue with partial data
- **All facts rejected by jury**: Set status `"inconclusive"`, return report showing rejected facts for transparency
- **Phase timeout**: `AbortSignal.timeout(PHASE_TIMEOUT_MS)` per phase → graceful degradation with partial results gathered so far
- **Session abort**: Signal propagated to all in-flight `generateObject` + `webfetch` calls via `ctx.abort`
- **Rate limit / concurrency**: Use existing `acquire`/`release` from `src/orchestration/concurrency.ts` keyed by provider
- **Empty search results**: Skip read/extract phases for that query, continue with other queries

## Database Schema

```typescript
// src/research/research.sql.ts
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/session.sql"

export const ResearchRunTable = sqliteTable(
  "research_run",
  {
    id: text().primaryKey(), // ResearchID ("res_<uuid>")
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    question: text().notNull(),
    status: text().notNull().default("running"), // running|completed|failed|aborted|inconclusive
    stats_json: text(), // JSON: RunStats
    report_json: text(), // JSON: Report (full structured data)
    created_at: integer().notNull(),
    completed_at: integer(),
  },
  (table) => [index("research_run_session_idx").on(table.session_id)],
)
```

Migration: `bun run db generate --name deep_research`

## Configuration

Addition to `experimental` object in `src/config/config.ts`:

```typescript
deep_research: z.boolean().optional().describe("Enable deep research workflow tool and /research command"),
```

Optional tunables override (nested under experimental):

```typescript
deep_research_tunables: z.object({
  jury_size: z.number().int().min(1).max(5).optional(),
  reject_quorum: z.number().int().min(1).optional(),
  source_budget: z.number().int().min(1).max(30).optional(),
  fact_cap: z.number().int().min(1).max(50).optional(),
  phase_timeout_ms: z.number().int().positive().optional(),
}).optional().describe("Override deep research tunables"),
```

## Feature Flag

- **Flag**: `OPENCODE_EXPERIMENTAL_DEEP_RESEARCH`
- **Pattern**: `enabledByExperimental` (inherits from `OPENCODE_EXPERIMENTAL`)
- **Location**: `src/flag/flag.ts`
- **Declaration**:
  ```typescript
  export const OPENCODE_EXPERIMENTAL_DEEP_RESEARCH = enabledByExperimental("OPENCODE_EXPERIMENTAL_DEEP_RESEARCH")
  ```
- **Gating behavior**: Tool excluded from registry when flag is false AND `cfg.experimental?.deep_research` is not true. Slash command hidden when flag inactive.

## Integration Points

| Location                                   | Change                                                                                                         | Type                              |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `src/flag/flag.ts`                         | Add `OPENCODE_EXPERIMENTAL_DEEP_RESEARCH`                                                                      | Additive (1 line)                 |
| `src/config/config.ts` experimental schema | Add `deep_research` + `deep_research_tunables` fields                                                          | Additive (2 schema fields)        |
| `src/tool/registry.ts` infos()             | Add `...(Flag.OPENCODE_EXPERIMENTAL_DEEP_RESEARCH \|\| cfg.experimental?.deep_research ? [ResearchTool] : [])` | Additive (1 line in array spread) |
| `src/tool/registry.ts` imports             | Add `import { ResearchTool } from "./research"`                                                                | Additive (1 import)               |
| `src/cli/cmd/tui/command/`                 | New file `research-command.tsx`                                                                                | New file                          |
| TUI command registration                   | Add `createResearchCommand(deps)` to command list                                                              | Additive (1 line)                 |

## Error Handling

```
Tool Layer
├── Flag/config check → return "Deep research not enabled" message
├── Permission denied → standard tool permission error propagation
└── Engine errors ↓

Engine Layer
├── generateObject parse failure → safeParse, log warn, skip/empty fallback
├── Phase timeout → AbortSignal.timeout, return partial results
├── All queries fail → status "failed", return error message
├── All facts rejected → status "inconclusive", show rejected facts
├── Network errors (websearch/webfetch) → Promise.allSettled, skip failed
└── Concurrency limit → acquire() queues, respects session abort signal

Persistence Layer
├── DB write failure → log error, still return in-memory result to user
└── Session FK cascade → run deleted when session deleted
```

## Constraints

- **Upstream-rebase safe**: All new files under `src/research/` and `src/tool/research.{ts,txt}`. Only 3 existing files touched with single additive lines (flag.ts, config.ts, registry.ts). Minimal merge conflict surface.
- **Provider cache**: No impact. Research tool runs are independent sessions of `generateObject` calls. No modification to existing streaming/caching paths.
- **Performance**: Hard-capped by `SOURCE_BUDGET` (15 sources), `FACT_CAP` (25 facts), `JURY_SIZE` (3 jurors). Worst case: ~15 + 15 + 1 + 25×3 + 1 = ~107 LLM calls (most are small structured outputs). Concurrency semaphore prevents provider overload. Phase timeouts prevent runaway execution.
- **Token budget**: Full research report stored in `research_run` table, only summary returned to session context to avoid blowing up context window.

## Test Plan

### Unit Tests (`test/research/`)

| File               | Scenarios                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `schema.test.ts`   | Parse valid/invalid for each schema shape, ResearchID generation                                         |
| `url.test.ts`      | Canonicalization (tracking params, trailing slash, case), DedupMap add/has/size, allocate budget capping |
| `jury.test.ts`     | Quorum: 2/3 reject → killed, 2/3 support → kept, all abstain → unproven, mixed edge cases                |
| `tunables.test.ts` | Default values, partial overrides, full overrides                                                        |

### Integration Tests (`test/research/`)

| File             | Scenarios                                                                                                                                             |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine.test.ts` | Full pipeline with mocked `generateObject` (fixture responses per phase), abort mid-flow, timeout handling, all-reject scenario, empty search results |
| `tool.test.ts`   | Flag gating (disabled returns error), permission flow, report formatting                                                                              |

### Edge Cases

- All search queries return 0 results → graceful "no sources found" response
- All facts rejected → "inconclusive" with transparency
- Single source → still runs jury (reduced confidence)
- Abort signal mid-crosscheck → partial results persisted
- `generateObject` returns malformed output → zod safeParse catches, logged, skipped

## Decisions

| Decision                                 | Choice                                     | Reason                                                                          | Alternatives                   | Tradeoffs                                                  |
| ---------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------- |
| Namespace module vs Effect Service       | Namespace module (like Goal)               | Engine is stateless orchestration, no service dependencies needed beyond DB/Bus | Full Effect Service with Layer | Simpler, less boilerplate, matches Goal pattern            |
| `generateObject` over `streamText`       | `generateObject` for all structured phases | Need typed parsed output, not streaming tokens                                  | `streamText` + manual parse    | Lose streaming progress for phases, but gain type safety   |
| Parallel search via `Promise.allSettled` | allSettled (not all)                       | Partial failures should not abort entire research                               | `Promise.all`                  | Never throws on single query failure                       |
| Store full report in DB, return summary  | Separate full/summary                      | Avoid blowing session context with 25-fact report                               | Return everything inline       | Extra storage, but preserves context budget                |
| One tool (not agent)                     | Tool.define                                | Simpler integration, runs within existing agent loop                            | Dedicated research agent       | Tool fits existing architecture, no new agent infra needed |
| Batch permission pattern                 | `always: ["*"]` on initial ask             | Avoid N permission prompts for sub-searches                                     | Per-call permission            | One upfront approval covers all sub-operations             |

## Risks

| Risk                                    | Impact                            | Likelihood | Mitigation                                                              |
| --------------------------------------- | --------------------------------- | ---------- | ----------------------------------------------------------------------- |
| Token explosion (107 LLM calls)         | High cost per research run        | Medium     | Hard caps (SOURCE_BUDGET, FACT_CAP), config overrides for lower budgets |
| Rate limiting from provider             | Research stalls/fails             | Medium     | Concurrency semaphore, backoff via existing orchestration infra         |
| Model returns invalid structured output | Phase skipped, incomplete results | Low        | safeParse + fallback, retry once on parse failure                       |
| Large context blowup from report        | Session overflow after research   | Medium     | Return compressed summary to session, full data in DB only              |
| Slow execution (2-5 min for full run)   | User thinks it's stuck            | High       | Phase progress events via Bus, TUI phase indicator                      |
| websearch/webfetch API downtime         | Search phase fails entirely       | Low        | allSettled tolerates partial failure, skip and note in report           |
