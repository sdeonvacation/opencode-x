# HLD: Claurst Feature Ports

## Tech Stack

| Category  | Technology           | Purpose                                     |
| --------- | -------------------- | ------------------------------------------- |
| Language  | TypeScript 5.8       | Existing codebase language                  |
| Runtime   | Bun 1.3.11           | Native SQLite, fast startup, test runner    |
| Framework | Effect-ts 4.0        | Typed services, error handling, concurrency |
| AI SDK    | Vercel AI SDK 6.x    | Provider-agnostic streaming, tool execution |
| Database  | SQLite + drizzle-orm | Goal system persistence (WAL mode)          |
| TUI       | @opentui/solid       | Goal status bar, /goal command              |

## Components

| Component            | Responsibility                                    | Dependencies                   |
| -------------------- | ------------------------------------------------- | ------------------------------ |
| ToolBudget           | Truncate old tool results to global char budget   | Config                         |
| ContextCollapse      | Emergency 97% context recovery                    | Config, Provider, Session, LLM |
| MicroCompact         | Gradual 75% compaction of oldest messages         | Config, Provider, Session, LLM |
| PromptSplitCache     | Reorder system prompt for cache optimization      | SystemPrompt, Config           |
| GoalSystem           | Autonomous goal lifecycle + auto-continuation     | Database, Config, Session, Bus |
| GoalComplete (tool)  | Model-callable tool to mark goal complete         | GoalSystem                     |
| WorktreeIsolation    | Git worktree per subagent for conflict-free edits | Config, ChildProcess, TaskTool |
| HookRegistry         | Plugin lifecycle hooks (Claude Code compatible)   | Config, ChildProcess           |
| PersistentMemory     | Cross-session file-based memory                   | FileSystem, Config             |
| MemoryPersist (tool) | Model-callable tool to write persistent memories  | PersistentMemory               |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          SESSION LOOP (prompt.ts)                            │
│                                                                             │
│  ┌─────────┐   ┌──────────────┐   ┌─────────────┐   ┌──────────────────┐  │
│  │ Messages │──▶│SlidingWindow │──▶│ToolBudget   │──▶│ MicroCompact     │  │
│  │ (DB)     │   │  .compact()  │   │ .apply()    │   │ .compact()       │  │
│  └─────────┘   └──────────────┘   └─────────────┘   └──────────────────┘  │
│                                                              │              │
│                                                              ▼              │
│  ┌──────────────────┐   ┌──────────────┐   ┌────────────────────────────┐  │
│  │ ContextCollapse   │◀──│ Token Check  │◀──│ proactive_prune (existing) │  │
│  │ (97% emergency)   │   │ (ratio calc) │   └────────────────────────────┘  │
│  └──────────────────┘   └──────────────┘                                   │
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                    SYSTEM PROMPT ASSEMBLY                             │   │
│  │  ┌─────────────────────────────────┬──────────────────────────────┐  │   │
│  │  │ STABLE PREFIX (cached)          │ DYNAMIC SUFFIX (volatile)    │  │   │
│  │  │ • Core identity prompt          │ • Environment (cwd, date)    │  │   │
│  │  │ • Capabilities/tool guidelines  │ • Session memory             │  │   │
│  │  │ • Skills                        │ • Active goal addendum       │  │   │
│  │  │ • Safety rules                  │ • Persistent memory          │  │   │
│  │  │ • Custom instructions           │ • Runtime state              │  │   │
│  │  └─────────────────────────────────┴──────────────────────────────┘  │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    streamText() dispatch                             │    │
│  │  messages → ProviderTransform.message() → applyCaching() [line 385] │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    TOOL EXECUTION                                    │    │
│  │  PreToolUse hook → execute → PostToolUse hook                       │    │
│  │  (HookRegistry)     (existing)  (HookRegistry, fire-and-forget)     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                    GOAL LOOP                                         │    │
│  │  After turn → check goal active → inject continuation → next turn   │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                     WORKTREE ISOLATION (orthogonal)                          │
│  task tool (isolation: "worktree") → git worktree add → spawn session       │
│  → on complete: merge back → cleanup worktree                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Description**: Features integrate as a pipeline of message transforms executed BEFORE `applyCaching()`. The pipeline order is: SlidingWindow → ToolBudget → MicroCompact → ContextCollapse (emergency). System prompt assembly uses a stable/dynamic split for cache optimization. Hooks wrap tool execution. Goals drive auto-continuation after each turn. Worktree isolation is orthogonal to the message pipeline.

## Interfaces

