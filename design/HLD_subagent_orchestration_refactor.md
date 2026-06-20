# HLD: Subagent Orchestration Refactor

## Tech Stack

| Category  | Technology                | Purpose                                         |
| --------- | ------------------------- | ----------------------------------------------- |
| Language  | TypeScript 5.8            | Type-safe strategy/decorator pattern interfaces |
| Framework | Effect-ts 4.0.0-beta      | BackgroundJob service, fiber forking            |
| Runtime   | Bun                       | Process spawning (git), fast startup            |
| ALS       | Node.js AsyncLocalStorage | Instance.bind/provide for background contexts   |

## Components

| Component                | Responsibility                                       | Dependencies                                 |
| ------------------------ | ---------------------------------------------------- | -------------------------------------------- |
| TaskExecutor (iface)     | Single execute() contract for all modes              | ExecuteInput, ExecuteResult types            |
| ForegroundExecutor       | Synchronous prompt, await result, publish Complete   | SessionPrompt, concurrency, Bus              |
| BackgroundExecutor       | Fork Effect fiber, return task_id immediately        | BackgroundJob, Instance.bind, Bus            |
| PushToBackgroundExecutor | Detach running children, auto-resume on completion   | DetachedNotes, BackgroundJob, Instance.bind  |
| IsolationDecorator       | Wrap any executor with worktree create/destroy/patch | Worktree, PatchLock, patch, Instance.provide |
| ConcurrencyMiddleware    | Acquire/release semaphore around inner executor      | concurrency.ts (acquire/release)             |
| GuardMiddleware          | Loop detection before inner executor                 | tool-guard.ts (create)                       |
| createExecutor           | Factory: assembles middleware stack per mode         | All executors + middlewares                  |
| result.ts                | extractResultText, formatError shared utilities      | None                                         |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          task.ts (thin orchestrator)                      │
│  1. Permission check                                                     │
│  2. Agent resolve + spawnSubagent()                                      │
│  3. Model resolve + prompt parts                                         │
│  4. mode = params.background ? "background" : "foreground"               │
│  5. executor = createExecutor(mode, options)                             │
│  6. result = await executor.execute(input)                               │
│  7. Format output per result.tag                                         │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ createExecutor(mode, opts)
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Factory: createExecutor                           │
│                                                                          │
│  GuardMiddleware                                                         │
│    └─► ConcurrencyMiddleware                                            │
│          └─► IsolationDecorator? (if opts.isolation)                     │
│                └─► ForegroundExecutor | BackgroundExecutor               │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                   prompt.ts (push-to-background path)                     │
│                                                                          │
│  Detects running children → PushToBackgroundExecutor.execute()           │
│  (No factory — triggered by session layer, not tool layer)               │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                     Shared Utilities                                      │
│  orchestration/result.ts:  extractResultText, formatError, formatIsolation│
│  orchestration/guard.ts:   createGuardSetup (factory for guard+detector) │
└─────────────────────────────────────────────────────────────────────────┘
```

**Description**: task.ts becomes a thin orchestrator handling only permission, spawn, model resolution, and output formatting. Execution logic lives in strategy classes composed via middleware chain. The factory builds the chain based on mode + options. Push-to-background remains session-layer triggered (prompt.ts) but delegates to PushToBackgroundExecutor. All executors share the same ExecuteInput/ExecuteResult contract.

## Interfaces

### TaskExecutor Interface

```typescript
// orchestration/executor.ts

export type ExecutionMode = "foreground" | "background" | "push_to_background"

export type ExecuteInput = {
  sessionID: SessionID
  messageID: MessageID
  model: { modelID: ModelID; providerID: ProviderID }
  variant?: string
  agent: string
  tools: Record<string, boolean>
  parts: SessionPrompt.PromptInput["parts"]
  timeout: number
  concurrency: { key: string; limit: number }
  guard: { sessionID: string; threshold: number }
  abort?: AbortSignal
  metadata: {
    parentSessionID: SessionID
    description: string
    agentName: string
  }
}

