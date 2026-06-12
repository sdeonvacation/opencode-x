# Plan: Agent Loop Performance (claude-code parity)

## Overview

opencode's agentic loop is slower than claude-code on the same model because persistence (SQLite immediate transactions, bus publishes, plugin triggers, snapshot tracking) runs **on the hot path** for every stream event. claude-code keeps the loop as plain async-generator yields and persists asynchronously. This plan ports the most impactful patterns and closes the gap. **Phase 0** cherry-picks 5 upstream perf/refactor commits that landed since our last sync (mergeDeep type-perf, llm/request.ts extraction, compaction tail serialize+restore, double-auto-compaction fix, cache:auto default). **Phase 1** cherry-picks 5 fixes already on local `buddy` branch (commit `b1a1c36a59`) that were never merged to `devlocal`. **Phases 2–6** are net-new work inspired by claude-code's design (mid-stream tool dispatch, input-aware parallel-safety, snapshot skip, reactive compaction, plugin/transform fast paths).

## Status vs Upstream

### Upstream wins available (NOT in HEAD)

| Commit                      | Win                                                                                                                                                         | Relevance                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `ff55a40749`                | wrap `mergeDeep` to skip remeda conditional type instantiation in `llm.ts` hot path; remove `@effect/language-service`; narrow Drizzle `migrate()` overload | direct LLM-stream perf; type-check + runtime                        |
| `94564f3588`                | prevent double auto-compaction triggered by `filterCompacted` reorder                                                                                       | redundant-compaction bug + perf                                     |
| `942630eb4a` + `9b369ee815` | cache-policy auto-placement; default `cache: 'auto'`                                                                                                        | provider prompt-cache wins → effective latency                      |
| `2d0d3d596e` + `ca28dd02ec` | `serialize compaction tail` + `restore tail turns after summarization`                                                                                      | overlaps net-new compaction work; pick first                        |
| `fb9d69ef62`                | extract `session/llm/request.ts` (231→40 LOC in `llm.ts`)                                                                                                   | refactor — applied first to reduce conflict surface for our changes |

### Upstream wins already in HEAD (no action)

`06830327e7` efficient snapshots in parallel toolcalls; `d4379c8c93` tool-call streaming on; `558590712d` parallel-tool AGENTS.md double-load fix.

### Net-new fixes

| #   | Fix                                                                      | upstream/dev | local `buddy`                     | existing plan                               |
| --- | ------------------------------------------------------------------------ | ------------ | --------------------------------- | ------------------------------------------- |
| 1   | `updatePart` coalescer (batch DB writes during stream)                   | missing      | landed (`part-coalescer.ts`)      | —                                           |
| 2   | Doom-loop ring buffer (replace `MessageV2.parts()` SELECT per tool-call) | missing      | landed (`doom-loop.ts`)           | —                                           |
| 3   | History cache (incremental message rebuild per turn)                     | missing      | landed (`history-cache.ts`)       | —                                           |
| 4   | Tool schema/definition cache                                             | missing      | landed (`registry.ts` cache)      | —                                           |
| 5   | Server-side SSE event filtering                                          | missing      | landed (`server/routes/event.ts`) | —                                           |
| 6   | Input-aware parallel-safety (incl. read-only bash)                       | partial      | partial                           | `PLAN_parallel-tool-calls.md`               |
| 7   | Mid-stream tool dispatch (start before AI SDK step boundary)             | missing      | missing                           | —                                           |
| 8   | Skip snapshot when no FS-mutating tool ran                               | missing      | missing                           | —                                           |
| 9   | Reactive (413-driven) compaction in addition to proactive                | missing      | missing                           | extends `PLAN_sliding_window_compaction.md` |
| 10  | Plugin-empty + provider-transform fast paths                             | missing      | missing                           | —                                           |

Fixes 1–5: cherry-pick from `buddy` (`b1a1c36a59` + `e7ca7cf39a` + `3af8f5a72e`) + reconcile against current `devlocal` tip (which has hybrid-routing v4, sliding-window v2, claurst ports). Fixes 6–10: net-new work.