### ToolBudget (`src/session/tool-budget.ts`)

| Method            | Input                                           | Output                  | Behavior                                                          | Errors      |
| ----------------- | ----------------------------------------------- | ----------------------- | ----------------------------------------------------------------- | ----------- |
| `applyToolBudget` | `(msgs: MessageV2.WithParts[], budget: number)` | `MessageV2.WithParts[]` | Iterate oldest-first, sum tool result chars, truncate over-budget | None (pure) |

### ContextCollapse (`src/session/context-collapse.ts`)

| Method           | Input                                                | Output                          | Behavior                                             | Errors          |
| ---------------- | ---------------------------------------------------- | ------------------------------- | ---------------------------------------------------- | --------------- |
| `collapse`       | `(input: { sessionID, model, provider, msgs, cfg })` | `Effect<MessageV2.WithParts[]>` | LLM summarize all → replace with [summary, lastUser] | `CollapseError` |
| `shouldCollapse` | `(tokens: { input, context }, threshold?: number)`   | `boolean`                       | Returns true if input/context ≥ 0.97                 | None (pure)     |

### MicroCompact (`src/session/microcompact.ts`)

| Method          | Input                                                | Output                          | Behavior                                                  | Errors         |
| --------------- | ---------------------------------------------------- | ------------------------------- | --------------------------------------------------------- | -------------- |
| `compact`       | `(input: { sessionID, model, provider, msgs, cfg })` | `Effect<MessageV2.WithParts[]>` | Summarize oldest N (keep last 10) into 2048-token summary | `CompactError` |
| `shouldCompact` | `(tokens: { input, context }, threshold?: number)`   | `boolean`                       | Returns true if input/context ≥ 0.75                      | None (pure)    |

### PromptSplitCache (`src/session/prompt-split.ts`)

| Method        | Input                                      | Output            | Behavior                                                    | Errors |
| ------------- | ------------------------------------------ | ----------------- | ----------------------------------------------------------- | ------ |
| `splitPrompt` | `(parts: string[], model: Provider.Model)` | `SystemContent[]` | Partition into stable prefix + dynamic suffix content parts | None   |
| `BOUNDARY`    | (constant)                                 | `symbol`          | Marker separating stable from dynamic in content array      | N/A    |

### GoalSystem (`src/goal/goal.ts`)

| Method     | Input                                    | Output                 | Behavior                                      | Errors           |
| ---------- | ---------------------------------------- | ---------------------- | --------------------------------------------- | ---------------- |
| `create`   | `{ sessionID, objective, tokenBudget? }` | `Effect<Goal>`         | Insert goal row, status=active                | `GoalError`      |
| `get`      | `{ sessionID }`                          | `Effect<Goal \| null>` | Get active goal for session                   | None             |
| `complete` | `{ id, evidence }`                       | `Effect<Goal>`         | Set status=complete, completed_at=now         | `GoalError`      |
| `pause`    | `{ id, reason }`                         | `Effect<Goal>`         | Set status=paused or budget_limited           | `GoalError`      |
| `tick`     | `{ id, tokens, turns }`                  | `Effect<Goal>`         | Increment usage counters, check budget        | `BudgetExceeded` |
| `addendum` | `{ goal }`                               | `string`               | Format goal state for system prompt injection | None (pure)      |

### GoalLoop (`src/goal/goal-loop.ts`)

| Method           | Input            | Output    | Behavior                                            | Errors      |
| ---------------- | ---------------- | --------- | --------------------------------------------------- | ----------- |
| `shouldContinue` | `{ goal, step }` | `boolean` | Check: active + under budget + under MAX_TURNS(200) | None (pure) |
| `continuation`   | `{ goal }`       | `string`  | Generate continuation user message text             | None (pure) |

### WorktreeIsolation (`src/orchestration/worktree.ts`)

| Method    | Input                 | Output                 | Behavior                                          | Errors             |
| --------- | --------------------- | ---------------------- | ------------------------------------------------- | ------------------ |
| `create`  | `{ sessionID }`       | `Effect<WorktreePath>` | `git worktree add /tmp/opencode-worker-<id> HEAD` | `WorktreeError`    |
| `merge`   | `{ sessionID, path }` | `Effect<MergeResult>`  | Commit in worktree → cherry-pick to main          | `MergeConflict`    |
| `cleanup` | `{ sessionID, path }` | `Effect<void>`         | Remove worktree + temp branch                     | None (best-effort) |

### HookRegistry (`src/hook/hook.ts`)