export type ExecuteResult =
  | { tag: "foreground"; text: string; sessionID: SessionID }
  | { tag: "background"; sessionID: SessionID }
  | { tag: "background_update"; sessionID: SessionID }
  | { tag: "push_to_background"; count: number }

export interface TaskExecutor {
  execute(input: ExecuteInput): Promise<ExecuteResult>
}
```

### ForegroundExecutor

| Method  | Input        | Output                              | Behavior                                             | Errors                        |
| ------- | ------------ | ----------------------------------- | ---------------------------------------------------- | ----------------------------- |
| execute | ExecuteInput | ExecuteResult { tag: "foreground" } | Prompt session, await result, publish Complete event | Timeout, ConcurrencyCancelled |

### BackgroundExecutor

| Method  | Input        | Output                              | Behavior                                               | Errors        |
| ------- | ------------ | ----------------------------------- | ------------------------------------------------------ | ------------- |
| execute | ExecuteInput | ExecuteResult { tag: "background" } | Fork fiber via BackgroundJob.start, return immediately | Start failure |

**Note on extend() path**: When `task_id` references an already-running job, BackgroundExecutor calls `svc.get()` then conditionally `svc.extend()`. This is a TOCTOU race (job could complete between get and extend). This is existing behavior preserved intentionally — the race window is negligible (sub-ms) and extend() is idempotent if job already settled.

### PushToBackgroundExecutor

```typescript
// orchestration/executor/push-to-bg.ts