## Tech Stack

- TypeScript 5.8, Bun 1.3.11
- Effect 4.0.0-beta (existing fibers, semaphores, Stream)
- Vercel AI SDK 6.x (`streamText`, `fullStream`, `providerOptions.parallelToolCalls`)
- SQLite via drizzle-orm + bun:sqlite (existing `SyncEvent.run`)
- Existing services: `Session`, `MessageV2`, `Snapshot`, `Plugin`, `ProviderTransform`

## Testing Strategy

- **Unit**: coalescer flush windows, ring buffer rotation, history-cache invalidation, tool registry cache key, parallel-safety input checks, snapshot skip predicate, reactive compaction trigger
- **Integration**: full session workflow with all phases enabled — stream-heavy turn, tool-heavy turn, parallel-tool turn, compaction turn, mid-stream tool dispatch turn
- **Perf coverage**: bench harness measuring (a) DB tx count per turn, (b) wall-clock time-to-first-tool-result, (c) tool-batch parallelism factor — capture before/after numbers per phase
- **Done when**: all existing tests pass, perf bench shows ≥30% reduction in wall-clock per turn on a 50-event tool-heavy fixture, ≥50% reduction in SQLite tx count, no regression in correctness tests

## Phases

### Phase 0: Cherry-pick upstream perf wins (do first, smallest risk)

- Step 1: Cherry-pick `fb9d69ef62` ("refactor(opencode): extract session LLM request prep") — pulls 231 LOC out of `llm.ts` into `llm/request.ts`; gives a clean surface for Phase 1+3 changes
- Step 2: Cherry-pick `ff55a40749` ("optimize hot path type performance") — wraps `mergeDeep` in `llm.ts` + `config.ts`; removes `@effect/language-service`; narrows Drizzle `migrate()` overload
- Step 3: Cherry-pick `2d0d3d596e` then `ca28dd02ec` (compaction tail serialize + tail restore) — Phase 5 redesigned on top of these
- Step 4: Cherry-pick `94564f3588` ("prevent double auto-compaction from filterCompacted reorder") — removes a redundant compaction call per turn
- Step 5: Cherry-pick `942630eb4a` ("cache-policy auto-placement") then `9b369ee815` ("cache: 'auto' default") — provider prompt-cache wins
- Step 6: After each cherry-pick: `bun typecheck` + targeted test run; if conflicts arise from our local hybrid-routing v4 / sliding-window v2 / claurst patches, fix locally, do not skip
- Step 7: Reconcile any conflicts in `session/compaction.ts`, `session/message-v2.ts`, `session/llm.ts` against our existing forks

**Touch points**: `session/llm.ts`, `session/llm/request.ts` (new from upstream), `session/compaction.ts`, `session/message-v2.ts`, `config/config.ts`, `storage/db.ts`, `tsconfig.json`, `package.json`, `bun.lock`

**Risk**: Cherry-pick conflict cascade with our hybrid-routing and sliding-window v2 patches. Mitigate by doing each pick atomically with a build+test gate; abort and replan if any single pick exceeds 30 min reconcile time.

### Phase 1: Cherry-pick `buddy` perf foundation (fixes 1–5)

- Step 1: Cherry-pick `b1a1c36a59` ("perf(session): optimize workflow hot paths") onto current `devlocal`; resolve conflicts against hybrid-routing v4 (`processor.ts:230-302`) and sliding-window v2 (`processor.ts:480-690`)
- Step 2: Cherry-pick `e7ca7cf39a` ("fix: performance improvements") follow-ups
- Step 3: Verify the cherry-pick brings: `session/part-coalescer.ts`, `session/doom-loop.ts`, `session/history-cache.ts`, `util/queue.ts` extensions, `tool/registry.ts` cache, `server/routes/event.ts` filtering
- Step 4: Reconcile `processor.ts` so coalescer + doom-loop ring buffer compose with hybrid-routing's second `updatePart` (compressed output) — terminal-state must bypass coalescer so compressed result is committed before next API turn
- Step 5: Reconcile with sliding-window v2 — history-cache invalidation must trigger on compaction-window mutation (existing `SlidingWindow.invalidate()` hook)
- Step 6: Run existing test suites; backport tests bundled with `b1a1c36a59` (`test/server/event-filter.test.ts`, perf coverage)
- Step 7: Add perf bench harness committed under `packages/opencode/script/bench-loop.ts` measuring SQLite tx count + wall-clock per turn

