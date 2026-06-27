# HLD: /loop — Background Recurring Prompt Scheduler

## Tech Stack

| Category  | Technology         | Purpose                                           |
| --------- | ------------------ | ------------------------------------------------- |
| Language  | TypeScript 5.8     | Existing codebase standard                        |
| Runtime   | Bun 1.3.11         | Fast startup, native SQLite, file I/O             |
| Framework | Effect-ts 4.0-beta | Scheduler fiber, scoped lifecycle, error handling |
| Database  | SQLite + Drizzle   | Loop metadata persistence, session-scoped cascade |
| TUI       | @opentui/solid     | Slash commands, keybind panel, toast              |
| Server    | Hono               | REST routes for loop CRUD                         |
| Subagent  | BackgroundJob      | Non-blocking iteration execution                  |

## Components

| Component     | Responsibility                                           | Dependencies                                    |
| ------------- | -------------------------------------------------------- | ----------------------------------------------- |
| LoopTable     | SQLite schema, session-scoped with cascade delete        | Drizzle, SessionTable                           |
| Loop          | CRUD namespace (create, list, get, tick, cancel, expire) | Database, LoopTable, Log, Bus                   |
| LoopScheduler | Effect fiber ticking every 1s, spawns due iterations     | Loop, BackgroundJob, spawnSubagent, Config, Bus |
| LoopParser    | Interval syntax + prompt extraction + loop.md resolution | Filesystem                                      |
| LoopEvent     | Bus event definitions for loop lifecycle                 | BusEvent, zod                                   |
| LoopCommand   | TUI slash commands (/loop, /loops)                       | DialogPrompt, SDK client, Toast                 |
| LoopPanel     | Leader keybind panel for management                      | Keybind context, Loop list, dialog              |
| LoopRoutes    | Hono REST endpoints for loop CRUD                        | Loop namespace, validator                       |

## Architecture

```
User: /loop 5m check deploy status
         │
         ▼
┌─────────────────────────────┐
│  LoopParser                 │
│  "5m" → 300_000ms           │
│  "check deploy status"      │
│  loop.md fallback if empty  │
└──────────┬──────────────────┘
           ▼
┌─────────────────────────────┐
│  Loop.create()              │
│  INSERT LoopTable           │
│  Bus → loop.created         │
│  Toast: "Loop created"      │
└──────────┬──────────────────┘
           ▼
┌───────────────────────────────────────────────────────────────┐
│  LoopScheduler (Effect fiber, ticks every 1s via Schedule)    │
│                                                               │
│  Each tick:                                                   │
│    loops = Loop.listDue(now)                                  │
│    for each due loop:                                         │
│      if last_iteration_running → skip (overlap guard)         │
│      if tokens_used >= token_budget → terminate               │
│      if now >= expires_at → fire final + mark expired         │
│      else:                                                    │
│        spawn BackgroundSubagent(prompt, model, parentID)       │
│        Loop.tick() → update next_run_at with jitter           │
│        Bus → loop.iteration.started                           │
└───────────────────────────────────────────────────────────────┘
           ▼
┌───────────────────────────────────────────────────────┐
│  Background Subagent Session (via BackgroundExecutor)  │
│  - Uses small_model (or loop-specific model override) │
│  - Full tool access (bash, read, edit)                │
│  - Independent session, navigable in TUI              │
│  - On complete: Loop.tickComplete() updates metadata  │
│    tokens_used += iteration_tokens                    │
│    Bus → loop.iteration.complete                      │
└───────────────────────────────────────────────────────┘
           ▼
┌───────────────────────────────────────┐
│  TUI Integration                      │
│  - <leader>L → Loop management panel │
│  - /loops → list active loops         │
│  - Navigate to subagent output        │
│  - Footer: active count + countdown   │
└───────────────────────────────────────┘
```

**Description**: The loop system operates as a session-scoped background scheduler. The `LoopScheduler` is an Effect fiber (`Effect.forkScoped`) that runs a 1-second tick loop using `Schedule.spaced(Duration.seconds(1))`. On each tick, it queries for due loops and spawns iterations as independent background subagent sessions using existing `BackgroundJob` infrastructure. The scheduler fiber is created lazily on first loop creation and torn down when the session ends (via scope). Loops cascade-delete with their parent session in SQLite.

