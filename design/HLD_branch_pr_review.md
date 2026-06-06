# HLD: Branch PR Review

## Tech Stack

| Category  | Technology        | Purpose                                                  |
| --------- | ----------------- | -------------------------------------------------------- |
| Language  | TypeScript 5.8    | Existing codebase language                               |
| Runtime   | Bun 1.3.11        | Subprocess exec for git CLI, test runner                 |
| Framework | Effect 4.0-beta   | Background job orchestration, InstanceState for PR queue |
| Database  | SQLite / Drizzle  | Persist PR metadata across session turns                 |
| Git CLI   | Local git         | Detached worktree create, diff, cleanup                  |
| Bus       | BusEvent (custom) | Event-driven communication between orchestration and TUI |

## Upstream Rebase Safety

### Churn Analysis

| File                        | Recent Commits                   | FORK Markers | Rebase Risk                              |
| --------------------------- | -------------------------------- | ------------ | ---------------------------------------- |
| `tool/task.ts`              | 10+ (cherry-picks from upstream) | No           | HIGH — frequently modified               |
| `config/config.ts`          | 20+                              | No           | MEDIUM — experimental fields added often |
| `session/prompt.ts`         | 10+                              | YES (#FORK)  | CRITICAL — fork-specific code            |
| `session/detached-notes.ts` | 1                                | YES (#FORK)  | HIGH — may be dropped/rebased            |
| `orchestration/worktree.ts` | 1                                | No           | LOW — stable                             |
| `orchestration/events.ts`   | 3                                | No           | LOW — stable                             |

### Design Rules for Rebase Safety

1. **Extract, don't inline**: Branch-PR execution logic lives in `orchestration/branch-pr-handler.ts`, NOT inlined in task.ts. Task.ts gets a ~5 line integration point.

2. **Config at end**: New experimental fields appended AFTER all existing fields in the schema object. No interspersing.

3. **No FORK file modifications**: `prompt.ts` and `detached-notes.ts` are OFF LIMITS. Push-to-background integration happens via **Bus event subscription** in the branch-pr module — it subscribes to the existing child-completion event externally.

4. **Bus-driven hooks over inline hooks**: Instead of modifying `autoResume` in prompt.ts, the branch-pr module subscribes to `OrchestrationEvent.Complete` (or session lifecycle events). When a branch-pr session completes, the subscriber fires diff+PR-insert. This is purely additive — new subscriber, no modifications to existing event publishers.

5. **Feature-gated to zero impact**: When `experimental.branch_pr_review` is falsy, the branch-pr handler is never called. The enum extension in task.ts is the only always-present change.

### Integration Point in task.ts (Minimal Diff)

```typescript
// In task.ts execute function, BEFORE the existing worktree logic:
if (params.isolation === "branch-pr" && cfg.experimental?.branch_pr_review) {
  return branchPRHandler.execute(params, ctx, { session: nextSession, model: finalModel, agent: next, ... })
}
// existing worktree logic unchanged below
```

Total diff in task.ts: ~8 lines (import + early return call).

### Push-to-Background Without Touching FORK Code

**Problem**: When user pushes to background, `prompt.ts` cancels parent and the `autoResume` callback injects text. We need branch-pr completion to fire.

**Solution**: Branch-PR module registers a **Bus subscriber** at creation time:

```typescript
// In branch-pr-handler.ts, after creating the worktree:
Bus.subscribe(OrchestrationEvent.Complete, (event) => {
  if (event.sessionID === childSessionID) {
    // diff + PR-insert (no commit needed)
    BranchPR.finalize(worktreeInfo)
  }
})
```

This fires regardless of parent state because `OrchestrationEvent.Complete` is published by the session lifecycle (not by task.ts). No modifications to prompt.ts or detached-notes.ts needed.

**Fallback**: If the session errors/cancels instead of completing, subscribe to session state changes or use `BackgroundJob` completion callback (already external).

## Components

| Component          | Responsibility                                                          | Dependencies                                     |
| ------------------ | ----------------------------------------------------------------------- | ------------------------------------------------ |
| `branch-pr`        | Worktree lifecycle: create (detached), diff, apply (file-copy), cleanup | Git CLI, `Instance.directory`, `Log`             |
| `branch-pr.sql`    | PR metadata table schema                                                | Drizzle, `SessionTable`                          |
| `branch-pr-events` | Bus event definitions for PR state transitions                          | `BusEvent`, `z`                                  |
| `task.ts` (mod)    | Extended isolation enum, branch-pr execution paths                      | `branch-pr`, `branch-pr-events`, `BackgroundJob` |
| TUI (listeners)    | Toast/status for PR ready, apply success, conflict                      | `TuiEvent`, `branch-pr-events`                   |
| Config (mod)       | Feature flags and apply options                                         | `z` (config schema)                              |

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          PRIMARY AGENT SESSION                            │
│                                                                          │
│  task.ts ─── isolation: "branch-pr" ──┐                                  │
│                                       ▼                                  │
│  ┌─────────────────────────────────────────────────────────────────┐     │
│  │              BRANCH-PR MODULE (orchestration/branch-pr.ts)      │     │
│  │                                                                 │     │
│  │  create() ─── git worktree add --detach (no branch)             │     │
│  │  diff()   ─── git diff <base> -- . (uncommitted worktree state) │     │
│  │  apply()  ─── file copy from worktree → real directory          │     │
│  │  cleanup()─── git worktree remove                               │     │
│  └─────────────────────────────────────────────────────────────────┘     │
│           │                                    ▲                          │
│           ▼                                    │                          │
│  ┌────────────────────┐            ┌───────────────────────┐             │
│  │   SUBAGENT (coder) │            │  REVIEW FLOW          │             │
│  │   runs in worktree │            │  (inline in task.ts)  │             │
│  │   edits files      │            │                       │             │
│  │   returns summary  │            │  diff → tool output   │             │
│  └────────────────────┘            │  agent decides:       │             │
│                                    │    approve → apply()  │             │
│                                    │    reject  → cleanup  │             │
│                                    └───────────────────────┘             │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────┐        │
│  │  BUS EVENTS                                                  │        │
│  │  BranchPR.Created → BranchPR.Ready → BranchPR.Applied        │        │
│  │                                    → BranchPR.Rejected        │        │
│  │                                    → BranchPR.Conflict        │        │
│  └──────────────────────────────────────────────────────────────┘        │
│           │                                                              │
│           ▼                                                              │
│  ┌────────────────────┐     ┌──────────────────────────┐                 │
│  │  SQLite: branch_pr │     │  TUI: Toast + Status     │                 │
│  │  (state tracking)  │     │  (background completion) │                 │
│  └────────────────────┘     └──────────────────────────┘                 │
└──────────────────────────────────────────────────────────────────────────┘
```

**Description**: The branch-pr module provides detached worktree lifecycle operations. When `task.ts` receives `isolation: "branch-pr"`, it creates a detached worktree (via the module), runs the subagent inside that worktree, then on completion extracts a structured diff of the worktree's uncommitted state vs base. Instead of auto-applying (like `isolation: "worktree"`), it returns the diff as tool output for the primary agent to review. The primary agent then calls apply (approve) or cleanup (reject). No git commits are created at any point — approved changes appear as uncommitted modifications in the user's working directory. Background subagents emit `BranchPR.Ready` when done; the primary agent reviews on its next turn.

## Interfaces

### OrchestrationBranchPR (orchestration/branch-pr.ts)

| Method    | Input                                            | Output                  | Behavior                                                                   | Errors                           |
| --------- | ------------------------------------------------ | ----------------------- | -------------------------------------------------------------------------- | -------------------------------- |
| `create`  | `{ session: string, cwd: string, slug: string }` | `WorktreeInfo`          | Creates detached worktree in tmpdir                                        | `WorktreeError`                  |
| `diff`    | `{ worktree: WorktreeInfo }`                     | `DiffResult`            | Extracts structured diff: files changed vs base (uncommitted state)        | `WorktreeError`                  |
| `apply`   | `{ worktree: WorktreeInfo }`                     | `ApplyResult`           | Copies changed files from worktree to real working directory (uncommitted) | `ApplyConflict`, `WorktreeError` |
| `cleanup` | `{ worktree: WorktreeInfo }`                     | `void`                  | Removes worktree via `git worktree remove`                                 | (silent fail)                    |
| `sweep`   | `{ cwd: string, ttl: number }`                   | `{ removed: string[] }` | Removes orphan worktrees older than TTL                                    | (silent fail)                    |

### BranchPR State (orchestration/branch-pr-state.ts)

| Method    | Input                                           | Output          | Behavior                                | Errors |
| --------- | ----------------------------------------------- | --------------- | --------------------------------------- | ------ |
| `insert`  | `BranchPRRow`                                   | `void`          | Inserts PR metadata into SQLite         | —      |
| `update`  | `{ id: string, state: PRState, note?: string }` | `void`          | Updates PR state + optional review note | —      |
| `get`     | `{ id: string }`                                | `BranchPRRow?`  | Fetches PR by ID                        | —      |
| `pending` | `{ session: string }`                           | `BranchPRRow[]` | Lists PRs in `open` state for a session | —      |

### Task Tool Extensions (in task.ts)

| Method                 | Input                                | Output                 | Behavior                                                           | Errors         |
| ---------------------- | ------------------------------------ | ---------------------- | ------------------------------------------------------------------ | -------------- |
| (foreground branch-pr) | `params with isolation: "branch-pr"` | `TaskResult` with diff | Creates worktree, runs subagent, extracts diff, returns for review | Timeout, Error |
| (background branch-pr) | `params with background + branch-pr` | `backgroundOutput`     | Same as above but async; emits `BranchPR.Ready` on completion      | Timeout, Error |

### Review Output Format (returned to primary agent)

```typescript
type PRReviewOutput = {
  pr_id: string
  worktree: string
  base: string
  summary: string // subagent's final text output
  diff: {
    files_changed: number
    insertions: number
    deletions: number
    files: Array<{ path: string; status: "A" | "M" | "D"; patch: string }>
  }
  actions: {
    approve: string // instruction: "To apply, respond with approval"
    reject: string // instruction: "To reject, explain what needs fixing"
  }
}
```

## Data Flow

### Foreground Path

| Step | Component        | Action                                                       | Next           |
| ---- | ---------------- | ------------------------------------------------------------ | -------------- |
| 1    | task.ts          | Receives `isolation: "branch-pr"`, calls `BranchPR.create`   | branch-pr      |
| 2    | branch-pr        | Creates detached worktree in tmpdir                          | task.ts        |
| 3    | task.ts          | Runs subagent in worktree (via `Instance.restore`)           | subagent       |
| 4    | subagent         | Makes edits, completes work                                  | task.ts        |
| 5    | task.ts          | Calls `BranchPR.diff` (no commit needed)                     | branch-pr      |
| 6    | branch-pr        | Extracts structured diff of uncommitted worktree state       | task.ts        |
| 7    | task.ts          | Inserts PR row (state: `open`), publishes `BranchPR.Created` | bus            |
| 8    | task.ts          | Returns `PRReviewOutput` as tool output to primary agent     | primary agent  |
| 9    | primary agent    | Reviews diff, responds with approve/reject                   | task.ts (next) |
| 10a  | task.ts (apply)  | On approve: calls `BranchPR.apply`, updates state `applied`  | cleanup        |
| 10b  | task.ts (reject) | On reject: updates state `rejected`, cleanup worktree        | done           |
| 11   | branch-pr        | Cleanup: removes worktree                                    | done           |

### Background Path (launched as `background: true`)

| Step | Component     | Action                                                   | Next          |
| ---- | ------------- | -------------------------------------------------------- | ------------- |
| 1    | task.ts       | Creates worktree, spawns `BackgroundJob.start`           | background    |
| 2    | BackgroundJob | Runs subagent in worktree asynchronously                 | subagent      |
| 3    | subagent      | Completes work                                           | BackgroundJob |
| 4    | BackgroundJob | Calls diff, inserts PR row (state: `open`)               | bus           |
| 5    | bus           | Publishes `BranchPR.Ready` event                         | TUI + inject  |
| 6    | TUI           | Shows toast: "Branch PR ready for review: <description>" | —             |
| 7    | inject        | Injects pending PR context into primary agent next turn  | primary agent |
| 8    | primary agent | Reviews on next turn, approves/rejects                   | apply/cleanup |

### Push-to-Background Path (foreground detached mid-execution)

When user pushes a running foreground session to background (Ctrl+B), the parent's `task.ts` execute is interrupted but the child subagent keeps running (protected via `DetachedNotes.protect`). The branch-pr completion logic must still fire.

**Design**: Branch-PR module subscribes to `OrchestrationEvent.Complete` via Bus. When the child session completes (regardless of parent state), the subscriber fires diff+PR-insert. NO modifications to `prompt.ts` or `detached-notes.ts` (FORK code).

| Step | Component                 | Action                                                                   | Next              |
| ---- | ------------------------- | ------------------------------------------------------------------------ | ----------------- |
| 1    | branch-pr-handler         | Creates worktree + subscribes to `OrchestrationEvent.Complete` for child | subagent runs     |
| 2    | user                      | Pushes to background → parent cancelled, child protected                 | DetachedNotes     |
| 3    | child subagent            | Keeps running (protected), completes work in worktree                    | session lifecycle |
| 4    | session lifecycle         | Publishes `OrchestrationEvent.Complete` for child session                | Bus               |
| 5    | Bus → BranchPR subscriber | Fires: diff → insert PR row → publish `BranchPR.Ready`                   | TUI + autoResume  |
| 6    | TUI                       | Toast: "Branch PR ready for review"                                      | —                 |
| 7    | autoResume (existing)     | Injects child result into parent synthetic prompt (contains PR ref)      | primary agent     |
| 8    | primary agent             | Reviews diff (fetched via pr_id from PR table), approves/rejects         | apply/cleanup     |

**Key invariant**: The diff+PR-insert is triggered by a **Bus subscriber** — purely additive, no modifications to existing FORK code. The subscriber is registered at worktree creation and unregistered after firing (or on cleanup).

**Lifecycle guarantee**: If `OrchestrationEvent.Complete` never fires (crash/timeout), the startup sweep catches the orphan worktree via TTL-based cleanup.

### Apply Queue (multiple simultaneous PRs)

| Step | Component     | Action                                                                      | Next          |
| ---- | ------------- | --------------------------------------------------------------------------- | ------------- |
| 1    | primary agent | Has N pending PRs, reviews first one                                        | apply         |
| 2    | branch-pr     | Applies PR #1 successfully (files copied as uncommitted changes)            | step 3        |
| 3    | branch-pr     | Before applying PR #2: checks each target file still matches base           | step 4        |
| 4a   | branch-pr     | No conflicts → PR #2 ready for apply                                        | primary agent |
| 4b   | branch-pr     | File conflict detected → reports conflicting files, state set to `conflict` | primary agent |

**Error Flows**:

- **Subagent timeout**: Worktree preserved in `open` state. Primary agent notified of timeout. Can resume subagent in same worktree via `task_id`.
- **Apply conflict**: `ApplyConflict` error caught. Primary agent receives conflict details (which files diverged). Can: (a) ask subagent to fix in fresh worktree, (b) reject and re-dispatch.
- **Process crash**: Startup sweep finds orphan worktrees with no matching active session → cleaned after TTL.
- **Push-to-bg interruption**: Bus subscriber on `OrchestrationEvent.Complete` fires regardless of parent state. No modifications to FORK-marked files. If subscriber itself fails (crash), startup sweep catches orphan.

## Data Model

| Entity      | Fields                                                                                                                                                                                                             | Relationships          | Constraints                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | ------------------------------------------- |
| `branch_pr` | `id: text PK`, `session_id: text`, `parent_session_id: text`, `worktree: text`, `base: text`, `state: text`, `slug: text`, `diff_summary: text`, `review_note: text`, `created_at: integer`, `applied_at: integer` | `session_id → session` | state ∈ {open, applied, rejected, conflict} |

### Schema (branch-pr.sql.ts)

```typescript
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/session.sql"

export const BranchPRTable = sqliteTable(
  "branch_pr",
  {
    id: text().primaryKey(),
    session_id: text()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    parent_session_id: text().notNull(),
    worktree: text().notNull(),
    base: text().notNull(),
    slug: text().notNull(),
    state: text().notNull().default("open"),
    diff_summary: text(),
    review_note: text(),
    created_at: integer().notNull(),
    applied_at: integer(),
  },
  (table) => [
    index("branch_pr_session_idx").on(table.session_id),
    index("branch_pr_parent_idx").on(table.parent_session_id),
    index("branch_pr_state_idx").on(table.parent_session_id, table.state),
  ],
)
```

### TypeScript Types

```typescript
export type PRState = "open" | "applied" | "rejected" | "conflict"

export type WorktreeInfo = {
  path: string // worktree path (in os.tmpdir)
  base: string // base ref (HEAD at creation time)
  cwd: string // original working directory
}

export type DiffResult = {
  files_changed: number
  insertions: number
  deletions: number
  files: Array<{
    path: string
    status: "A" | "M" | "D"
    patch: string
  }>
  truncated: boolean // true if diff exceeded size limit
}

export type ApplyResult = {
  applied: boolean
  files: string[] // files successfully copied
}

export type ApplyConflict = {
  files: Array<{
    path: string
    reason: string // e.g. "target modified since base"
  }>
}
```

## Events (orchestration/branch-pr-events.ts)

```typescript
import z from "zod"
import { BusEvent } from "../bus/bus-event"

export namespace BranchPREvent {
  export const Created = BusEvent.define(
    "branch-pr.created",
    z.object({
      id: z.string(),
      sessionID: z.string(),
      parentSessionID: z.string(),
      worktree: z.string(),
      slug: z.string(),
    }),
  )

  export const Ready = BusEvent.define(
    "branch-pr.ready",
    z.object({
      id: z.string(),
      sessionID: z.string(),
      parentSessionID: z.string(),
      worktree: z.string(),
      filesChanged: z.number(),
      insertions: z.number(),
      deletions: z.number(),
    }),
  )

  export const Applied = BusEvent.define(
    "branch-pr.applied",
    z.object({
      id: z.string(),
      sessionID: z.string(),
      worktree: z.string(),
      files: z.array(z.string()),
    }),
  )

  export const Rejected = BusEvent.define(
    "branch-pr.rejected",
    z.object({
      id: z.string(),
      sessionID: z.string(),
      worktree: z.string(),
      reason: z.string().optional(),
    }),
  )

  export const Conflict = BusEvent.define(
    "branch-pr.conflict",
    z.object({
      id: z.string(),
      sessionID: z.string(),
      worktree: z.string(),
      files: z.array(z.string()),
    }),
  )
}
```

## Configuration Schema

New fields under `experimental`:

```typescript
branch_pr_review: z
  .boolean()
  .optional()
  .describe("Enable branch-pr isolation mode for subagents"),

branch_pr_auto_apply: z
  .boolean()
  .optional()
  .describe("Auto-apply without review for trusted subagents (skip review gate)"),

branch_pr_default_agents: z
  .array(z.string())
  .optional()
  .describe("Agent types that always use branch-pr isolation"),

branch_pr_max_diff_lines: z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Max diff lines shown to primary agent (default: 500). Larger diffs truncated with summary."),

branch_pr_ttl_hours: z
  .number()
  .positive()
  .optional()
  .describe("Hours before orphaned worktrees are cleaned up (default: 24)"),
```

## Task Tool Integration Detail

### Isolation Enum Extension (in task.ts — MINIMAL CHANGE)

```typescript
// In task.ts baseParameters — single line change:
isolation: z
  .enum(["worktree", "branch-pr"])
  .describe("Isolation mode. 'worktree': git worktree + cherry-pick. 'branch-pr': detached worktree + review gate.")
  .optional(),
```

### Early Return to Handler (in task.ts — ~5 lines added)

```typescript
// At top of execute(), before existing worktree logic:
import { branchPRHandler } from "../orchestration/branch-pr-handler"

// Inside execute, after session/model setup:
if (params.isolation === "branch-pr" && cfg.experimental?.branch_pr_review) {
  return branchPRHandler.execute(params, ctx, {
    session: nextSession,
    model: finalModel,
    agent: next,
    guard,
    concurrencyKey,
    concurrencyLimit,
    parentVariant,
    messageID,
    promptParts,
  })
}
// ALL branch-pr logic lives in branch-pr-handler.ts, not here
```

Total diff to task.ts: 1 import + 1 enum value + 5 lines early return = **~8 lines**.

### Foreground Logic (in branch-pr-handler.ts — NEW FILE)

```
1. worktree = BranchPR.create({ session, cwd, slug })
2. Subscribe to OrchestrationEvent.Complete for child session (Bus)
3. worktreeCtx = { ...Instance.current, directory: worktree.path }
4. result = Instance.restore(worktreeCtx, () => promptCall())
5. Unsubscribe (foreground handles completion directly)
6. diff = BranchPR.diff({ worktree })
7. insert PR row (state: "open")
8. publish BranchPR.Created
9. if cfg.experimental?.branch_pr_auto_apply:
     apply immediately, cleanup, return result
10. else:
     return PRReviewOutput (diff + actions) as tool output
```

### Background Logic (in branch-pr-handler.ts — NEW FILE)

```
if background && isolation === "branch-pr":
  Same as foreground steps 1-2, but wrapped in BackgroundJob.start
  Bus subscriber handles steps 5-8 on completion:
    - publish BranchPR.Ready
    - publish TuiEvent.BackgroundTaskUpdate
    - publish TuiEvent.ToastShow ("Branch PR ready for review")
  Primary agent gets pending PR context on next turn
```

### Review Response Handling (in branch-pr-handler.ts — NEW FILE)

The primary agent's response after receiving `PRReviewOutput` is handled by reusing `task_id`:

- **Approve**: Primary agent calls task tool with `task_id` of the PR session + explicit approval text. Task tool detects pending PR for that session, calls apply (file-copy to working dir), returns success.
- **Reject**: Primary agent calls task tool with `task_id` + feedback. Task tool cleans up the worktree. Optionally re-invokes subagent with review feedback in a fresh worktree.

Implementation approach: add a `pr_action` parameter to task tool params:

```typescript
pr_action: z
  .enum(["approve", "reject"])
  .describe("Action on a pending branch PR. Use with task_id of the PR session.")
  .optional(),
```

## Conflict Detection

### File-Level Conflict Detection

Before applying each file from the worktree to the real working directory, the apply logic checks:

1. Read the file at the same path in the real working directory
2. Compare against the base version (the version at worktree creation time)
3. If the real file has been modified since base (by another apply or user edit), report as conflict

```typescript
// Pseudo-logic in apply():
for (const file of changedFiles) {
  const target = path.join(cwd, file.path)
  const current = await Bun.file(target)
    .text()
    .catch(() => null)
  const base = await git("show", `${worktree.base}:${file.path}`).catch(() => null)

  if (current !== base) {
    // Target was modified since worktree was created — conflict
    conflicts.push({ path: file.path, reason: "target modified since base" })
    continue
  }
  // Safe to overwrite
  await copyFile(path.join(worktree.path, file.path), target)
}
```

### Conflict Resolution Strategy

When conflicts are detected:

1. Apply reports the conflicting files to the primary agent
2. Primary agent can: reject the PR entirely, or request subagent re-dispatch with awareness of current file state
3. No partial applies — either all files apply cleanly or none do (atomic per-PR)

## Decisions

| Decision                | Choice                                    | Reason                                                    | Alternatives                     | Tradeoffs                                             |
| ----------------------- | ----------------------------------------- | --------------------------------------------------------- | -------------------------------- | ----------------------------------------------------- |
| Worktree isolation      | Detached worktree (no branch)             | No branch pollution, no commits until user decides        | Real branches, in-place edits    | Can't `git log` subagent work, but diff captures it   |
| Apply mechanism         | File copy (not git merge/cherry-pick)     | Uncommitted result, user has full control over committing | Git merge, patch apply           | No git history of apply, but that's the point         |
| Conflict detection      | Per-file base comparison before overwrite | Simple, reliable, no git merge machinery needed           | Git merge-tree, 3-way merge      | Coarser than line-level, but safer and simpler        |
| Atomic apply            | All-or-nothing per PR                     | Prevents partial/inconsistent state                       | Per-file partial apply           | May reject PRs that have mostly-clean files           |
| Diff in tool output     | Return structured diff directly           | Primary agent can review inline without extra tool calls  | Separate `review_pr` tool        | Larger tool output, but fewer round-trips             |
| PR state in SQLite      | Dedicated table                           | Queryable, survives process restart, simple schema        | In-memory only, session metadata | Extra table, but needed for background/crash recovery |
| Review gate             | Return diff as tool output                | Uses existing tool output mechanism, no new tool needed   | New `review_branch_pr` tool      | Slightly overloads task tool output, but simpler      |
| Auto-apply escape hatch | Config flag `branch_pr_auto_apply`        | Some workflows need speed over review                     | Per-agent flag, never allow      | Skips review safety, but explicit opt-in              |
| Orphan cleanup          | TTL-based sweep at startup                | Simple, reliable, handles crash recovery                  | Reference counting, GC fiber     | Stale worktrees exist until next startup              |

## Risks

| Risk                       | Impact                                           | Likelihood | Mitigation                                                               |
| -------------------------- | ------------------------------------------------ | ---------- | ------------------------------------------------------------------------ |
| Large diffs exceed context | Primary agent can't review effectively           | Medium     | Truncate at `branch_pr_max_diff_lines`, show file summary for overflow   |
| Apply conflicts            | PR becomes unapplicable                          | Medium     | Per-file conflict detection; report to primary agent for re-dispatch     |
| Review rubber-stamping     | AI approves everything without real review       | High       | Configurable strictness in agent prompt; escalate large diffs to user    |
| Background race conditions | Multiple PRs apply simultaneously cause conflict | Low        | Sequential apply queue (primary agent reviews one at a time)             |
| Process crash mid-work     | Orphan worktrees left                            | Low        | Startup sweep, TTL cleanup, worktree in tmpdir (OS cleans eventually)    |
| Performance overhead       | Extra git ops add latency per subagent           | Low        | Git worktree/diff are fast locally (<100ms); creation is ~200ms          |
| Worktree disk usage        | tmpdir fills with many parallel subagents        | Low        | TTL-based cleanup in `finally` block; startup sweep for leaked worktrees |
| Worktree persistence       | Worktree must survive until approve/reject       | Low        | tmpdir location + no auto-cleanup until explicit decision or TTL expiry  |

## Edge Cases & Safety

- **Worktree persistence**: Worktrees must survive until user approves or rejects. No auto-cleanup except via TTL sweep (default 24h).
- **Orphan worktree cleanup**: Startup sweep finds worktrees with no matching active session → removed after TTL.
- **User edits during review**: If user manually edits files in working directory while a PR is pending, the conflict detection catches it at apply time.
- **Deleted files**: Apply handles file deletions — if worktree deleted a file, apply removes it from working directory (only if target matches base).
- **New files**: Apply handles file additions — copies new files. Conflict if file already exists in working directory but didn't exist at base.
- **Binary files**: Diff extraction skips binary content (shows path + "binary" marker). Apply still copies binary files.

## Test Plan

### Unit Tests

**Module: `orchestration/branch-pr.ts`**

- `create`: verify worktree exists after creation, path is in tmpdir, detached HEAD
- `create` with special characters in slug: sanitized correctly
- `diff`: correct file count, insertions/deletions, patch format (uncommitted state)
- `diff` with large changes: truncation at configured limit
- `diff` with no changes: returns empty result
- `apply` clean: all files copied to working directory, match expected content
- `apply` with new files: files created in target directory
- `apply` with deleted files: files removed from target directory
- `apply` conflict: detects modified target file, returns `ApplyConflict`
- `apply` atomic: on conflict, no files are copied (all-or-nothing)
- `cleanup`: worktree removed via `git worktree remove`
- `sweep`: removes worktrees older than TTL, preserves recent ones
- Mock: use `test/fixture` tmpdir helper, init git repos per test

**Module: `orchestration/branch-pr-state.ts`**

- `insert` + `get`: round-trip persistence
- `update`: state transitions (open → applied, open → rejected, open → conflict)
- `pending`: returns only open PRs for given session
- `pending`: empty when no open PRs

### Integration Tests

**Full foreground cycle:**

1. Create session, spawn task with `isolation: "branch-pr"`
2. Subagent makes file edits
3. Verify: PR row created, state = open, diff extracted correctly
4. Simulate approve: apply succeeds, changes in working dir (uncommitted)
5. Verify: PR state = applied, worktree cleaned up

**Full background cycle:**

1. Spawn background task with `isolation: "branch-pr"`
2. Verify: `BranchPR.Created` event fires
3. Wait for completion
4. Verify: `BranchPR.Ready` event fires, toast published
5. Simulate approve: apply succeeds

**Conflict handling:**

1. Spawn two parallel branch-pr subagents editing same file
2. Apply first PR
3. Attempt apply second PR → conflict detected
4. Verify: state = conflict, primary agent notified with conflicting file list

**Rejection + re-invoke:**

1. Spawn subagent, get PR back
2. Reject with feedback
3. Verify: worktree cleaned up
4. Re-dispatch subagent in fresh worktree with feedback

### End-to-End Tests

- Primary agent spawns coder subagent with `isolation: "branch-pr"`, receives diff, approves, changes visible as uncommitted modifications in working directory
- Two parallel coders with branch-pr, sequential apply without conflicts
- Background coder completes, toast fires, primary reviews on next turn

### Non-Functional Tests

- **Performance**: worktree create + diff extraction < 500ms for typical changes (< 50 files)
- **Cleanup**: no leaked worktrees after test suite completes
- **Crash recovery**: kill process mid-subagent, restart, verify sweep cleans orphans

## File Layout

```
packages/opencode/src/orchestration/
├── branch-pr.ts            # Detached worktree lifecycle (create/diff/apply/cleanup/sweep)
├── branch-pr-handler.ts    # Execution handler (extracted from task.ts for rebase safety)
├── branch-pr-state.ts      # SQLite CRUD for branch_pr table
├── branch-pr-events.ts     # BusEvent definitions (Created/Ready/Applied/Rejected/Conflict)
├── branch-pr.sql.ts        # Drizzle table schema
├── worktree.ts             # (existing, unchanged)
├── events.ts               # (existing, unchanged)
├── task-spawn.ts           # (existing, unchanged)
└── concurrency.ts          # (existing, unchanged)

packages/opencode/src/tool/
└── task.ts                 # MINIMAL CHANGE: "branch-pr" enum + early-return to handler (~8 lines)

packages/opencode/src/config/
└── config.ts               # MINIMAL CHANGE: append experimental fields at end (~15 lines)

packages/opencode/src/session/
├── prompt.ts               # ❌ NOT MODIFIED (FORK code)
└── detached-notes.ts       # ❌ NOT MODIFIED (FORK code)

packages/opencode/test/orchestration/
├── branch-pr.test.ts       # Unit tests for worktree + apply operations
├── branch-pr-handler.test.ts # Integration tests for full cycle
└── branch-pr-state.test.ts # Unit tests for state persistence
```

**Rebase safety summary:**

- 6 NEW files (zero conflict risk)
- 2 files with MINIMAL edits (task.ts: ~8 lines, config.ts: ~15 lines)
- 0 modifications to FORK-marked files

## Phase Mapping (from PLAN)

| PLAN Phase | HLD Components                                                       |
| ---------- | -------------------------------------------------------------------- |
| Phase 1    | `branch-pr.ts` (create, diff, apply, cleanup, sweep)                 |
| Phase 2    | `branch-pr.sql.ts`, `branch-pr-state.ts`, `branch-pr-events.ts`      |
| Phase 3    | `task.ts` modifications (isolation enum, execution paths, pr_action) |
| Phase 4    | Review output format in task.ts, approve/reject handling             |
| Phase 5    | `config.ts` flags, agent prompt updates                              |