| Method     | Input                                      | Output               | Behavior                                                     | Errors       |
| ---------- | ------------------------------------------ | -------------------- | ------------------------------------------------------------ | ------------ |
| `dispatch` | `(event: HookEvent, payload: HookPayload)` | `Effect<HookResult>` | Match hooks by event+glob, execute shell commands            | `HookDenied` |
| `load`     | `(cfg: Config.Info)`                       | `Effect<HookDef[]>`  | Load from .opencode/hooks.json → config → ~/.claude/settings | `LoadError`  |

### PersistentMemory (`src/memory/persistent.ts`)

| Method   | Input                     | Output             | Behavior                                                | Errors |
| -------- | ------------------------- | ------------------ | ------------------------------------------------------- | ------ |
| `list`   | `{ limit?: number }`      | `Effect<Memory[]>` | Scan memory dir, parse frontmatter, return newest-first | None   |
| `write`  | `{ name, type, content }` | `Effect<void>`     | Write markdown file with YAML frontmatter               | None   |
| `inject` | `()`                      | `Effect<string>`   | Format all memories as `<persistent-memory>` block      | None   |

## Data Flow

### Context Management Pipeline (per LLM turn)

| Step | Component        | Action                                                    | Next     |
| ---- | ---------------- | --------------------------------------------------------- | -------- |
| 1    | prompt.ts:1407   | `SlidingWindow.compact()` — existing compaction           | Step 2   |
| 2    | prompt.ts:1424   | `proactive_prune` check (existing, 80% threshold)         | Step 3   |
| 3    | prompt.ts (new)  | `applyToolBudget(msgs, budget)` if flag enabled           | Step 4   |
| 4    | prompt.ts (new)  | `microCompact()` if flag enabled AND ratio ≥ 0.75         | Step 5   |
| 5    | prompt.ts (new)  | `contextCollapse()` if flag enabled AND ratio ≥ 0.97      | Step 6   |
| 6    | prompt.ts:1436   | System prompt assembly (with prompt split if enabled)     | Step 7   |
| 7    | prompt.ts:1461   | `handle.process()` → `LLM.stream()` → `streamText()`      | Step 8   |
| 8    | transform.ts:385 | `applyCaching()` inside middleware (on final message set) | Provider |

### Tool Execution with Hooks

| Step | Component     | Action                                              | Next   |
| ---- | ------------- | --------------------------------------------------- | ------ |
| 1    | prompt.ts:295 | `plugin.trigger("tool.execute.before")`             | Step 2 |
| 2    | hook.ts (new) | `HookRegistry.dispatch("PreToolUse", {tool,input})` | Step 3 |
| 3    | prompt.ts:300 | `item.execute(args, ctx)` — actual tool execution   | Step 4 |
| 4    | hook.ts (new) | `Effect.fork(HookRegistry.dispatch("PostToolUse"))` | Step 5 |
| 5    | prompt.ts:310 | `plugin.trigger("tool.execute.after")`              | Return |

### Goal Auto-Continuation Loop

| Step | Component    | Action                                        | Next   |
| ---- | ------------ | --------------------------------------------- | ------ |
| 1    | prompt.ts    | Turn completes (finish-step event)            | Step 2 |
| 2    | goal-loop.ts | `shouldContinue({ goal, step })` check        | Step 3 |
| 3    | goal.ts      | `tick({ id, tokens, turns })` update counters | Step 4 |
| 4    | goal-loop.ts | `continuation({ goal })` → synthetic user msg | Step 5 |
| 5    | prompt.ts    | Inject continuation → next loop iteration     | Step 1 |

**Error Flows**:

- **ToolBudget**: Pure function, cannot fail. If budget=0 or no tool results, no-op.
- **MicroCompact**: LLM call failure → log warning, return original messages (skip compaction). Never block the main loop.
- **ContextCollapse**: LLM failure → log error, dump history to recovery file, continue with truncated tail (last 4 messages). This is emergency path — partial data > crash.
- **Goal tick budget exceeded**: Set goal status=`budget_limited`, emit Bus event, stop continuation. Session continues normally without auto-dispatch.
- **Worktree merge conflict**: Return `MergeConflict` error with branch name. Parent agent receives conflict report, can retry or abandon.
- **Hook PreToolUse denial**: Return tool error to model: `"Tool execution denied by hook: <stderr>"`. Model sees error and can adapt.
- **Hook timeout (10s)**: Kill process, log warning. For blocking hooks → deny. For non-blocking → ignore.

## Data Model

### GoalTable (`src/goal/goal.sql.ts`)