export type PushToBackgroundInput = {
  parentSessionID: SessionID
  children: Array<{ sessionID: SessionID; runner: Runner; state: RunnerState }>
  model: { modelID: ModelID; providerID: ProviderID }
  agent: string
  variant?: string
}
```

| Method  | Input                 | Output                                      | Behavior                                           | Errors              |
| ------- | --------------------- | ------------------------------------------- | -------------------------------------------------- | ------------------- |
| execute | PushToBackgroundInput | ExecuteResult { tag: "push_to_background" } | Protect children, register watchers, cancel parent | No running children |

**Note**: Pending-children polling (500ms intervals, 5min max) runs INSIDE the BackgroundJob fiber per child, NOT in the `execute()` method. `execute()` returns immediately after forking fibers + cancelling parent.

### IsolationDecorator

| Method  | Input        | Output        | Behavior                                                                        | Errors         |
| ------- | ------------ | ------------- | ------------------------------------------------------------------------------- | -------------- |
| execute | ExecuteInput | ExecuteResult | Create worktree, Instance.provide, delegate to inner, gitDiff, PatchLock, apply | Patch conflict |

### ConcurrencyMiddleware

| Method  | Input        | Output        | Behavior                                                  | Errors                    |
| ------- | ------------ | ------------- | --------------------------------------------------------- | ------------------------- |
| execute | ExecuteInput | ExecuteResult | acquire(key, limit, signal), delegate, release in finally | ConcurrencyCancelledError |

### GuardMiddleware

| Method  | Input        | Output        | Behavior                                | Errors            |
| ------- | ------------ | ------------- | --------------------------------------- | ----------------- |
| execute | ExecuteInput | ExecuteResult | guard.before() check, delegate to inner | LoopDetectedError |

## Data Flow

### Foreground Mode

| Step | Component             | Action                                         | Next                  |
| ---- | --------------------- | ---------------------------------------------- | --------------------- |
| 1    | task.ts               | Validate, spawn, resolve model                 | createExecutor        |
| 2    | createExecutor        | Build: Guard → Concurrency → Executor          | GuardMiddleware       |
| 3    | GuardMiddleware       | Loop detection check                           | ConcurrencyMiddleware |
| 4    | ConcurrencyMiddleware | acquire(key, limit, abort)                     | ForegroundExecutor    |
| 5    | ForegroundExecutor    | withTimeout(SessionPrompt.prompt(...))         | (await result)        |
| 6    | ForegroundExecutor    | extractResultText(result.parts)                | ConcurrencyMiddleware |
| 7    | ConcurrencyMiddleware | release(key) in finally                        | GuardMiddleware       |
| 8    | GuardMiddleware       | (passthrough)                                  | task.ts               |
| 9    | task.ts               | Publish Complete, format output, release spawn | (return)              |

### Foreground + Isolation Mode

| Step | Component             | Action                                            | Next                  |
| ---- | --------------------- | ------------------------------------------------- | --------------------- |
| 1    | task.ts               | Validate, spawn, resolve model                    | createExecutor        |
| 2    | createExecutor        | Build: Guard → Concurrency → Isolation → Executor | GuardMiddleware       |
| 3    | GuardMiddleware       | Loop detection check                              | ConcurrencyMiddleware |
| 4    | ConcurrencyMiddleware | acquire(key, limit, abort)                        | IsolationDecorator    |
| 5    | IsolationDecorator    | Worktree.create, Instance.provide                 | ForegroundExecutor    |
| 6    | ForegroundExecutor    | SessionPrompt.prompt (in worktree context)        | IsolationDecorator    |
| 7    | IsolationDecorator    | gitDiff, PatchLock.acquire, gitApply              | ConcurrencyMiddleware |
| 8    | ConcurrencyMiddleware | release(key) in finally                           | task.ts               |
| 9    | task.ts               | Publish Complete, formatIsolation, release spawn  | (return)              |

### Background Mode

| Step | Component          | Action                                                     | Next                 |
| ---- | ------------------ | ---------------------------------------------------------- | -------------------- |
| 1    | task.ts            | Validate, spawn, resolve model                             | createExecutor       |
| 2    | createExecutor     | Build: Guard → BackgroundExecutor (no concurrency wrapper) | GuardMiddleware      |
| 3    | GuardMiddleware    | Loop detection check                                       | BackgroundExecutor   |
| 4    | BackgroundExecutor | Build Effect with concurrency inside fiber                 | BackgroundJob.start  |
| 5    | BackgroundExecutor | Publish BackgroundTaskUpdate "running"                     | task.ts              |
| 6    | task.ts            | Release spawn, return background output                    | (return immediately) |
| 7    | (fiber)            | acquire → prompt → release → inject                        | (async completion)   |
| 8    | (fiber)            | Instance.bind callback publishes events                    | (done)               |

### Push-to-Background Mode

| Step | Component                | Action                                          | Next                     |
| ---- | ------------------------ | ----------------------------------------------- | ------------------------ |
| 1    | prompt.ts                | Detect running children                         | PushToBackgroundExecutor |
| 2    | PushToBackgroundExecutor | Protect all children (DetachedNotes)            | (register watchers)      |
| 3    | PushToBackgroundExecutor | Register BackgroundJob per child                | (per-child fiber)        |
| 4    | PushToBackgroundExecutor | Cancel parent run (DetachedNotes.markDetaching) | prompt.ts                |
| 5    | PushToBackgroundExecutor | Publish Toast + BackgroundTaskUpdate            | (return count)           |
| 6    | (fiber per child)        | Await Deferred, extract text                    | autoResume callback      |
| 7    | autoResume               | childCompleted → allDone? → synthetic prompt    | (done)                   |

**Error Flows**:

- **Timeout**: ForegroundExecutor catches timeout, calls SessionPrompt.cancel, throws. ConcurrencyMiddleware releases in finally.
- **Loop detected**: GuardMiddleware throws LoopDetectedError before any execution. No concurrency acquired.
- **Concurrency cancelled**: ConcurrencyMiddleware throws ConcurrencyCancelledError. No inner execution.
- **Patch conflict**: IsolationDecorator preserves worktree branch, returns conflict result (not thrown). task.ts formats as warning.
- **Background fiber failure**: BackgroundExecutor's inject callback publishes error toast + BackgroundTaskUpdate with state "error".
- **Spawn limit**: Thrown before createExecutor is called (in task.ts spawn phase). No executor involved.

## Data Model

| Entity                    | Fields                                                                                                  | Relationships             | Constraints                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------- |
| ExecuteInput              | sessionID, messageID, model, variant, agent, tools, parts, timeout, concurrency, guard, abort, metadata | References Session, Agent | sessionID must exist                      |
| ExecuteResult             | tag (discriminant), text?, sessionID, count?                                                            | References Session        | tag determines available fields           |
| IsolationResult           | output: string, patch: PatchResult                                                                      | None                      | patch.status ∈ {applied, empty, conflict} |
| DetachedNotes.ParentState | children, model, agent, variant, pending                                                                | References Session        | pending decrements to 0                   |

## File/Module Layout

```
packages/opencode/src/orchestration/
├── concurrency.ts          (unchanged)
├── events.ts               (unchanged)
├── executor.ts             (NEW — TaskExecutor interface + types)
├── executor/
│   ├── foreground.ts       (NEW — ForegroundExecutor class)
│   ├── background.ts       (NEW — BackgroundExecutor class)
│   └── push-to-bg.ts      (NEW — PushToBackgroundExecutor class)
├── middleware/
│   ├── concurrency.ts      (NEW — ConcurrencyMiddleware)
│   ├── guard.ts            (NEW — GuardMiddleware)
│   └── isolation.ts        (NEW — IsolationDecorator)
├── factory.ts              (NEW — createExecutor factory)
├── result.ts               (NEW — extractResultText, formatError, formatIsolation)
├── isolation.ts            (KEPT — isolatedRun stays as low-level util used by IsolationDecorator)
├── loop-detector.ts        (unchanged)
├── patch.ts                (unchanged)
├── patch-lock.ts           (unchanged)
├── spawn-limits.ts         (unchanged)
├── task-spawn.ts           (unchanged)
├── task-model-resolver.ts  (unchanged)
├── tool-guard.ts           (unchanged)
└── ...

