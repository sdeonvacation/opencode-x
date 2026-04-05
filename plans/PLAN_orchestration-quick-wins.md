# Plan: Orchestration Quick Wins

## Overview

Adopt 6 high-value, low-risk orchestration features from oh-my-openagent into opencode core. Every feature is additive (new files), config-gated (`experimental.*`), and designed to survive upstream rebases with zero merge conflicts on hot files like `prompt.ts`.

## Tech Stack

- TypeScript 5.8.2, Bun 1.3.11
- Effect 4.0 (service/layer patterns, Effect.fn)
- Zod for config schema extensions
- Existing Bus (typed pub/sub) for events
- Existing Plugin hook system for message transform
- bun:test for unit tests

## Testing Strategy

- **Unit**: Each new module gets a dedicated test file (`test/orchestration/*.test.ts` or `test/tool/<feature>.test.ts`)
- **Integration**: Task tool + loop detector end-to-end; spawn limits with nested task calls
- **Done when**: All new tests pass, `bun typecheck` clean, zero edits to files commonly changed upstream

## Phases

### Phase 1: Loop Detector + Orchestration Events (foundation)

- Step 1: Create `src/orchestration/loop-detector.ts` — standalone signature tracker with `record()`, `detect()`, `reset()`
- Step 2: Create `src/orchestration/events.ts` — Bus event definitions for orchestration lifecycle (spawn, complete, abort, loop-detected, concurrency-queued, concurrency-released)
- Step 3: Add `experimental.loop_detector_threshold` to config schema (`src/config/config.ts` — single field addition to existing `experimental` object)
- Step 4: Create thin adapter in `src/orchestration/tool-guard.ts` — wraps tool execution to call loop detector before/after; consumed by plugin hook or processor callsite
- Step 5: Add tests: `test/orchestration/loop-detector.test.ts`

### Phase 2: Subagent Spawn Guardrails

- Step 1: Create `src/orchestration/spawn-limits.ts` — tracks depth and descendant count per root session, exposes `assertCanSpawn()`, `registerSpawn()`, `releaseSpawn()`
- Step 2: Add `experimental.max_subagent_depth` (default 3) and `experimental.max_subagent_descendants` (default 50) to config schema
- Step 3: Wire into `src/tool/task.ts` — add ~5-line guard call before `Session.create()` (smallest possible diff on existing file)
- Step 4: Publish `orchestration.spawn` and `orchestration.spawn-rejected` events via Bus
- Step 5: Add tests: `test/orchestration/spawn-limits.test.ts`

### Phase 3: Concurrency Limiter

- Step 1: Create `src/orchestration/concurrency.ts` — keyed semaphore with `acquire(key)`, `release(key)`, `cancelWaiters(key)` using Promise queue pattern
- Step 2: Add `experimental.model_concurrency` (Record<string, number>, default `{}` → fallback 5) to config schema
- Step 3: Wire into `src/tool/task.ts` — wrap `SessionPrompt.prompt()` call with acquire/release (~4-line diff)
- Step 4: Wire into `src/tool/batch.ts` — wrap `Promise.all()` with optional batch-level concurrency (~10-line diff, only active when `experimental.model_concurrency.batch` is set)
- Step 5: Publish `orchestration.concurrency-queued` / `orchestration.concurrency-released` events
- Step 6: Add tests: `test/orchestration/concurrency.test.ts`

### Phase 4: Category Routing + Ultrawork Override

- Step 1: Create `src/orchestration/category-routing.ts` — resolves `{ providerID, modelID }` from category name + config map, fallback to parent model
- Step 2: Create `src/orchestration/ultrawork.ts` — detects `ulw`/`ultrawork` keyword in prompt text (stripping code blocks), returns override model or null
- Step 3: Add `experimental.task_categories` and `experimental.ultrawork_model` to config schema
- Step 4: Wire category routing into `src/tool/task.ts` — if task params include category hint, resolve model before session creation (~6-line diff)
- Step 5: Wire ultrawork as direct call in `src/tool/task.ts` — resolve model override from prompt text before `SessionPrompt.prompt()` (~3-line diff)
- Step 6: Add tests: `test/orchestration/category-routing.test.ts`, `test/orchestration/ultrawork.test.ts`

## Risks

| Risk                                                      | Mitigation                                                                                   |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Config schema field additions conflict on rebase          | Fields are appended to `experimental` object — merge is trivial even if upstream adds others |
| `task.ts` guard wiring conflicts                          | Limit to ~35 total lines changed; isolate all logic in new files                             |
| Loop detector false positives                             | Configurable threshold + only triggers on exact signature match (tool name + JSON input)     |
| Concurrency limiter deadlocks                             | Settled-flag pattern on queue entries; `cancelWaiters()` for cleanup on session abort        |
| Ultrawork keyword in code blocks                          | Strip fenced/inline code before regex test                                                   |
| Feature interaction (loop detector + concurrency limiter) | Independent modules; no shared state; both are pre/post guards                               |