| Entity | Fields                                                                                                                                                                                                     | Relationships                            | Constraints                                                 |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------- |
| Goal   | `id: text PK, session_id: text FK, objective: text, status: text, token_budget: integer?, tokens_used: integer, turns_used: integer, time_used_secs: integer, created_at: integer, completed_at: integer?` | `session_id → SessionTable.id (cascade)` | `status IN ('active','paused','budget_limited','complete')` |

```sql
-- migration/XXXX_add_goals/migration.sql
CREATE TABLE goal (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  objective TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  token_budget INTEGER,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  turns_used INTEGER NOT NULL DEFAULT 0,
  time_used_secs INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX goal_session_idx ON goal(session_id);
CREATE INDEX goal_status_idx ON goal(session_id, status);
```

### Drizzle Schema (`src/goal/goal.sql.ts`)

```typescript
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/session.sql"
import { Timestamps } from "../storage/schema.sql"
import type { SessionID } from "../session/schema"
import type { GoalID } from "./schema"

export const GoalTable = sqliteTable(
  "goal",
  {
    id: text().$type<GoalID>().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    objective: text().notNull(),
    status: text().notNull().default("active"),
    token_budget: integer(),
    tokens_used: integer().notNull().default(0),
    turns_used: integer().notNull().default(0),
    time_used_secs: integer().notNull().default(0),
    created_at: integer().notNull(),
    completed_at: integer(),
  },
  (table) => [
    index("goal_session_idx").on(table.session_id),
    index("goal_status_idx").on(table.session_id, table.status),
  ],
)
```

### Persistent Memory File Format (`~/.local/share/opencode/memory/`)

```yaml
---
name: <slug> # filename without .md extension
type: user|project|feedback
created: 2026-05-20 # ISO date
project: <project-id> # optional, for project-scoped memories
---
<content as markdown>
```

- Filename: `<type>-<slug>.md` (e.g., `user-prefers-effect-ts.md`)
- Max 200 files, max 500 lines total injected
- Newest-first priority (by file mtime)

### Hook Config Format (`.opencode/hooks.json`)

```json
{
  "PreToolUse": [
    {
      "matcher": "Bash",
      "hooks": [{ "type": "command", "command": "my-validator $TOOL_INPUT", "timeout": 5000 }]
    }
  ],
  "PostToolUse": [
    {
      "matcher": "*",
      "hooks": [{ "type": "command", "command": "my-logger" }]
    }
  ]
}
```

## Config Schema Additions

```typescript
// In config.ts experimental object (after line 1321):
tool_result_budget: z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Global char budget for tool results in history (default: disabled, set to 50000 to enable)"),
context_collapse: z
  .boolean()
  .optional()
  .describe("Enable emergency context collapse at 97% utilization"),
microcompact: z
  .boolean()
  .optional()
  .describe("Enable gradual MicroCompact at 75% context utilization"),
prompt_split_caching: z
  .boolean()
  .optional()
  .describe("Split system prompt into cached/dynamic sections for improved provider caching"),
goal_system: z
  .boolean()
  .optional()
  .describe("Enable autonomous goal system with /goal command"),
worktree_isolation: z
  .boolean()
  .optional()
  .describe("Enable git worktree isolation for parallel subagents"),
hooks: z
  .boolean()
  .optional()
  .describe("Enable plugin hooks system (Claude Code compatible)"),
persistent_memory: z
  .boolean()
  .optional()
  .describe("Enable cross-session persistent memory"),
```

Additionally, at top-level config (outside experimental):

```typescript
hooks: z.object({
  PreToolUse: z.array(HookRuleSchema).optional(),
  PostToolUse: z.array(HookRuleSchema).optional(),
  PostToolUseFailure: z.array(HookRuleSchema).optional(),
  Notification: z.array(HookRuleSchema).optional(),
  Stop: z.array(HookRuleSchema).optional(),
  SubagentStart: z.array(HookRuleSchema).optional(),
  SubagentStop: z.array(HookRuleSchema).optional(),
}).optional()

// where:
const HookRuleSchema = z.object({
  matcher: z.string(), // glob pattern on tool name
  hooks: z.array(
    z.object({
      type: z.literal("command"),
      command: z.string(),
      timeout: z.number().optional(), // default 10000ms
    }),
  ),
})
```

## Feature Flag Evaluation Order