**Touch points**: `session/processor.ts`, `session/index.ts`, `session/message-v2.ts`, `tool/registry.ts`, `server/routes/event.ts`, `util/queue.ts`, plus 4 new files

### Phase 2: Input-aware parallel-safety (fix 6)

- Step 1: Add `parallelSafe(input)` predicate per tool to `tool/tool.ts` interface (default to existing static `parallelSafe: boolean`)
- Step 2: Implement input-aware predicates: `bash` returns true only for whitelist (`ls`, `cat`, `grep`, `find`, `git status`, `git log`, `git diff`, `pwd`, `wc`); `read` always safe (after Phase 3 of `PLAN_parallel-tool-calls.md`)
- Step 3: Wire `session/llm.ts` parallel-tool-calls gate to call `parallelSafe(input)` when input is known (post tool-input-end), AND to AI SDK's `providerOptions.parallelToolCalls` flag at request-time when ALL pending tools are statically parallel-safe
- Step 4: Lift `experimental.parallel_read` flag default to true (after Phase 3 audit confirms LSP/file-time guards in place)
- Step 5: Unit tests for `bash` whitelist matcher; integration test for mixed-safety batch (read + bash `ls` → parallel; read + bash `npm test` → serial)

**Touch points**: `tool/tool.ts`, `tool/bash.ts`, `tool/read.ts`, `session/llm.ts`, `session/prompt.ts` (parallel gate)

### Phase 3: Mid-stream tool dispatch (fix 7)

- Step 1: Add `StreamingToolDispatcher` service in `session/streaming-dispatcher.ts` that observes `tool-input-end` events from `streamText` and kicks `tool.execute()` on a fiber immediately, before AI SDK's step boundary
- Step 2: Buffer tool results in `ctx.pendingResults` keyed by `toolCallId`; on `tool-result` event from AI SDK, return cached result instead of re-executing
- Step 3: Guard with `experimental.midstream_tool_dispatch` config flag (default false initially)
- Step 4: Compatibility check: only enable when AI SDK's `streamText` exposes the necessary lifecycle hook (likely via `onStepFinish` callback returning prepared results, or via `prepareStep`); if AI SDK doesn't expose, fall back to no-op
- Step 5: Unit test: mock stream emits 3 `tool-input-end` events 100ms apart; assert all 3 tools start executing immediately (parallel safe ones), not serially after stream ends
- Step 6: Integration test on real provider: measure time-to-first-result vs baseline

**Touch points**: `session/streaming-dispatcher.ts` (new), `session/processor.ts` (subscribe/inject), `session/llm.ts` (AI SDK hook wiring), `config/schema.ts` (flag)

### Phase 4: Skip snapshot when no FS tool (fix 8)

- Step 1: Add `ctx.fsToolFired: boolean` flag, set true on tool-call where tool name ∈ {`edit`, `write`, `bash`, `patch`, `multiedit`}
- Step 2: Guard `snapshot.track()` in `processor.ts:530` (`start-step` handler): skip when `!ctx.fsToolFired` AND `ctx.snapshot` already exists from prior step
- Step 3: Guard `snapshot.patch(ctx.snapshot)` in `processor.ts:592` and `:694`: skip when `!ctx.fsToolFired` since last snapshot
- Step 4: Reset `ctx.fsToolFired = false` after each `snapshot.patch()` commit
- Step 5: Unit test: pure-read turn (3 grep + 1 read) → zero snapshot calls; mixed turn (read + edit) → exactly 1 track + 1 patch

