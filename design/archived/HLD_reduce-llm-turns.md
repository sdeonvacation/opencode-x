# HLD: Reduce LLM Turns in OpenCode Sessions

## Tech Stack

| Category  | Technology        | Purpose                                              |
| --------- | ----------------- | ---------------------------------------------------- |
| Language  | TypeScript 5.8    | Existing codebase language                           |
| Runtime   | Bun 1.3.11        | Existing runtime                                     |
| Framework | Effect 4.0-beta   | Service/layer patterns, Effect.fn for traced effects |
| AI SDK    | Vercel AI SDK 6.x | `streamText`, `maxSteps`, parallel tool call support |
| Schema    | Zod               | Config schema extensions in `experimental.*`         |
| Database  | SQLite + Drizzle  | Session/message persistence (no schema changes)      |
| Test      | bun:test          | Unit and integration tests                           |

## Components

| Component               | Responsibility                                        | Dependencies                                  |
| ----------------------- | ----------------------------------------------------- | --------------------------------------------- |
| `Config.experimental`   | Feature flags for all optimizations                   | Zod schema                                    |
| `LLM.stream`            | LLM call site; parallel gate, maxSteps injection      | `parallelGate`, `ProviderTransform`, `Config` |
| `SessionPrompt.runLoop` | Main execution loop; prune, overflow, step management | `SlidingWindow`, `SessionCompaction`, `LLM`   |
| `SessionProcessor`      | Tool result processing; deny/break logic              | `Config`, `Permission`, `LLM`                 |
| `SessionCompaction`     | Pruning old tool outputs; compression decisions       | `MessageV2`, `Token`, `Config`                |
| `SlidingWindow`         | Token estimation and context windowing with cache     | `MessageV2`, `Provider.Model`, `Config`       |
| `SystemPrompt`          | Agent system prompt generation                        | `Agent.Info`, `Plugin`                        |
| `task.ts` (tool)        | Subagent spawning with context transfer               | `spawnSubagent`, `MessageV2`, `SessionPrompt` |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     SessionPrompt.runLoop                            │
│                                                                     │
│  ┌──────────┐  ┌───────────────┐  ┌──────────────┐  ┌───────────┐ │
│  │ prune()  │→ │ SlidingWindow │→ │ resolveTools │→ │ LLM.stream│ │
│  │ (#5,#10) │  │   .compact()  │  │   (#9)       │  │ (#1,#6)   │ │
│  └──────────┘  │   (#10 cache) │  └──────────────┘  └─────┬─────┘ │
│                └───────────────┘                           │       │
│                                                            ▼       │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    Processor.process()                        │  │
│  │  ┌─────────────┐  ┌──────────────────┐  ┌────────────────┐  │  │
│  │  │ shouldBreak │  │ compression gate │  │ noop detection │  │  │
│  │  │    (#3)     │  │      (#4)        │  │     (#8)       │  │  │
│  │  └─────────────┘  └──────────────────┘  └────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────────┐  ┌──────────────────────────────────────┐    │
│  │ SystemPrompt (#2)│  │ task.ts → spawnSubagent (#7)         │    │
│  │ batch instruction│  │ context transfer from parent session │    │
│  └──────────────────┘  └──────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

**Description**: All 10 optimizations target the `runLoop` execution path. Phase 1 changes (config/prompt) alter behavior without touching loop logic. Phase 2-5 changes modify specific functions within the loop. Each optimization is guarded by a feature flag in `Config.experimental`, enabling independent rollback.

---

## Phase 1: Config-Only (Zero Risk)

### Optimization #1 — Enable `parallel_tool_calls` for Primary Agent

| Attribute          | Value                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| **Files**          | `src/config/config.ts` (line ~1216)                                                                                        |
| **Change**         | Change `parallel_tool_calls` default from `undefined` to `true`; change `parallel_read` default from `undefined` to `true` |
| **Mechanism**      | `parallelGate()` in `llm.ts:90` already checks this flag; changing default enables it for primary agents                   |
| **Rebase risk**    | Low — single default value in schema                                                                                       |
| **Stability risk** | None — `parallelGate` already rejects unsafe combinations                                                                  |
| **Rollback**       | Set `experimental.parallel_tool_calls: false` in user config                                                               |

### Optimization #2 — Batch System Prompt Instruction

| Attribute          | Value                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Files**          | `src/session/prompt.ts` (within `SystemPrompt.environment()` or agent prompt assembly ~line 1426)                                     |
| **Change**         | Append instruction text: "When investigating code, batch multiple read/grep/glob calls in a single response to minimize round-trips." |
| **Mechanism**      | Model receives instruction in system prompt; combined with #1, model issues parallel tool calls                                       |
| **Rebase risk**    | Low — additive append to system prompt array                                                                                          |
| **Stability risk** | None — model may ignore instruction; cannot cause harm                                                                                |
| **Rollback**       | Remove the appended string                                                                                                            |

### Optimization #3 — `continue_loop_on_deny` Default True

| Attribute          | Value                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| **Files**          | `src/session/processor.ts` (line 635)                                                                     |
| **Change**         | Change `(yield* config.get()).experimental?.continue_loop_on_deny !== true` to `=== false` (flip default) |
| **Mechanism**      | When tool denied, `shouldBreak` remains `false`; model continues with remaining tools                     |
| **Rebase risk**    | Low — single boolean expression                                                                           |
| **Stability risk** | Low-Med — model sees deny feedback and adapts; `agent.steps` caps iterations                              |
| **Rollback**       | Set `experimental.continue_loop_on_deny: false` in user config                                            |

---

## Phase 2: Low-Complexity Code Changes

### Optimization #4 — Raise Compression Thresholds / Heuristic Fallback

| Attribute          | Value                                                                                                                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Files**          | `src/session/compaction.ts` (compression decision logic, ~line 387+), `src/session/processor.ts` (tool result handling)                                                                                                                                                               |
| **Change**         | (a) Add threshold check: skip LLM compression for tool outputs < 5000 chars. (b) For `grep`/`glob` tools: use heuristic truncation (first 50 + last 20 lines) instead of LLM compression. (c) Keep LLM compression only for `bash`/`read` outputs where semantic summarization helps. |
| **Mechanism**      | Before calling `generateText()` for compression, check tool name and output size                                                                                                                                                                                                      |
| **Rebase risk**    | Medium — compaction.ts is actively maintained                                                                                                                                                                                                                                         |
| **Stability risk** | Low — slightly more context consumed per output; existing `prune()` handles overflow                                                                                                                                                                                                  |
| **Rollback**       | Feature flag: `experimental.compression_threshold` (new, default 5000; set to 0 to disable)                                                                                                                                                                                           |

### Optimization #8 — Smart Exit on Noop Iterations

| Attribute          | Value                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Files**          | `src/session/prompt.ts` (line ~1456, after `handle.process()` returns)                                                                      |
| **Change**         | After process completes: if `handle.message.finish` is truthy AND no tool parts were added AND no text content generated → return `"break"` |
| **Mechanism**      | Catches edge case where model returns empty response with "stop" or "end_turn" but existing exit condition at line 1253 doesn't trigger     |
| **Rebase risk**    | Low — additive check in existing branch                                                                                                     |
| **Stability risk** | Low — only breaks on genuinely empty responses                                                                                              |
| **Rollback**       | Feature flag: `experimental.noop_exit` (new, default true; set false to disable)                                                            |

---

## Phase 3: Medium-Complexity Improvements

### Optimization #5 — Proactive Context Pruning Before Overflow

| Attribute            | Value                                                                                                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Files**            | `src/session/prompt.ts` (line ~1224, after `compaction.prune()`), `src/session/compaction.ts` (prune function ~line 331), `src/session/overflow.ts`                                                                                                                 |
| **Change**           | (a) After `SlidingWindow.compact()` returns metrics, check if `sw.total > 0.8 * model.limit.context`. (b) If yes, call `compaction.prune()` with reduced `PRUNE_PROTECT` (e.g., 20_000 instead of 40_000). (c) Add `earlyPrune` option to prune function signature. |
| **Mechanism**        | Prune more aggressively at 80% utilization to avoid triggering full compaction LLM call                                                                                                                                                                             |
| **Interface change** | `prune(input: { sessionID, aggressive?: boolean })` — when `aggressive`, use halved PRUNE_PROTECT                                                                                                                                                                   |
| **Rebase risk**      | Medium — touches prune logic and loop body                                                                                                                                                                                                                          |
| **Stability risk**   | Medium — might discard information model needs; mitigated by keeping 2 most recent turns intact                                                                                                                                                                     |
| **Rollback**         | Feature flag: `experimental.proactive_prune` (new, default true; set false to disable)                                                                                                                                                                              |

### Optimization #7 — Subagent Context Transfer

| Attribute            | Value                                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Files**            | `src/tool/task.ts` (line ~152, before `SessionPrompt.resolvePromptParts`), `src/orchestration/task-spawn.ts` (no changes needed)                                                                        |
| **Change**           | (a) Before spawning subagent, collect recent tool results from parent session that match file paths in instruction. (b) Append as structured context block to `params.prompt`. (c) Cap at ~4000 tokens. |
| **Mechanism**        | `MessageV2.get()` on parent session → filter tool parts by path relevance → serialize as context prefix                                                                                                 |
| **Interface change** | New helper: `buildContextTransfer(sessionID, instruction): string`                                                                                                                                      |
| **Rebase risk**      | Medium — task.ts sees moderate churn                                                                                                                                                                    |
| **Stability risk**   | Low — context is advisory; subagent still reads files independently                                                                                                                                     |
| **Rollback**         | Feature flag: `experimental.subagent_context_transfer` (new, default true; set false to disable)                                                                                                        |

---

## Phase 4: High-Complexity, High-Reward

### Optimization #6 — `maxSteps` in streamText for Safe Tool Chains

| Attribute            | Value                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Files**            | `src/session/llm.ts` (line ~385, `streamText()` call), `src/session/prompt.ts` (line ~1435, `handle.process()` call), `src/session/processor.ts` (stream handling)                                                                                                                                                                    |
| **Change**           | (a) In `LLM.stream()`, accept optional `maxSteps` parameter. (b) When `parallelGate()` returns true AND all tools are read-only: pass `maxSteps: 3` to `streamText()`. (c) Handle multi-step stream events in processor (tool-call events come in sequence within single stream). (d) After stream completes, sync final state to DB. |
| **Mechanism**        | Vercel AI SDK `maxSteps` auto-continues model→tools→model within single stream, skipping outer loop overhead                                                                                                                                                                                                                          |
| **Interface change** | `LLM.StreamInput` gains `maxSteps?: number`; `LLM.stream()` passes it to `streamText()`                                                                                                                                                                                                                                               |
| **Rebase risk**      | HIGH — touches `llm.ts` streamText call (hot code), processor stream handling                                                                                                                                                                                                                                                         |
| **Stability risk**   | HIGH — loses per-step overflow detection, per-step permission re-evaluation, intermediate DB persistence                                                                                                                                                                                                                              |
| **Mitigation**       | (a) Only enable when ALL tools are `parallelSafe`. (b) Cap at 3 steps. (c) Add token check in stream event handler — abort if approaching limit. (d) Feature flag gated.                                                                                                                                                              |
| **Rollback**         | Feature flag: `experimental.max_steps` (new, default 0 = disabled; set to 3-5 to enable)                                                                                                                                                                                                                                              |

---

## Phase 5: Latency Optimizations (Non-Turn-Saving)

### Optimization #9 — Pre-Resolve Permissions at Agent Level

| Attribute          | Value                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Files**          | `src/session/prompt.ts` (line ~1348, `resolveTools()`), `src/session/llm.ts` (line ~464, `resolveTools()`)                                                                                  |
| **Change**         | (a) Compute `Permission.effective()` once at loop step start. (b) Pass resolved permission map to tool context. (c) Skip per-call `permission.ask()` for tools already resolved to "allow". |
| **Mechanism**      | Batch permission evaluation; cache invalidates on permission-change events                                                                                                                  |
| **Rebase risk**    | Medium — permission resolution path sees occasional changes                                                                                                                                 |
| **Stability risk** | Low — must invalidate cache on permission events; existing `Permission.evaluate` is pure                                                                                                    |
| **Rollback**       | Feature flag: `experimental.batch_permissions` (new, default true; set false to disable)                                                                                                    |

### Optimization #10 — Cache SlidingWindow Computation

| Attribute          | Value                                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Files**          | `src/session/sliding-window.ts` (line ~52, `compact()` function)                                                                                                                                                   |
| **Change**         | (a) Track message count + last message ID per session. (b) If unchanged from previous iteration, return cached result. (c) Existing `invalidate()` already clears cache — ensure it's called on message mutations. |
| **Mechanism**      | Generation counter: increment on new message; skip `compact()` when generation matches                                                                                                                             |
| **Rebase risk**    | Low — sliding-window.ts is relatively stable                                                                                                                                                                       |
| **Stability risk** | Low — invalidation already exists; correctness depends on `invalidate()` being called (already is at line 1284 of prompt.ts)                                                                                       |
| **Rollback**       | Feature flag: `experimental.cache_sliding_window` (new, default true; set false to disable)                                                                                                                        |

---

## Interfaces

### Config.experimental (extended schema)

| Field                       | Type       | Default                         | Behavior                               |
| --------------------------- | ---------- | ------------------------------- | -------------------------------------- |
| `parallel_tool_calls`       | `boolean?` | `true` (changed from undefined) | Master switch for parallel tool calls  |
| `parallel_read`             | `boolean?` | `true` (changed from undefined) | Enables read in parallel               |
| `continue_loop_on_deny`     | `boolean?` | `true` (changed from undefined) | Continue loop on tool deny             |
| `compression_threshold`     | `number?`  | `5000`                          | Min chars before LLM compression       |
| `noop_exit`                 | `boolean?` | `true`                          | Exit on empty model responses          |
| `proactive_prune`           | `boolean?` | `true`                          | Prune at 80% context utilization       |
| `subagent_context_transfer` | `boolean?` | `true`                          | Transfer parent context to subagents   |
| `max_steps`                 | `number?`  | `0`                             | maxSteps for streamText (0=disabled)   |
| `batch_permissions`         | `boolean?` | `true`                          | Pre-resolve permissions per step       |
| `cache_sliding_window`      | `boolean?` | `true`                          | Cache SlidingWindow between iterations |

### LLM.stream (extended)

| Field      | Type      | Default     | Behavior                          |
| ---------- | --------- | ----------- | --------------------------------- |
| `maxSteps` | `number?` | `undefined` | Passed to `streamText()` when set |

### SessionCompaction.prune (extended)

| Field        | Type       | Default | Behavior                                 |
| ------------ | ---------- | ------- | ---------------------------------------- |
| `aggressive` | `boolean?` | `false` | When true, use PRUNE_PROTECT/2 threshold |

### buildContextTransfer (new helper in task.ts)

| Method                 | Input                                       | Output   | Behavior                                                                                                                |
| ---------------------- | ------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `buildContextTransfer` | `sessionID: SessionID, instruction: string` | `string` | Extracts recent tool results matching file paths in instruction; returns formatted context block capped at ~4000 tokens |

---

## Data Flow

### Happy Path: Parallel Read-Heavy Exploration (Phase 1+4)

| Step | Component       | Action                                              | Next                      |
| ---- | --------------- | --------------------------------------------------- | ------------------------- |
| 1    | `runLoop`       | Prune old tool outputs, fetch messages              | `SlidingWindow.compact()` |
| 2    | `SlidingWindow` | Return cached result (no change since last step)    | `resolveTools`            |
| 3    | `resolveTools`  | Resolve tools; all are parallelSafe + allowed       | `LLM.stream`              |
| 4    | `LLM.stream`    | `parallelGate()` → true; set `maxSteps: 3`          | `streamText`              |
| 5    | `streamText`    | Model issues 3 grep calls; SDK executes in parallel | Model                     |
| 6    | Model           | Receives results, issues 2 more reads               | SDK auto-step             |
| 7    | SDK             | Executes reads in parallel (step 2 of 3)            | Model                     |
| 8    | Model           | Produces final text response                        | Processor                 |
| 9    | Processor       | Syncs all parts to DB; returns "continue"           | Loop exit                 |

**Savings**: Steps 5-8 happen within ONE `streamText` call instead of 3 separate outer loop iterations (saving 2× DB fetch + system prompt rebuild + SlidingWindow + tool resolution).

### Error Flow: Overflow During maxSteps

| Step | Component             | Action                                                     | Next           |
| ---- | --------------------- | ---------------------------------------------------------- | -------------- |
| 1    | `streamText` (step 2) | Token count in stream event approaches limit               | Stream handler |
| 2    | Stream handler        | Detects `tokens.input > 0.9 * model.limit.context`         | Abort          |
| 3    | Abort                 | Signal fires; stream terminates gracefully                 | Processor      |
| 4    | Processor             | Marks message with partial results; sets `needsCompaction` | Loop           |
| 5    | Loop                  | Creates compaction task on next iteration                  | Compaction     |

---

## Data Model

No new database entities. All changes are runtime-only (config schema, in-memory caches).

| Entity        | Fields                                                                                                                                                                                                                                           | Relationships | Constraints                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | --------------------------- |
| `Config.Info` | `+experimental.compression_threshold`, `+experimental.noop_exit`, `+experimental.proactive_prune`, `+experimental.subagent_context_transfer`, `+experimental.max_steps`, `+experimental.batch_permissions`, `+experimental.cache_sliding_window` | None          | All optional, Zod-validated |

---

## Rebase Safety Matrix

| #   | Optimization                | Files Touched                                                              | Lines Changed | File Hotness | Conflict Likelihood                                       |
| --- | --------------------------- | -------------------------------------------------------------------------- | ------------- | ------------ | --------------------------------------------------------- |
| 1   | parallel_tool_calls default | `config/config.ts:1216`                                                    | 2             | Medium       | **Low** — schema defaults rarely conflict                 |
| 2   | Batch prompt instruction    | `session/prompt.ts:~1426`                                                  | 3             | High         | **Low** — additive append to array                        |
| 3   | continue_loop_on_deny       | `session/processor.ts:635`                                                 | 1             | Medium       | **Low** — single expression                               |
| 4   | Compression thresholds      | `session/compaction.ts:387+`                                               | ~20           | Medium       | **Medium** — compression logic sees changes               |
| 5   | Proactive pruning           | `session/prompt.ts:1224`, `session/compaction.ts:331`                      | ~30           | High/Medium  | **Medium** — loop body is hot                             |
| 6   | maxSteps in streamText      | `session/llm.ts:385`, `session/prompt.ts:1435`, `session/processor.ts:632` | ~40           | High         | **HIGH** — streamText call and processor are hottest code |
| 7   | Subagent context transfer   | `tool/task.ts:152`                                                         | ~25           | Medium       | **Medium** — task.ts sees moderate churn                  |
| 8   | Noop exit                   | `session/prompt.ts:1456`                                                   | 5             | High         | **Low** — additive check after existing logic             |
| 9   | Pre-resolve permissions     | `session/prompt.ts:1348`, `session/llm.ts:464`                             | ~20           | High/Medium  | **Medium** — permission path evolves                      |
| 10  | Cache SlidingWindow         | `session/sliding-window.ts:52`                                             | ~15           | Low          | **Low** — stable file, isolated change                    |

**Legend**: File Hotness = frequency of upstream changes in last 60 days (High = weekly, Medium = bi-weekly, Low = monthly or less).

---

## Stability Guarantees

### Invariants That MUST Hold

| Invariant                                                   | Verification                                               | Affected Optimizations |
| ----------------------------------------------------------- | ---------------------------------------------------------- | ---------------------- |
| Every tool call gets persisted to DB                        | `bun test test/session/` — check message parts after loop  | #6 (maxSteps)          |
| Permission denials are always surfaced to model             | Assert deny feedback in tool result text                   | #3, #9                 |
| Context never exceeds `model.limit.context`                 | `isOverflow()` check remains in loop; add assertion in CI  | #5, #6, #10            |
| `SlidingWindow.invalidate()` called on message mutations    | Grep for all `updateMessage`/`updatePart` sites            | #10                    |
| Subagent sessions are independent (can re-read files)       | Existing subagent tests pass unchanged                     | #7                     |
| Loop terminates within `agent.steps` iterations             | `maxSteps` agent config unchanged; outer loop still counts | #6, #8                 |
| Parallel tool calls never execute unsafe tools concurrently | `parallelGate` logic unchanged; test with mixed tool sets  | #1, #6                 |

### Verification Commands

```bash
# Run full session test suite
bun --cwd packages/opencode test test/session/ --timeout 30000

# Run tool tests
bun --cwd packages/opencode test test/tool/ --timeout 30000

# Type check
bun --cwd packages/opencode typecheck
```

---

## Feature Flags

Every optimization is independently toggleable via `experimental.*` config without code revert:

| Optimization | Flag                                     | Disable Value | Effect When Disabled                             |
| ------------ | ---------------------------------------- | ------------- | ------------------------------------------------ |
| #1           | `experimental.parallel_tool_calls`       | `false`       | Falls back to serial tool execution              |
| #1           | `experimental.parallel_read`             | `false`       | Excludes read from parallel gate                 |
| #2           | N/A (prompt text)                        | Remove text   | Model stops batching (graceful degradation)      |
| #3           | `experimental.continue_loop_on_deny`     | `false`       | Loop breaks on deny (original behavior)          |
| #4           | `experimental.compression_threshold`     | `0`           | All outputs go through LLM compression           |
| #5           | `experimental.proactive_prune`           | `false`       | Prune only runs at start of iteration (original) |
| #6           | `experimental.max_steps`                 | `0`           | streamText called without maxSteps (original)    |
| #7           | `experimental.subagent_context_transfer` | `false`       | Subagents start with instruction only (original) |
| #8           | `experimental.noop_exit`                 | `false`       | Rely on existing exit conditions only            |
| #9           | `experimental.batch_permissions`         | `false`       | Per-call permission evaluation (original)        |
| #10          | `experimental.cache_sliding_window`      | `false`       | Recompute every iteration (original)             |

**Runtime toggle**: All flags read via `yield* config.get()` which reloads on file change. No restart needed.

---

## Decisions

| Decision                               | Choice                                                 | Reason                                        | Alternatives                    | Tradeoffs                                                |
| -------------------------------------- | ------------------------------------------------------ | --------------------------------------------- | ------------------------------- | -------------------------------------------------------- |
| Feature flags for all                  | Config-based toggles                                   | Upstream-rebase safety; independent rollback  | Compile-time flags              | Slight runtime overhead from config reads (negligible)   |
| maxSteps capped at 3                   | Conservative limit                                     | Limits blast radius of lost per-step checks   | Higher cap (5-10)               | Fewer savings but safer; can increase after validation   |
| Heuristic compression for grep/glob    | Head+tail truncation                                   | Structured output compresses well without LLM | LLM for all, or no compression  | Loses some semantic info; acceptable for structured data |
| Context transfer capped at 4000 tokens | Prevent subagent context bloat                         | Subagent has own context budget               | Unlimited transfer              | May miss relevant context; subagent re-reads as needed   |
| Proactive prune at 80%                 | Balance between info retention and overflow prevention | Avoids expensive compaction LLM call          | 70% or 90% threshold            | 80% is conservative; configurable via flag               |
| Phase 4 (maxSteps) last                | Highest risk, needs Phase 1 first                      | Reduces implementation risk                   | Implement early for max savings | Delays biggest turn savings; acceptable for stability    |

---

## Risks

| Risk                                    | Impact                                     | Likelihood | Mitigation                                                                   |
| --------------------------------------- | ------------------------------------------ | ---------- | ---------------------------------------------------------------------------- |
| maxSteps exceeds context window         | Session breaks, requires manual compaction | Medium     | Token check in stream handler; cap at 3 steps; feature flag                  |
| Aggressive pruning loses needed context | Model hallucinates or re-reads files       | Low        | PRUNE_PROTECT keeps 2 recent turns; only prune beyond boundary               |
| continue_on_deny causes retry loops     | Wasted tokens on repeated denials          | Low        | Model sees deny feedback; agent.steps caps total iterations                  |
| Stale context transfer to subagent      | Subagent works with outdated file content  | Low        | Context is advisory; subagent independently verifies                         |
| Rebase conflicts on prompt.ts           | Merge conflicts during upstream sync       | Medium     | Surgical edits; avoid reformatting; keep changes minimal                     |
| SlidingWindow cache stale               | Model sees wrong context window            | Very Low   | `invalidate()` already called on all mutation paths                          |
| Parallel tool calls race condition      | Corrupted file state                       | Very Low   | `parallelGate` only allows read-only tools; FileTime semaphore guards writes |

---

## Test Plan

### Unit Tests

| Component               | Scenarios                                                                                                        | Mocks                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `parallelGate`          | Default true returns true for safe tools; returns false with unsafe tool; returns false when permission is "ask" | None (pure function)     |
| `prune(aggressive)`     | Prunes with halved PRUNE_PROTECT; respects PRUNE_PROTECTED_TOOLS; skips when flag disabled                       | MessageV2 fixture        |
| `buildContextTransfer`  | Extracts matching paths; caps at token limit; returns empty when no matches                                      | Session messages fixture |
| `noop exit`             | Breaks on empty finish; continues on finish with tool calls; continues on finish with text                       | Processor mock           |
| `compression threshold` | Skips compression below threshold; uses heuristic for grep; uses LLM for bash                                    | None                     |
| `SlidingWindow cache`   | Returns cached on same generation; recomputes on invalidate; handles concurrent access                           | MessageV2 fixture        |

### Integration Tests

| Test                                | Components                                     | Verification                                                 |
| ----------------------------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| Parallel tool calls end-to-end      | Config → parallelGate → streamText → processor | Multiple tool results in single assistant message            |
| maxSteps multi-step stream          | LLM.stream → processor → DB                    | All intermediate tool calls persisted; token limit respected |
| Proactive prune prevents compaction | runLoop → prune → SlidingWindow                | No compaction task created when prune succeeds               |
| Subagent context transfer           | task.ts → spawnSubagent → new session          | Subagent first message contains parent context               |
| continue_on_deny flow               | processor → deny → continue → next tool        | Loop continues; denied tool result in context                |

### End-to-End Tests

| Journey                              | Expected Behavior                                   | Success Criteria                       |
| ------------------------------------ | --------------------------------------------------- | -------------------------------------- |
| Read-heavy exploration (5 files)     | Model batches reads; parallel execution             | < 5 turns (vs 8-10 baseline)           |
| Feature implementation (edit + read) | Parallel reads, serial edits                        | No race conditions; correct file state |
| Long session with compaction         | Proactive prune delays compaction                   | Fewer compaction LLM calls             |
| Subagent delegation                  | Context transferred; subagent skips redundant reads | Subagent completes in fewer turns      |

### Non-Functional Tests

| Requirement                   | Target                                | Verification                                      |
| ----------------------------- | ------------------------------------- | ------------------------------------------------- |
| No regression in turn latency | < 5% increase per turn                | Benchmark before/after on standard session        |
| Token savings                 | 20-40% fewer total tokens per session | Compare token usage logs                          |
| Memory stability              | No leaks from caching                 | Run 50-iteration session; check heap              |
| Config reload                 | Flags take effect without restart     | Change config mid-session; verify behavior change |

---

## Dependency Graph

```
#2 (batch prompt) ──enhances──→ #1 (parallel_tool_calls)
#6 (maxSteps) ─────requires───→ #1 (parallel_tool_calls)
#3 (continue on deny) ─pairs──→ #9 (pre-resolve permissions)
#5 (proactive prune) ─reduces─→ compaction frequency → fewer turns
#4 (compression) ──────────────→ independent
#7 (subagent ctx) ─────────────→ independent
#8 (noop exit) ────────────────→ independent
#10 (cache SW) ────────────────→ independent
```

## Implementation Order

1. **Phase 1** (#1, #2, #3): Config/prompt only. Ship immediately.
2. **Phase 2** (#4, #8): Low-risk code. Ship after Phase 1 validation.
3. **Phase 3** (#5, #7): Medium complexity. Ship after Phase 2 stable.
4. **Phase 4** (#6): High risk. Ship behind disabled flag; enable after thorough testing.
5. **Phase 5** (#9, #10): Latency-only. Ship anytime after Phase 1.

## Expected Savings

| Scenario                        | Before      | After Phase 1-3 | After All  |
| ------------------------------- | ----------- | --------------- | ---------- |
| Simple feature (15 tool calls)  | 10-12 turns | 7-9 turns       | 5-7 turns  |
| Complex feature (30 tool calls) | 18-22 turns | 13-16 turns     | 9-13 turns |
| Read-heavy exploration          | 8-10 turns  | 5-7 turns       | 3-5 turns  |