```
┌─ Before streamText dispatch (prompt.ts loop body) ─────────────────────┐
│                                                                         │
│  1. SlidingWindow.compact()           ← always runs (existing)          │
│  2. proactive_prune                   ← cfg.experimental?.proactive_prune│
│  3. tool_result_budget                ← cfg.experimental?.tool_result_budget│
│  4. microcompact                      ← cfg.experimental?.microcompact  │
│  5. context_collapse                  ← cfg.experimental?.context_collapse│
│                                                                         │
│  Mutual exclusion: if microcompact AND proactive_prune both enabled,    │
│  microcompact wins (lighter touch, skip proactive_prune)                │
│                                                                         │
├─ System prompt assembly ───────────────────────────────────────────────┤
│  6. prompt_split_caching              ← cfg.experimental?.prompt_split_caching│
│  7. persistent_memory                 ← cfg.experimental?.persistent_memory│
│  8. goal_system (addendum)            ← cfg.experimental?.goal_system   │
│                                                                         │
├─ Tool execution ──────────────────────────────────────────────────────┤
│  9. hooks                             ← cfg.experimental?.hooks         │
│                                                                         │
├─ Post-turn ───────────────────────────────────────────────────────────┤
│  10. goal_system (continuation)       ← cfg.experimental?.goal_system   │
│                                                                         │
├─ Task spawn ──────────────────────────────────────────────────────────┤
│  11. worktree_isolation               ← cfg.experimental?.worktree_isolation│
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Provider Caching Invariants

These rules are FORMAL and must be verified by anti-regression tests:

### Invariant 1: Breakpoint Count

```
For Anthropic/Bedrock/Alibaba:
  count(messages with cacheControl/cachePoint) ≤ 3
  count(tools with cacheControl/cachePoint) ≤ 1
  TOTAL ≤ 4
```

No feature may add a breakpoint marker. The 4-slot budget is:

- Slot 1: `system[0]` (system prompt — single message)
- Slot 2: first non-system message (compaction summary)
- Slot 3: last message (most recent turn)
- Slot 4: last tool definition

### Invariant 2: System Message Singularity

```
count(messages where role === "system") === 1
```

Phase 2 (prompt_split_caching) splits content WITHIN the single system message's content array. Never creates a second system message.

### Invariant 3: OpenAI Prefix Stability

```
For OpenAI/OpenAI-compatible:
  system_prompt[0..BOUNDARY] is byte-identical across consecutive turns
```

Volatile content (env, memory, goals) is placed AFTER the boundary. The stable prefix (identity, capabilities, skills, instructions) never changes mid-session.

### Invariant 4: Transform Ordering

```
All message mutations complete BEFORE applyCaching() runs.
applyCaching() is called inside streamText middleware (transform.ts:385).
Message pipeline (tool-budget, microcompact, collapse) runs in prompt.ts BEFORE streamText().
```

This ensures cache markers are computed on the FINAL message set.

### Invariant 5: First Non-System Message Stability

```
After compaction/collapse:
  messages[1] (first non-system) is either:
    - Original first user message, OR
    - Compaction summary (synthetic user message)
  It is NEVER reordered or replaced by context management features.
```

ToolBudget only modifies tool result CONTENT (not message ordering). MicroCompact replaces oldest messages but preserves the first non-system message (it's the compaction summary target). ContextCollapse replaces everything with [summary, lastUser] — cache is invalidated (acceptable in emergency).

### Invariant 6: Sub-Part Caching (Phase 2 Enhancement)

```
For Anthropic with prompt_split_caching enabled:
  system.content = [
    { type: "text", text: stablePrefix, providerOptions: { anthropic: { cacheControl: ... } } },
    { type: "text", text: dynamicSuffix }  // NO cacheControl here
  ]
```

The `cacheControl` on the first text part is a sub-message-level marker. It does NOT consume an additional top-level breakpoint — it refines WHERE within Slot 1 the cache boundary falls.

## Module File Layout

```
packages/opencode/src/
├── session/
│   ├── tool-budget.ts          # Phase 1A: applyToolBudget()
│   ├── context-collapse.ts     # Phase 1B: contextCollapse()
│   ├── microcompact.ts         # Phase 1C: microCompact()
│   └── prompt-split.ts         # Phase 2: splitPrompt(), BOUNDARY
├── goal/
│   ├── goal.sql.ts             # Phase 3: GoalTable schema
│   ├── goal.ts                 # Phase 3: CRUD service
│   ├── goal-loop.ts            # Phase 3: auto-continuation logic
│   └── schema.ts               # Phase 3: GoalID branded type
├── orchestration/
│   └── worktree.ts             # Phase 4: git worktree helpers
├── hook/
│   └── hook.ts                 # Phase 5: HookRegistry service
├── memory/
│   └── persistent.ts           # Phase 6: file-based cross-session memory
├── tool/
│   ├── goal-complete.ts        # Phase 3: GoalComplete tool
│   └── memory-persist.ts       # Phase 6: MemoryPersist tool
└── cli/cmd/tui/command/
    └── goal.ts                 # Phase 3: /goal slash command