## Interfaces

### Loop Namespace (`src/loop/loop.ts`)

| Method        | Input                                                     | Output           | Behavior                                                     | Errors            |
| ------------- | --------------------------------------------------------- | ---------------- | ------------------------------------------------------------ | ----------------- |
| create        | `{ sessionID, prompt, intervalMs, model?, tokenBudget? }` | `Loop.Info`      | Insert row, publish `loop.created`, enforce max 20 cap       | MaxLoopsError     |
| get           | `{ id: LoopID }`                                          | `Loop.Info│null` | Single loop by ID                                            | —                 |
| list          | `{ sessionID }`                                           | `Loop.Info[]`    | All loops for session (any status)                           | —                 |
| listDue       | `{ now: number }`                                         | `Loop.Info[]`    | Active loops where `next_run_at <= now`                      | —                 |
| tick          | `{ id: LoopID }`                                          | `Loop.Info`      | Mark iteration started, set `last_subagent_session_id`       | LoopNotFoundError |
| tickComplete  | `{ id: LoopID, tokens: number, sessionID: SessionID }`    | `Loop.Info`      | Increment `tokens_used`, `iteration_count`, compute next run | LoopNotFoundError |
| pause         | `{ id: LoopID }`                                          | `Loop.Info`      | Set status → `paused`, scheduler skips on tick               | LoopNotFoundError |
| resume        | `{ id: LoopID }`                                          | `Loop.Info`      | Set status → `active`, next_run_at = now + interval_ms       | LoopNotFoundError |
| cancel        | `{ id: LoopID }`                                          | `Loop.Info`      | Set status → `cancelled`                                     | LoopNotFoundError |
| expire        | `{ id: LoopID }`                                          | `Loop.Info`      | Set status → `expired`                                       | LoopNotFoundError |
| budgetExhaust | `{ id: LoopID }`                                          | `Loop.Info`      | Set status → `budget_exhausted`                              | LoopNotFoundError |

### LoopParser (`src/loop/parser.ts`)

| Method        | Input                 | Output                   | Behavior                                         | Errors          |
| ------------- | --------------------- | ------------------------ | ------------------------------------------------ | --------------- |
| parseInterval | `raw: string`         | `number` (ms)            | Parse `Ns/Nm/Nh/Nd`, enforce min 60s             | InvalidInterval |
| parseCommand  | `input: string`       | `{ intervalMs, prompt }` | Split first token as interval, rest as prompt    | InvalidInterval |
| resolvePrompt | `{ prompt?: string }` | `string│null`            | Return prompt or read loop.md (project → global) | —               |

### LoopScheduler (`src/loop/scheduler.ts`)

| Method | Input           | Output | Behavior                                                       | Errors |
| ------ | --------------- | ------ | -------------------------------------------------------------- | ------ |
| start  | `{ sessionID }` | `void` | Idempotent: ensure scheduler fiber is running for this session | —      |
| stop   | `{ sessionID }` | `void` | Cancel scheduler fiber, mark all active loops cancelled        | —      |

The scheduler is an Effect Service using `InstanceState` + `Effect.forkScoped`. One fiber per active session with loops.

### LoopEvent (`src/loop/events.ts`)

| Event                     | Payload                                                    |
| ------------------------- | ---------------------------------------------------------- |
| `loop.created`            | `{ sessionID, loopID, prompt, intervalMs }`                |
| `loop.iteration.started`  | `{ sessionID, loopID, iterationCount, subagentSessionID }` |
| `loop.iteration.complete` | `{ sessionID, loopID, iterationCount, tokensUsed }`        |
| `loop.paused`             | `{ sessionID, loopID }`                                    |
| `loop.resumed`            | `{ sessionID, loopID, nextRunAt }`                         |
| `loop.cancelled`          | `{ sessionID, loopID }`                                    |
| `loop.expired`            | `{ sessionID, loopID }`                                    |
| `loop.budget_exhausted`   | `{ sessionID, loopID, tokensUsed, tokenBudget }`           |

## Data Flow

### Create Loop