packages/opencode/src/tool/
├── task.ts                 (REFACTORED — thin orchestrator, ~150 lines)
└── ...

packages/opencode/src/session/
├── prompt.ts               (REFACTORED — push-to-bg logic extracted, calls PushToBackgroundExecutor)
├── detached-notes.ts       (unchanged — state store)
└── ...
```

## Decisions

| Decision                                | Choice                                                                                | Reason                                                                  | Alternatives                                    | Tradeoffs                                                                                                                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Strategy pattern for modes              | Separate class per mode implementing TaskExecutor                                     | Open/Closed — new modes don't modify existing code                      | Switch/case in single function                  | More files, but each is small and testable in isolation                                                                                                                                                                          |
| Decorator for isolation                 | IsolationDecorator wraps any executor                                                 | Isolation is orthogonal to mode (foreground+iso, background+iso)        | Inline isolation in each executor               | Slight indirection; avoids 2x duplication                                                                                                                                                                                        |
| Concurrency inside fiber for background | BackgroundExecutor handles acquire/release inside the forked fiber, not as middleware | Background returns immediately — middleware can't wrap async fiber body | Middleware wrapping entire background lifecycle | Background mode skips ConcurrencyMiddleware in chain; concurrency is internal                                                                                                                                                    |
| Guard as outermost middleware           | GuardMiddleware runs before concurrency acquire                                       | Fail fast on loops without holding concurrency slots                    | Guard inside executor                           | Behavioral change for background: guard now runs synchronously BEFORE fiber fork (currently runs inside fiber). This is BETTER — fail fast before resource allocation. Foreground path unchanged (guard already before acquire). |
| Push-to-bg separate from factory        | PushToBackgroundExecutor called directly from prompt.ts, not via createExecutor       | Triggered by session layer (not tool layer), different input shape      | Unified factory for all 3                       | Keeps prompt.ts integration clean; push-to-bg has fundamentally different trigger                                                                                                                                                |
| Keep isolation.ts as util               | IsolationDecorator delegates to existing isolatedRun                                  | Minimize change surface, proven code                                    | Inline worktree logic in decorator              | Extra indirection layer                                                                                                                                                                                                          |
| AbortSignal for all modes               | ConcurrencyMiddleware always accepts signal (background passes undefined)             | Fixes current bug where background has no abort support                 | Keep background without signal                  | Uniform interface; background can add signal support later                                                                                                                                                                       |

## Risks

| Risk                                         | Impact                                                      | Likelihood            | Mitigation                                                                                                         |
| -------------------------------------------- | ----------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| ALS context loss in decorators               | Background tasks fail silently (can't publish events)       | Med                   | Each executor owns Instance.bind at construction; unit test verifies Bus.publish works in background callback      |
| Spawn reservation release timing regression  | Leak spawn slots or premature release                       | Med                   | Explicit release in task.ts finally block (unchanged location); executors never touch spawn reservation            |
| Middleware ordering breaks existing behavior | Guard runs before acquire (currently interleaved)           | Low                   | Current code: guard.before → acquire → prompt. New: same order. Guard is already before acquire in foreground path |
| Push-to-background race condition            | Children complete between detection and BackgroundJob.start | Low                   | Preserve existing behavior: check runner state before fork (already handled)                                       |
| BackgroundJob.extend() path breaks           | Existing background job can't be extended after refactor    | Low                   | BackgroundExecutor explicitly checks for existing job and calls extend() (same logic, extracted)                   |
| Patch conflict accumulation                  | Preserved worktrees fill disk                               | Low                   | Unchanged behavior; add log.warn if >3 preserved worktrees (monitoring only)                                       |
| External contract regression                 | Tool output format or TUI events change                     | High impact if occurs | Snapshot tests on output strings; event payloads unchanged (same Bus.publish calls)                                |

## Test Plan

### Unit Tests

**ForegroundExecutor** (`test/orchestration/executor/foreground.test.ts`):

- Happy path: prompt returns text, executor returns { tag: "foreground", text }
- Timeout: prompt exceeds timeout, executor throws with cancel called
- Empty result: prompt returns no text parts, executor returns empty string

**BackgroundExecutor** (`test/orchestration/executor/background.test.ts`):

- Happy path: returns { tag: "background" } immediately, fiber runs async
- Extend path: existing running job, returns { tag: "background_update" }
- Fiber failure: inject callback called with "error" state
- Fiber success: inject callback called with "completed" state

**PushToBackgroundExecutor** (`test/orchestration/executor/push-to-bg.test.ts`):

- Happy path: N running children detected, all protected, returns count
- No children: returns { tag: "push_to_background", count: 0 }
- Auto-resume: all children complete, synthetic prompt fired to parent
- Partial failure: one child errors, others complete, allDone still triggers

**IsolationDecorator** (`test/orchestration/middleware/isolation.test.ts`):

- Applied: inner executor succeeds, diff non-empty, gitApply succeeds
- Empty diff: no changes made, returns inner result unchanged
- Conflict: gitApply fails, returns conflict result with branch name
- Cleanup: worktree removed on success, preserved on conflict

**ConcurrencyMiddleware** (`test/orchestration/middleware/concurrency.test.ts`):

- Passes through when under limit
- Queues when at limit, resolves when released
- Aborted signal throws ConcurrencyCancelledError
- Release called in finally (even on inner throw)

**GuardMiddleware** (`test/orchestration/middleware/guard.test.ts`):

- Passes through on first call
- Throws LoopDetectedError after threshold identical calls
- Does not interfere with inner executor on pass

**result.ts** (`test/orchestration/result.test.ts`):

- extractResultText: finds last text part
- extractResultText: returns empty string when no text parts
- formatError: Error instance returns message
- formatError: non-Error returns String()
- formatIsolation: appends status messages per patch result

**createExecutor factory** (`test/orchestration/factory.test.ts`):

- foreground mode: returns Guard → Concurrency → ForegroundExecutor
- foreground + isolation: returns Guard → Concurrency → Isolation → ForegroundExecutor
- background mode: returns Guard → BackgroundExecutor (no concurrency middleware)
- background + isolation: returns Guard → Isolation → BackgroundExecutor

Mock strategy: Mock `SessionPrompt.prompt` (returns canned MessageV2.WithParts). Mock `BackgroundJob` service (track start/extend calls). Real concurrency module (fast, no I/O). Real guard/loop-detector (stateless per test).

### Integration Tests

**Full lifecycle per mode** (`test/orchestration/lifecycle.test.ts`):

- Foreground: spawn → execute → Complete event published → output formatted
- Background: spawn → execute → immediate return → fiber completes → BackgroundTaskUpdate published
- Foreground + isolation: spawn → worktree created → execute → patch applied → worktree removed
- Background + isolation: spawn → worktree created → fiber runs → patch applied async

**Event contract verification**:

- BackgroundTaskUpdate payload shape unchanged
- ToastShow payload shape unchanged
- OrchestrationEvent.Complete payload shape unchanged

### End-to-End Tests

- Existing `test/tool/task.test.ts` must pass unchanged (validates external contract)
- Manual smoke: foreground task, background task, push-to-bg (Ctrl+C during subagent), isolation task

### Non-Functional Tests

- **Performance**: No additional async hops introduced (middleware is sync wrapper around async call)
- **Memory**: No new long-lived state (middleware instances are per-call, not cached)
- **Concurrency**: Verify N parallel background tasks don't deadlock (existing test coverage)

## Migration Strategy

### Phase 1: Extract utilities (non-breaking)

- Create `orchestration/result.ts` with `extractResultText`, `formatError`, `formatIsolation`
- Import from task.ts (replace inline copies)
- All tests pass, no behavior change

### Phase 2: Define types (non-breaking)

- Create `orchestration/executor.ts` with interface + types
- No consumers yet, purely additive

### Phase 3: Implement executors (non-breaking)

- Create executor classes in `orchestration/executor/`
- Not wired to task.ts yet, tested independently

### Phase 4: Implement middleware (non-breaking)

- Create middleware in `orchestration/middleware/`
- Not wired yet, tested independently

### Phase 5: Create factory (non-breaking)

- Create `orchestration/factory.ts`
- Tested independently with mock executors

### Phase 6: Wire task.ts (breaking internally, external contract preserved)

- Replace conditional branches with `createExecutor().execute()`
- Single commit, all tests must pass
- Feature flag removal in same commit

### Phase 7: Extract push-to-bg from prompt.ts

- prompt.ts calls `PushToBackgroundExecutor.execute()`
- Inline logic removed, behavior identical

### Rollback Strategy

Each phase is a separate commit. If Phase 6 breaks, revert single commit. Phases 1-5 are purely additive and never need revert.

### Phase 8: Remove feature flag (non-breaking, mechanical)

- Remove `Flag.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` from flag.ts enum
- Remove all flag checks in task.ts, task_status.ts, prompt.ts
- Remove flag from config schema
- Update documentation references
- Can be combined with Phase 6 commit or separate

## Interface Contracts (Preserved)

### Tool Output Format (unchanged)

```typescript
// Foreground output — exact format preserved
;`task_id: ${sessionID} (for resuming to continue this task if needed)\n\n<task_result>\n${text}\n</task_result>`
// Background output — exact format preserved
`task_id: ${sessionID} (for polling this task with task_status)\nstate: running\n\n<task_result>\nBackground task launched...\n</task_result>`
// Background update output — exact format preserved
`task_id: ${sessionID} (for polling this task with task_status)\nstate: running\n\n<task_result>\nAdditional context sent to the background task.\n</task_result>`
```

### TUI Events (unchanged payloads)

```typescript
// BackgroundTaskUpdate — same shape
{ sessionID: SessionID, taskID: SessionID, title: string, state: "running" | "completed" | "error" }

// ToastShow — same shape
{ title: string, message: string, variant: "success" | "error" | "info", duration: number }

// OrchestrationEvent.Complete — same shape
{ sessionID: string, parentSessionID: string, agent: string, durationMs: number }
```

### Bus Events (unchanged)

All OrchestrationEvent.\* payloads remain identical. No new events added. No events removed.