```

## Integration Points (Exact Locations)

| Feature           | File                    | Location           | Change                                                                  |
| ----------------- | ----------------------- | ------------------ | ----------------------------------------------------------------------- |
| ToolBudget        | `session/prompt.ts`     | After line ~1418   | `if (cfg.experimental?.tool_result_budget) msgs = applyToolBudget(...)` |
| MicroCompact      | `session/prompt.ts`     | After ToolBudget   | `if (cfg.experimental?.microcompact && shouldCompact(...)) ...`         |
| ContextCollapse   | `session/prompt.ts`     | After MicroCompact | `if (cfg.experimental?.context_collapse && shouldCollapse(...)) ...`    |
| PromptSplitCache  | `session/prompt.ts`     | Line ~1452         | Pass system parts through `splitPrompt()` before assembling array       |
| PromptSplitCache  | `provider/transform.ts` | Line ~278-298      | For Anthropic: apply sub-part cacheControl on first content element     |
| GoalSystem        | `session/prompt.ts`     | Line ~1457         | Inject goal addendum into system array (dynamic section)                |
| GoalLoop          | `session/prompt.ts`     | After step loop    | Check goal → inject continuation → re-enter loop                        |
| WorktreeIsolation | `tool/task.ts`          | Spawn path         | If `isolation: "worktree"`, create worktree, set cwd                    |
| Hooks             | `session/prompt.ts`     | Lines ~295-310     | Add HookRegistry.dispatch before/after existing plugin.trigger          |
| PersistentMemory  | `session/prompt.ts`     | Line ~1457         | Inject `<persistent-memory>` block into system (dynamic section)        |
| Config flags      | `config/config.ts`      | After line 1321    | Add 8 new experimental fields                                           |
| Hook definitions  | `config/config.ts`      | Top-level schema   | Add `hooks` object with event→rule arrays                               |
| GoalTable         | `goal/goal.sql.ts`      | New file           | Drizzle schema + migration                                              |
| Tools             | `tool/registry.ts`      | Tool list          | Register GoalComplete + MemoryPersist tools                             |

## Decisions

| Decision                        | Choice                                     | Reason                                                       | Alternatives             | Tradeoffs                                                    |
| ------------------------------- | ------------------------------------------ | ------------------------------------------------------------ | ------------------------ | ------------------------------------------------------------ |
| Pipeline ordering               | SW → Budget → Micro → Collapse             | Cheapest ops first, emergency last                           | Collapse first           | Late collapse means wasted budget/micro work, but rare       |
| MicroCompact vs proactive_prune | Mutual exclusion, micro wins               | Both compact at similar thresholds; micro is lighter         | Allow both               | Simpler mental model, no double-compaction                   |
| Goal storage                    | SQLite (drizzle)                           | Existing DB infra, cascade delete with session               | File-based               | DB gives transactions, indexes, consistent with session data |
| Persistent memory storage       | Markdown files with YAML frontmatter       | User-editable, git-friendly, no DB migration                 | SQLite table             | No transactions, but user editability is key value prop      |
| Hook format                     | Claude Code compatible JSON                | Zero-friction migration, ecosystem reuse                     | Custom YAML format       | Locked to Claude Code's schema evolution                     |
| Hook source priority            | .opencode → config → ~/.claude (fallback)  | Project-specific > user-global > auto-import                 | Only opencode config     | More complexity, but seamless migration path                 |
| Worktree path                   | `/tmp/opencode-worker-<id>`                | OS temp dir, auto-cleaned on reboot                          | In-repo `.worktrees/`    | Temp dir avoids polluting project; cleanup on crash          |
| Prompt split approach           | Content array reordering within 1 message  | Preserves Slot 1 breakpoint, no additional markers           | Two system messages      | Would consume Slot 2 — REJECTED                              |
| Context collapse model          | task_categories.compaction model           | Cheap/fast model for emergency; respects user routing config | Always use session model | Emergency = speed over quality; user can override            |
| Sub-part cacheControl           | On first text part of system content array | Anthropic API supports it; refines cache without new slot    | Message-level only       | Finer granularity = better cache hits                        |

## Risks

| Risk                              | Impact                                          | Likelihood | Mitigation                                                                                           |
| --------------------------------- | ----------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| Anthropic 4-breakpoint overflow   | Cache miss, potential API error                 | Low        | Anti-regression test counts markers after each feature. Phase 2 reuses Slot 1                        |
| OpenAI prefix cache miss          | Higher latency, increased cost                  | Medium     | Stable prefix ordering guaranteed. Volatile content at end only. Test prefix identity across turns   |
| MicroCompact + SlidingWindow race | Double-compaction, context loss                 | Low        | MicroCompact runs AFTER SlidingWindow. If SW already compacted, micro threshold won't trigger        |
| Context collapse data loss        | User loses conversation history                 | Medium     | Full pre-collapse history logged to recovery file. Only triggers at 97% (emergency)                  |
| Goal runaway (infinite loop)      | Token/cost explosion                            | Medium     | Hard limit: MAX_TURNS=200, optional token_budget, pause state. Bus event notifies user               |
| Worktree merge conflict           | Subagent work partially lost                    | Medium     | Don't force-apply. Leave branch intact, report to parent. User can resolve manually                  |
| Hook injection via model output   | Arbitrary command execution                     | Low        | Hooks only from user config files. Model cannot write hooks. Env vars are read-only to hooks         |
| Hook timeout blocking main loop   | Tool execution delayed                          | Medium     | Default 10s timeout. PreToolUse blocking timeout configurable. PostToolUse is fire-and-forget        |
| Persistent memory file explosion  | Slow prompt build, context overflow             | Low        | Hard limits: 200 files max, 500 lines total. Newest-first priority with cutoff                       |
| Feature interaction complexity    | Unexpected behavior when multiple flags enabled | Low        | Each feature independently testable. Pipeline order is deterministic. Integration tests cover combos |
| Upstream rebase conflicts         | Merge conflicts on update                       | Low        | All features are new files. Integration = single-line insertions in prompt.ts. Feature-gated         |

## Test Plan

### Unit Tests

#### `test/session/tool-budget.test.ts`

- **Happy path**: Messages with tool results exceeding budget → oldest truncated
- **Under budget**: No modification when total chars < budget
- **No tool results**: Messages without tool results pass through unchanged
- **Edge case**: Single tool result exactly at budget → no truncation
- **Edge case**: All tool results truncated when budget is very small
- **Preserves structure**: Message metadata, role, non-tool-result parts unchanged

#### `test/session/context-collapse.test.ts`

- **Trigger condition**: `shouldCollapse` returns true at ≥0.97 ratio
- **Below threshold**: `shouldCollapse` returns false at 0.96
- **Output format**: Collapsed result is exactly [summary-msg, last-user-msg]
- **Recovery log**: Pre-collapse history written to log file
- **LLM failure**: Falls back to tail truncation (last 4 messages)

#### `test/session/microcompact.test.ts`

- **Trigger condition**: `shouldCompact` returns true at ≥0.75 ratio
- **Keep recent**: Last 10 messages never summarized
- **Summary format**: Output is `<context-summary>...</context-summary>` user message
- **Mutual exclusion**: When both microcompact and proactive_prune enabled, only microcompact runs
- **LLM failure**: Returns original messages unchanged

#### `test/session/prompt-split.test.ts`

- **Split correctness**: Stable parts before boundary, dynamic after
- **Single message**: Output is one system message with content array
- **Disabled**: When flag off, system prompt identical to current behavior
- **Provider-specific**: Anthropic gets sub-part cacheControl on first content part
- **OpenAI stability**: Stable prefix byte-identical across consecutive calls with different dynamic content

#### `test/goal/goal.test.ts`

- **CRUD lifecycle**: create → get → tick → complete
- **Budget limiting**: tick beyond token_budget → status=budget_limited
- **Turn limit**: turns_used ≥ 200 → shouldContinue returns false
- **Cascade delete**: Deleting session removes associated goals
- **Concurrent goals**: Only one active goal per session

#### `test/goal/goal-loop.test.ts`

- **Continuation**: Active goal + under budget → generates continuation message
- **Stop conditions**: complete/paused/budget_limited → no continuation
- **MAX_TURNS guard**: At turn 200, shouldContinue returns false regardless of budget

#### `test/orchestration/worktree.test.ts`

- **Create**: Produces valid worktree at expected path
- **Merge clean**: Changes merge back without conflict
- **Merge conflict**: Returns MergeConflict error, branch preserved
- **Cleanup**: Worktree and temp branch removed after cleanup
- **Finalizer**: Cleanup runs on abort/failure (Effect.addFinalizer)

#### `test/hook/hook.test.ts`

- **Load priority**: .opencode/hooks.json > config > ~/.claude/settings.json
- **Matcher glob**: `"Bash"` matches Bash, `"*"` matches all, `"File*"` matches FileRead
- **PreToolUse deny**: Non-zero exit → HookDenied error with stderr
- **PostToolUse fire-and-forget**: Non-zero exit logged, not propagated
- **Timeout**: Process killed after timeout, appropriate error
- **Env vars**: CLAUDE_TOOL_NAME, CLAUDE_TOOL_INPUT, CLAUDE_TOOL_RESULT set correctly
- **Stdin**: Event JSON passed on stdin

#### `test/memory/persistent.test.ts`

- **Write + read**: Write memory file, list returns it
- **Frontmatter parsing**: name, type, created parsed correctly
- **Limit enforcement**: >200 files → only newest 200 returned
- **Line limit**: >500 total lines → truncated at 500
- **Inject format**: Output wrapped in `<persistent-memory>` tags
- **Type filtering**: Can filter by user/project/feedback type

### Integration Tests

#### `test/session/context-pipeline.test.ts`

- **Full pipeline**: SlidingWindow → ToolBudget → MicroCompact → Collapse in sequence
- **Feature interaction**: Enable all three context features, verify no double-processing
- **Cache markers preserved**: After pipeline, applyCaching produces correct breakpoint count
- **Message ordering**: First non-system message stable after pipeline

#### `test/goal/goal-integration.test.ts`

- **Goal + session loop**: Create goal → auto-continue for N turns → complete
- **Goal + context management**: Goal running + microcompact triggers → goal addendum in dynamic section
- **Goal + budget**: Token budget exceeded mid-goal → pauses cleanly

#### `test/hook/hook-integration.test.ts`

- **Hook + tool execution**: PreToolUse hook denies → tool returns error to model
- **Hook + task spawn**: SubagentStart hook fires when task tool invoked
- **Claude Code import**: Existing ~/.claude/settings.json hooks loaded and functional

### End-to-End Tests

#### Critical User Journeys

1. **Context safety**: Long session with many tool calls → tool_result_budget keeps context manageable → microcompact triggers at 75% → session continues without hitting context limit
2. **Goal workflow**: User types `/goal "refactor auth module"` → goal created → agent works autonomously → calls GoalComplete when done → session stops auto-continuing
3. **Hook deny**: User configures PreToolUse hook that denies `rm -rf` commands → model attempts dangerous bash → hook blocks → model adapts
4. **Worktree parallel**: Two subagents spawn with worktree isolation → both edit files → both merge back without conflict
5. **Persistent memory**: User preference stored in session A → new session B loads it from system prompt → model respects preference

### Non-Functional Tests

#### Performance

- **ToolBudget**: < 1ms for 1000 messages (pure string length computation)
- **MicroCompact**: LLM call ≤ 5s (uses cheap model, 2048 token output cap)
- **ContextCollapse**: LLM call ≤ 10s (emergency, uses cheap model)
- **Hook dispatch**: < 100ms overhead for non-blocking hooks (fork + spawn)
- **Persistent memory scan**: < 50ms for 200 files (filesystem stat + parse)

#### Security

- Hooks execute only user-configured commands (model cannot inject hooks)
- Hook env vars are read-only (tool input/result, not arbitrary env)
- Worktree paths use session ID (not user input) to prevent path traversal
- Persistent memory files validated: no symlink following, restricted to memory dir

#### Cache Anti-Regression (`test/provider/cache-invariant.test.ts`)

```typescript
// For each provider type × each feature combination:
// 1. Build messages with feature ON
// 2. Run through ProviderTransform.message()
// 3. Count providerOptions with cache markers
// 4. Assert:
//    - Anthropic/Bedrock/Alibaba: msg markers ≤ 3, tool markers ≤ 1, total ≤ 4
//    - OpenAI: 0 explicit markers (auto-caching)
//    - system[0] is always first cache target
// 5. For prompt_split_caching:
//    - Assert system content[0] has cacheControl (sub-part)
//    - Assert system content[1] does NOT have cacheControl
//    - Assert total top-level breakpoints unchanged
```

#### Scalability

- Goal system: 200-turn hard limit prevents unbounded sessions
- Persistent memory: 200-file / 500-line cap prevents prompt explosion
- Worktree: Cleaned up on completion/failure via Effect.addFinalizer
- Hook timeout: 10s default prevents hanging tool execution