| Step | Component     | Action                                        | Next          |
| ---- | ------------- | --------------------------------------------- | ------------- |
| 1    | TUI /loop cmd | User types `/loop 5m check deploy`            | LoopParser    |
| 2    | LoopParser    | Parse "5m" → 300000ms, extract prompt         | Loop.create   |
| 3    | Loop.create   | Validate cap (≤20), insert row, set next_run  | LoopScheduler |
| 4    | LoopScheduler | Ensure fiber running for session (idempotent) | Bus           |
| 5    | Bus           | Publish `loop.created`, TUI shows toast       | Done          |

### Fire Iteration

| Step | Component         | Action                                           | Next               |
| ---- | ----------------- | ------------------------------------------------ | ------------------ |
| 1    | LoopScheduler     | Tick: find due loop where `next_run_at <= now`   | Overlap check      |
| 2    | LoopScheduler     | Check `last_subagent_session_id` still running?  | Budget check       |
| 3    | LoopScheduler     | Check `tokens_used < token_budget` (if set)      | Spawn              |
| 4    | spawnSubagent     | Create child session with loop prompt + model    | BackgroundExecutor |
| 5    | BackgroundExec    | SessionPrompt.prompt() with small model          | Completion         |
| 6    | Loop.tickComplete | Update tokens_used, iteration_count, next_run_at | Bus                |
| 7    | Bus               | Publish `loop.iteration.complete`                | TUI update         |

### Cancel Loop

| Step | Component   | Action                          | Next |
| ---- | ----------- | ------------------------------- | ---- |
| 1    | TUI Panel   | User selects loop → "Cancel"    | API  |
| 2    | LoopRoutes  | DELETE /:sessionID/loop/:loopID | Loop |
| 3    | Loop.cancel | Set status=cancelled            | Bus  |
| 4    | Bus         | Publish `loop.cancelled`, toast | Done |

### Budget Exhaustion

| Step | Component          | Action                                         | Next    |
| ---- | ------------------ | ---------------------------------------------- | ------- |
| 1    | Loop.tickComplete  | `tokens_used += iteration_tokens`              | Check   |
| 2    | Loop.tickComplete  | `tokens_used >= token_budget`?                 | Exhaust |
| 3    | Loop.budgetExhaust | Set status=budget_exhausted                    | Bus     |
| 4    | Bus                | Publish `loop.budget_exhausted`, toast+warning | Done    |

**Error Flows**:

- Subagent spawn failure → log error, skip iteration, schedule next normally (do not terminate loop)
- Subagent execution timeout → mark iteration error via BackgroundJob callback, skip to next
- DB write failure → log fatal, stop scheduler fiber for session (defensive)
- Budget exceeded mid-iteration → cannot stop mid-run; checked only between iterations

## Data Model

| Entity    | Fields                                                                                                                                                                                                                                                                                                                                            | Relationships          | Constraints                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------- |
| LoopTable | `id: text (LoopID PK)`, `session_id: text (SessionID FK)`, `prompt: text`, `interval_ms: integer`, `model: text?`, `status: text`, `iteration_count: integer`, `token_budget: integer?`, `tokens_used: integer`, `created_at: integer`, `next_run_at: integer`, `last_run_at: integer?`, `expires_at: integer`, `last_subagent_session_id: text?` | SessionTable (cascade) | status IN (active, paused, cancelled, expired, budget_exhausted), interval_ms >= 60000 |

### Schema Definition

```typescript
// src/loop/loop.sql.ts
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/session.sql"
import type { LoopID } from "./schema"
import type { SessionID } from "../session/schema"

export const LoopTable = sqliteTable(
  "loop",
  {
    id: text().$type<LoopID>().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    prompt: text().notNull(),
    interval_ms: integer().notNull(),
    model: text(),
    status: text().notNull().default("active"),
    iteration_count: integer().notNull().default(0),
    token_budget: integer(),
    tokens_used: integer().notNull().default(0),
    created_at: integer().notNull(),
    next_run_at: integer().notNull(),
    last_run_at: integer(),
    expires_at: integer().notNull(),
    last_subagent_session_id: text(),
  },
  (table) => [
    index("loop_session_idx").on(table.session_id),
    index("loop_status_next_idx").on(table.status, table.next_run_at),
  ],
)
```

### ID Schema

