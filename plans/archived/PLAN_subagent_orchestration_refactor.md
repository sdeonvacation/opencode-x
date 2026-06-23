# Plan: Subagent Orchestration Refactor

## Overview

Centralise the four subagent execution paths (foreground, background, push-to-background, isolation) behind a unified `TaskExecutor` abstraction. Currently, `task.ts` is a 450+ line conditional maze where each new feature (ultrawork, isolation, background, push-to-bg) adds another branch. This refactor introduces a Strategy pattern for execution modes, a decorator pattern for cross-cutting concerns (isolation, concurrency, loop detection), and removes the experimental background feature flag.

## Tech Stack

- TypeScript 5.8 (Effect-ts 4.0.0-beta)
- Bun runtime
- Node.js AsyncLocalStorage (Instance.provide/bind)
- Effect layers (BackgroundJob service)

## Testing Strategy

- Unit: Each executor strategy in isolation (mock SessionPrompt.prompt)
- Integration: Full lifecycle per mode (foreground, background, push-to-bg, isolation×foreground, isolation×background)
- Done when: All existing tests pass unchanged, new unit tests cover each executor strategy, no regressions in TUI event contract

## Phases

### Phase 1: Extract Shared Utilities (DRY)

- Step 1: Extract `extractResultText()` helper — consolidate 3+ copies of `findLast(item => item.type === "text")` into `orchestration/result.ts`
- Step 2: Extract `formatError()` helper — unify `errorText()` from `task.ts` and `job.ts` into shared location
- Step 3: Extract `withTimeout()` wrapper — single implementation used by both foreground and background paths
- Step 4: Extract guard setup (loop detector + tool guard creation) into `orchestration/guard.ts` factory

### Phase 2: Define TaskExecutor Interface & Result Type

- Step 1: Define `TaskExecutor` interface with single `execute(input: ExecuteInput): Promise<ExecuteResult>` method
- Step 2: Define `ExecuteInput` type (sessionID, run function, concurrency config, abort signal, metadata)
- Step 3: Define `ExecuteResult` discriminated union (foreground output | background task_id | push-to-bg injected)
- Step 4: Define `ExecutionMode` enum: `foreground | background | push_to_background`

### Phase 3: Implement Executor Strategies

- Step 1: `ForegroundExecutor` — wraps acquire/prompt/release/complete-event into single class
- Step 2: `BackgroundExecutor` — wraps Effect fiber fork + BackgroundJob.start + immediate return
- Step 3: `PushToBackgroundExecutor` — wraps DetachedNotes + autoResume + synthetic prompt logic (extracted from prompt.ts)
- Step 4: Each executor handles its own event publishing internally

### Phase 4: Isolation as Decorator

- Step 1: Create `IsolationDecorator` that wraps any `TaskExecutor` — handles worktree create/destroy, Instance.provide, gitDiff, PatchLock, gitApply
- Step 2: Foreground+isolation = `IsolationDecorator(ForegroundExecutor)`
- Step 3: Background+isolation = `IsolationDecorator(BackgroundExecutor)`
- Step 4: Push-to-background never uses isolation (keep as-is, no decorator applied)

### Phase 5: Concurrency & Guard as Middleware

- Step 1: Create `ConcurrencyMiddleware` — wraps executor with acquire/release, supports AbortSignal for all modes (fix background missing signal)
- Step 2: Create `GuardMiddleware` — wraps executor with loop detection + tool guard
- Step 3: Compose: `GuardMiddleware(ConcurrencyMiddleware(IsolationDecorator?(Executor)))`
- Step 4: Composition done in a factory function `createExecutor(mode, options)` that builds the middleware chain

### Phase 6: Rewrite task.ts as Thin Orchestrator

- Step 1: Replace conditional branches with `createExecutor(mode, options).execute(input)`
- Step 2: Mode selection logic: `params.background ? "background" : "foreground"` (push-to-bg triggered separately from prompt.ts)
- Step 3: Remove feature flag checks (OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS)
- Step 4: Keep spawnSubagent() call + spawn limits at top (shared across all modes)
- Step 5: Keep result formatting at bottom (per-mode formatting via ExecuteResult discriminant)

### Phase 7: Refactor prompt.ts Push-to-Background

- Step 1: Extract push-to-background logic from `prompt.ts:148-376` into `PushToBackgroundExecutor`
- Step 2: prompt.ts calls `PushToBackgroundExecutor.execute()` instead of inline logic
- Step 3: DetachedNotes remains as state store but accessed through executor
- Step 4: autoResume callback moved into executor (keeps Instance.bind pattern)

### Phase 8: Remove Feature Flag & Cleanup

- Step 1: Remove `Flag.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` from flag.ts enum
- Step 2: Remove all flag checks in task.ts, task_status.ts, prompt.ts
- Step 3: Remove flag from config schema
- Step 4: Update any documentation/guide references

### Phase 9: Verify & Stabilise

- Step 1: Run full test suite, fix any failures
- Step 2: Typecheck passes
- Step 3: Manual smoke test: foreground task, background task, push-to-bg, isolation
- Step 4: Verify TUI events unchanged (BackgroundTaskUpdate, ToastShow, OrchestrationEvent.Complete)

## Risks/Edge cases

- **ALS context loss in decorators**: Instance.bind() must be called at correct scope boundaries in background/push-to-bg executors. Mitigation: each executor owns its own bind() call, tested explicitly.
- **Spawn reservation timing**: Background releases before return, foreground after complete. Mitigation: make release timing explicit per executor (part of executor contract, not implicit).
- **Push-to-background race**: Children may complete between detection and BackgroundJob.start. Mitigation: PushToBackgroundExecutor checks child state before forking (existing behavior preserved).
- **Patch conflict accumulation**: Isolation worktrees preserved on conflict. Mitigation: unchanged behavior, but add logging/warning if >3 preserved worktrees exist.
- **BackgroundJob extend() semantics**: Existing job can be extended with new task_id. Mitigation: preserve extend() path in BackgroundExecutor, test explicitly.
- **Regression in tool output format**: External contract must not change. Mitigation: snapshot tests on tool output strings for each mode.