**Touch points**: `session/processor.ts`, `session/run-state.ts` (ctx type)

### Phase 5: Reactive compaction (fix 9)

**Prereq**: Phase 0 picks `2d0d3d596e` + `ca28dd02ec` + `94564f3588` first. Reactive logic is layered on top of upstream's serialized-tail compaction, not in place of it.

- Step 1: Add 413/context-overflow error handler in `session/llm.ts` retry path that triggers compaction inline + retries the same turn
- Step 2: Relax proactive compaction threshold in `session/sliding-window.ts` from current `tokens > limit * 0.85` to `tokens > limit * 0.95` (less aggressive — let reactive path catch the rest)
- Step 3: Make compaction async-spawnable via `Effect.fork` so the next API turn can dispatch BEFORE compaction summary completes when proactive but not yet overflowing — read existing summary if present, else block
- Step 4: Unit test: simulate 413 → compaction fires → retry succeeds with compacted history (using upstream's tail-restore behavior)
- Step 5: Integration test: measure proactive-vs-reactive trigger ratio across realistic workloads

**Touch points**: `session/llm.ts`, `session/sliding-window.ts`, `session/compaction.ts`, `session/processor.ts` (fork point)

### Phase 6: Plugin/transform fast paths (fix 10)

- Step 1: Add `Plugin.hasListeners(event: string): boolean` cheap check; in `processor.ts:566-574` and other `plugin.trigger` sites, early-return when no listeners registered
- Step 2: Memoize `ProviderTransform.toolCaching(visible, model, sessionID)` result by `(model.id, hash(visible.map(t=>t.id)), sessionID)` — invalidate on tool list mutation
- Step 3: Memoize `ProviderTransform.message()` middleware result for system-prompt slice (rarely changes within a session)
- Step 4: Unit tests for cache hit/miss + invalidation
- Step 5: Bench: measure `wrapLanguageModel` overhead before/after on a 20-turn session

**Touch points**: `plugin/index.ts`, `provider/transform.ts`, `provider/index.ts`

## Risks

- **Phase 0 cherry-pick conflicts with hybrid-routing v4 / sliding-window v2 / claurst patches**: Mitigate by atomic per-commit pick + build/test gate; reorder picks if a later one conflicts less; abort + replan if any pick exceeds 30 min reconcile time
- **Coalesced writes lose events on crash**: Mitigate with flush-on-dispose, terminal-state immediate persist (already in `buddy` design), and crash-recovery replay via existing `EventSequenceTable`
- **Doom-loop hash collisions cause false positives**: Mitigate with stable canonical-JSON hash + threshold ≥3 identical signatures
- **History cache stale after compaction**: Mitigate with explicit invalidation on `SlidingWindow.invalidate()` event + full-rebuild fallback
- **Tool schema cache stale after MCP/plugin hot-reload**: Mitigate with version-hash invalidation on registry mutation events
- **Mid-stream dispatch ordering breaks AI SDK contract**: Mitigate by gating behind experimental flag; only kick fiber when input is fully streamed (`tool-input-end`); on AI SDK shape change, fall back to no-op
- **Reactive compaction adds latency on overflow turn**: Mitigate by combining with proactive at 95% threshold so 413 is rare; proactive forks compaction so next turn can prefetch summary
- **Skipped snapshot misses ambient FS changes (user editing externally)**: Acceptable — opencode does not currently track external edits between steps; behavior preserved
- **Bash whitelist false negatives (denies safe commands)**: Mitigate with conservative whitelist + escape hatch via per-tool `parallelSafe: true` config
- **Plugin fast-path hides bugs in plugin loader**: Mitigate by keeping `hasListeners()` cheap and tested separately; plugin trigger path still exercised in test suite
- **Cherry-pick from `buddy` conflicts with hybrid-routing v4 second `updatePart`**: Mitigate by treating compressed-output write as terminal-state in coalescer (immediate flush)