```typescript
// src/loop/schema.ts
import z from "zod"

export type LoopID = string & { readonly __tag: "LoopID" }
export const LoopID = {
  generate: (): LoopID => `loop_${crypto.randomUUID()}` as LoopID,
  make: (id: string): LoopID => id as LoopID,
  zod: z
    .string()
    .startsWith("loop_")
    .transform((s) => s as LoopID),
}
```

## Module Layout

```
packages/opencode/src/loop/
├── schema.ts           # LoopID branded type
├── loop.sql.ts         # Drizzle table definition
├── loop.ts             # Loop namespace (CRUD, tick, budget logic)
├── scheduler.ts        # LoopScheduler Effect service (fiber per session)
├── parser.ts           # Interval parsing, command parsing, loop.md resolution
└── events.ts           # BusEvent definitions for loop lifecycle

packages/opencode/src/cli/cmd/tui/command/
├── loop-command.tsx    # /loop and /loops slash commands

packages/opencode/src/cli/cmd/tui/
├── (app.tsx)           # Register loop commands + keybind (modify existing)

packages/opencode/src/server/routes/
├── (session.ts)        # Add loop CRUD routes (modify existing)

packages/opencode/src/config/
├── (config.ts)         # Add loop config section + experimental flag (modify existing)
```

## Scheduler Lifecycle

```
Session Start
     │
     ▼ (no loops exist yet — scheduler NOT started)
     │
User: /loop 5m ...
     │
     ▼
Loop.create() → LoopScheduler.start(sessionID)
     │
     ▼
┌─────────────────────────────────────────────┐
│  Effect.forkScoped(                          │
│    Effect.repeat(                            │
│      tickOnce(sessionID),                    │
│      Schedule.spaced(Duration.seconds(1))    │
│    )                                         │
│  )                                           │
│                                              │
│  tickOnce:                                   │
│    loops = Loop.listDue(Date.now())          │
│    for loop in loops:                        │
│      if isRunning(loop) → skip              │
│      if isExpired(loop) → expire + skip     │
│      if isBudgetExhausted(loop) → exhaust   │
│      else → spawnIteration(loop)            │
│                                              │
│  spawnIteration:                             │
│    session = Session.create(parent: loop.session_id)  │
│    BackgroundJob.start({                     │
│      run: SessionPrompt.prompt({             │
│        model: resolveLoopModel(loop),        │
│        parts: [{ type: "text", text: loop.prompt }]   │
│      })                                      │
│    })                                        │
│    Loop.tick({ id: loop.id })               │
│    jitter = random(0, min(interval*0.1, 300000))      │
│    next_run_at = now + interval + jitter    │
└─────────────────────────────────────────────┘
     │
     ▼ (Session end / all loops cancelled)
     │
Scope closes → fiber interrupted → cleanup
```

## Token Budget Enforcement

```
┌─────────────────────────────────────────────┐
│  Budget Check (between iterations only)      │
│                                              │
│  PRE-ITERATION:                             │
│    if loop.token_budget != null:            │
│      if loop.tokens_used >= token_budget:   │
│        Loop.budgetExhaust(loop.id)          │
│        return (don't spawn)                 │
│                                              │
│  POST-ITERATION (tickComplete callback):    │
│    tokens_from_subagent = Usage.get(subagentSessionID) │
│    Loop.tickComplete({                       │
│      id: loop.id,                           │
│      tokens: tokens_from_subagent.total.tokens.input  │
│             + tokens_from_subagent.total.tokens.output │
│    })                                        │
│    if loop.tokens_used >= token_budget:     │
│      Loop.budgetExhaust(loop.id)            │
│      (next tick will see non-active status) │
└─────────────────────────────────────────────┘
```

Token tracking aggregates `input + output + reasoning` from the subagent session's usage. The check happens at two points:

1. **Pre-spawn**: If already over budget, don't start a new iteration
2. **Post-completion**: After updating tokens_used, if now over budget, transition status

Note: Cannot stop a running iteration mid-way. Budget enforcement is between-iterations only.

## Background Subagent Spawning Contract

Each loop iteration reuses the existing `BackgroundExecutor` pattern:

```typescript
// Conceptual flow in scheduler.ts
async function spawnIteration(loop: Loop.Info, config: Config.Resolved) {
  const model = resolveLoopModel(loop, config) // loop.model ?? config.loop.model ?? small_model

  const { session } = await spawnSubagent(undefined, {
    parentSessionID: loop.session_id,
    agent: Agent.get("build"), // standard build agent
    description: `Loop iteration #${loop.iteration_count + 1}: ${loop.prompt.slice(0, 50)}`,
    canTask: false, // loops don't spawn sub-tasks
    canTodo: false,
    taskPermissionID: "task",
    maxDepth: 1,
    maxDescendants: 0,
  })

  Loop.tick({ id: loop.id, subagentSessionID: session.id })

  const executor = new BackgroundExecutor({
    parentSessionID: loop.session_id,
    description: `Loop: ${loop.prompt.slice(0, 40)}`,
  })

  await executor.execute({
    sessionID: session.id,
    model,
    parts: [{ type: "text", text: loop.prompt }],
    // ... standard ExecuteInput fields
  })
}
```

Model resolution order:

1. `loop.model` (per-loop override from creation)
2. `config.loop.model` (global loop config)
3. `Provider.getSmallModel()` (provider's small_model)
4. Parent session model (fallback with warning)

## TUI Keybind + Panel Design

### Keybind Conflict Resolution

`<leader>l` is currently bound to `session_list`. The loop panel uses a different binding.

**Decision**: Use `<leader>p` for loop panel. Mnemonic: "p for periodic/proactive".

Config key: `loop_panel` with default `<leader>p`.

### Loop Management Panel

Triggered by `<leader>p`, renders as a dialog overlay:

```
┌─── Loop Management ─────────────────────────────┐
│                                                   │
│  #1 [active] every 5m │ "check deploy status"    │
│     iter: 12 │ next: 2m 31s │ tokens: 45.2k     │
│                                                   │
│  #2 [paused] every 1h │ "summarize git log"      │
│     iter: 3  │ paused │ tokens: 12.8k            │
│                                                   │
│  ─────────────────────────────────────────────── │
│  [Enter] View  [p] Pause/Resume  [d] Cancel     │
│  [Esc] Close                                     │
└───────────────────────────────────────────────────┘
```

- **Enter** on selected loop → navigate to last subagent session (TuiEvent.SessionSelect)
- **p** on selected loop → toggle pause/resume (active↔paused)
- **d** on selected loop → cancel loop (confirm via toast)
- **Esc** → close panel

### Slash Commands

| Command | Syntax                      | Behavior                                                                                          |
| ------- | --------------------------- | ------------------------------------------------------------------------------------------------- |
| `/loop` | `/loop`                     | Opens combined loop panel: lists active loops (view/pause/cancel) + "Create new" option at bottom |
| `/loop` | `/loop [interval] [prompt]` | Shortcut: skips panel, creates loop directly with given interval and prompt                       |

Bare `/loop` and `<leader>p` open the **same combined panel**:

```
┌─── Loops ────────────────────────────────────────┐
│                                                   │
│  #1 [active] every 5m │ "check deploy status"    │
│     iter: 12 │ next: 2m 31s │ tokens: 45.2k     │
│                                                   │
│  #2 [paused] every 1h │ "summarize git log"      │
│     iter: 3  │ paused │ tokens: 12.8k            │
│                                                   │
│  ─────────────────────────────────────────────── │
│  + Create new loop                                │
│                                                   │
│  ─────────────────────────────────────────────── │
│  [Enter] View  [p] Pause/Resume  [d] Cancel     │
│  [n] New loop  [Esc] Close                       │
└───────────────────────────────────────────────────┘
```

- **Enter** on a loop → navigate to last subagent session
- **p** on a loop → toggle pause/resume
- **d** on a loop → cancel (confirm via toast)
- **n** or **Enter** on "+ Create new loop" → creation dialog (interval, prompt, budget)
- **Esc** → close panel

When no loops exist:

```
┌─── Loops ────────────────────────────────────────┐
│                                                   │
│  No active loops.                                 │
│                                                   │
│  + Create new loop                                │
│                                                   │
│  [n] New loop  [Esc] Close                       │
└───────────────────────────────────────────────────┘
```

### Footer Status

When loops are active, show in the **footer bar's right-side `<box>`** (alongside LSP/MCP counts), NOT in the prompt/spinner area. The spinner verb occupies the prompt input line above; the footer is a separate row below with `justifyContent="space-between"` (directory left, status indicators right).

```
Footer row:  [directory]                    [🔄 2 loops │ next: 2m 31s] [• 1 LSP] [⊙ 2 MCP] [/status]
Prompt row:  [spinner verb] ...   ← separate line, no conflict
```

## Server Routes

### Route Definitions (added to SessionRoutes)

| Method | Path                                  | Operation ID              | Request Body                                    | Response                    |
| ------ | ------------------------------------- | ------------------------- | ----------------------------------------------- | --------------------------- |
| POST   | `/:sessionID/loop`                    | `session.loop.create`     | `{ prompt, interval_ms, model?, token_budget?}` | `Loop.Info`                 |
| GET    | `/:sessionID/loops`                   | `session.loop.list`       | —                                               | `Loop.Info[]`               |
| DELETE | `/:sessionID/loop/:loopID`            | `session.loop.cancel`     | —                                               | `Loop.Info`                 |
| GET    | `/:sessionID/loop/:loopID/iterations` | `session.loop.iterations` | —                                               | `{ sessions: SessionID[] }` |

## Config Schema

```typescript
// Added to Config namespace in config.ts

// In experimental object:
loop: z.boolean().optional().describe("Enable the /loop recurring prompt scheduler"),

// Top-level loop config object:
loop: z.object({
  max_concurrent: z.number().int().positive().optional().default(20)
    .describe("Maximum concurrent loops per session"),
  max_expiry_days: z.number().positive().optional().default(7)
    .describe("Days until loop auto-expires"),
  min_interval_ms: z.number().int().positive().optional().default(60000)
    .describe("Minimum interval between iterations (ms)"),
  model: ModelId.optional()
    .describe("Default model for loop iterations (falls back to small_model)"),
  token_budget: z.number().int().positive().optional()
    .describe("Default token budget per loop (unlimited if not set)"),
}).optional()

// In Keybinds object:
loop_panel: z.string().optional().default("<leader>p")
  .describe("Open loop management panel"),
```

## Decisions

| Decision               | Choice                            | Reason                                                     | Alternatives                  | Tradeoffs                                                      |
| ---------------------- | --------------------------------- | ---------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------- |
| Scheduler tick rate    | 1 second                          | Sub-second unnecessary for min 60s intervals; low overhead | 5s, 10s                       | 1s = responsive + negligible CPU; faster than user perception  |
| Session-scoped only    | No persistence across restarts    | Simplifies v1; loops are ephemeral background work         | Persist + resume on restart   | Users must recreate loops after session end; acceptable for v1 |
| Fiber per session      | One scheduler fiber per session   | Isolates sessions, clean teardown via scope                | Global singleton ticker       | Slightly more fibers but cleaner lifecycle                     |
| Overlap skip           | Skip if previous still running    | Prevents resource exhaustion from stacking                 | Queue (FIFO), cancel previous | Missed iterations acceptable; simpler than queue management    |
| Jitter                 | 0-10% of interval, cap 5min       | Prevents thundering herd with multiple same-interval loops | No jitter, fixed offset       | Tiny delay acceptable; prevents correlated DB/LLM spikes       |
| Keybind                | `<leader>p`                       | `<leader>l` conflicts with session_list                    | `<leader>o`, `<leader>L`      | "p for periodic" — clear mnemonic, no conflicts                |
| subagent canTask=false | Loop iterations can't spawn tasks | Prevents recursive explosion                               | Allow with depth=1            | Limits loop power; safe default for v1                         |
| Budget = input+output  | Sum all tokens from subagent      | Most accurate cost tracking                                | Input only, output only       | Matches actual billing; simple to explain                      |

## Risks

| Risk                 | Impact                                         | Likelihood | Mitigation                                                           |
| -------------------- | ---------------------------------------------- | ---------- | -------------------------------------------------------------------- |
| Cost runaway         | Expensive model burns tokens overnight         | High       | small_model default, token_budget, `/loops` shows cumulative cost    |
| Forgotten loops      | Accumulate resource usage                      | Medium     | 7-day auto-expiry, max 20 cap, status in footer                      |
| Keybind conflict     | User confusion if `<leader>L` not discoverable | Low        | Document in help/tips, show in command palette                       |
| Stacking iterations  | Resource exhaustion if interval < exec time    | Medium     | Overlap skip: never run two iterations of same loop concurrently     |
| Session resume gap   | Loops not restored on resume (v1 limitation)   | Low        | Document as known limitation; acceptable for ephemeral scheduler     |
| Model unavailability | small_model not configured, no fallback        | Low        | Resolution chain: loop.model → config → small_model → parent model   |
| Scheduler fiber leak | Fiber not cleaned up on crash                  | Low        | Effect.forkScoped ties to session scope; GC on session disposal      |
| Token tracking race  | Concurrent tickComplete writes                 | Low        | SQLite serializes writes; use `tokens_used + $delta` not read-modify |

## Test Plan

### Unit Tests

**Loop CRUD** (`test/loop/loop.test.ts`):

- create: inserts row, returns Info, enforces max 20 cap
- create: bare /loop with loop.md resolves prompt correctly
- create: bare /loop without loop.md returns null prompt (shows help)
- list: returns only loops for given session
- listDue: returns loops where next_run_at <= now AND status=active
- tick: updates last_subagent_session_id, doesn't change iteration_count yet
- tickComplete: increments tokens_used, iteration_count, sets next_run_at with jitter
- tickComplete: triggers budget_exhausted when tokens_used >= budget
- cancel: sets status=cancelled
- expire: sets status=expired

**LoopParser** (`test/loop/parser.test.ts`):

- parseInterval: "60s" → 60000, "5m" → 300000, "1h" → 3600000, "1d" → 86400000
- parseInterval: "30s" → error (below minimum 60s)
- parseInterval: "abc" → error (invalid format)
- parseCommand: "5m check deploy" → { intervalMs: 300000, prompt: "check deploy" }
- parseCommand: "1h" → { intervalMs: 3600000, prompt: null } (prompt from loop.md)
- resolvePrompt: reads .opencode/loop.md if exists
- resolvePrompt: falls back to ~/.config/opencode/loop.md
- resolvePrompt: returns null if neither exists

**Jitter** (`test/loop/scheduler.test.ts`):

- jitter never exceeds 10% of interval
- jitter capped at 300000ms (5 min)
- jitter is non-negative

### Integration Tests

**Scheduler Lifecycle** (`test/loop/scheduler.test.ts`):

- Start scheduler → wait > interval → verify subagent session created
- Create loop → cancel → verify no more iterations fire
- Create loop with budget → exhaust budget → verify loop terminates
- Overlap skip: loop with long-running iteration → next tick skips
- Expiry: set expires_at in past → verify loop marked expired
- Multiple loops: different intervals fire independently

**Token Budget** (`test/loop/budget.test.ts`):

- Create loop with 10000 budget → iterations accumulate → terminates at threshold
- Budget-free loop runs indefinitely (no termination)
- Token counting matches actual subagent session usage

### End-to-End Tests

**Full Lifecycle**:

- `/loop 60s echo hello` → wait 65s → verify background session exists with output
- `/loops` → shows active loop with correct metadata
- Loop panel → select loop → navigate to output session
- Loop panel → cancel loop → verify no more iterations
- Budget exhaustion → toast notification + status change

### Non-Functional Tests

**Performance**:

- Scheduler tick with 20 active loops completes in < 50ms
- DB query for `listDue` uses index efficiently (no full scan)

**Reliability**:

- Subagent crash doesn't kill scheduler fiber
- DB write failure logged but scheduler continues for other loops

## Phase Mapping

| Plan Phase | HLD Components                                               |
| ---------- | ------------------------------------------------------------ |
| Phase 1    | LoopTable, Loop namespace, LoopScheduler, session lifecycle  |
| Phase 2    | LoopParser (interval, prompt, loop.md resolution)            |
| Phase 3    | BackgroundExecutor integration, model resolution, budget     |
| Phase 4    | LoopCommand, LoopPanel, keybind, footer, toast, Bus events   |
| Phase 5    | LoopRoutes (Hono), SDK types, Bus event wiring               |
| Phase 6    | Config schema (experimental.loop, loop.\* tunables, keybind) |
