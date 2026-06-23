# Plan: Max Mode (Best-of-N Reasoning)

## Overview

Max Mode generates N parallel propose-only LLM candidates for each step, uses a judge call to pick the best one, then replays the winner through the normal processor for execution. This yields higher-quality reasoning at ~Nx cost by selecting the best draw from multiple independent completions, significantly reducing errors on hard steps.

## Tech Stack

- TypeScript 5.8, Bun 1.3.11
- Effect-ts 4.0.0-beta (Effect.all with concurrency, Effect.gen, Stream)
- Vercel AI SDK 6.x (streamText, schema-only tools via stripped `execute`)
- No new npm dependencies

## Testing Strategy

- Unit: `parseJudgeIndex` edge cases, `toSchemaOnlyTools` strips execute, candidate accumulator, overhead aggregation math
- Integration: full `runMaxStep` with mock LLM stream (verify N candidates spawned, judge picks correctly, winner replayed, fallback on all-fail)
- Done when: max-mode produces correct output with 5 candidates, degrades to single process on total failure, overhead cost tracked separately from context tokens, feature-flag gates activation

## Phases

### Phase 1: Config & Flag

- Step 1: Add `max_mode` field to `experimental` config schema in `config.ts` — `z.boolean().optional().describe("Enable best-of-N reasoning for primary agent steps")`
- Step 2: Add `max_mode_candidates` field — `z.number().int().min(2).max(10).optional().describe("Number of parallel candidates (default: 5)")`
- Step 3: Add `OPENCODE_EXPERIMENTAL_MAX_MODE` env flag in `src/flag/flag.ts` using `enabledByExperimental` pattern

### Phase 2: Core Module — `src/session/max-mode.ts`

- Step 1: Create `src/session/max-mode.ts` with namespace `MaxMode`
- Step 2: Define `Candidate` type: `{ index, reasoning, reasoningMetadata?, text, textMetadata?, toolCalls: ProposedToolCall[], finishReason, usage?, providerMetadata? }`
- Step 3: Define `ProposedToolCall` type: `{ toolCallId, toolName, input, providerMetadata? }`
- Step 4: Implement `toSchemaOnlyTools(tools)` — strips `execute` from each tool, forcing propose-only behavior
- Step 5: Implement `runCandidate(input, index)` — streams a single candidate via `llm.stream` with schema-only tools, accumulates reasoning/text/toolCalls, returns `Candidate | null`. Retry transient errors using `SessionRetry.policy` pattern. Catch all failures → return null
- Step 6: Implement `renderCandidate(c, label)` — compact text rendering for judge prompt
- Step 7: Define `JUDGE_SYSTEM` — system prompt instructing judge to pick best candidate index
- Step 8: Implement `parseJudgeIndex(out, count)` — extract integer from judge reply, fallback to 0
- Step 9: Implement `judge(input, candidates)` — stream judge call with `toolChoice: "none"`, parse reply, return `{ pick, usage }`
- Step 10: Implement `runMaxStep(input)` — orchestrator: spawn N candidates via `Effect.all(..., { concurrency: n })`, filter nulls, fallback if 0 survivors, judge, compute overhead, return winner data for replay

### Phase 3: Processor Integration — `replay` method

- Step 1: Extend `SessionProcessor.Handle` interface with `replay(input: ReplayInput) => Effect.Effect<Result>` in `processor.ts`
- Step 2: Define `ReplayInput` type: `{ reasoning, reasoningMetadata?, text, textMetadata?, toolCalls, finishReason, usage?, providerMetadata?, tools, messages, selection: { winner, total }, thinkingMs, overhead: { cost, tokensIn, tokensOut } }`
- Step 3: Implement `replay` inside the processor `create` closure — synthesize LLM events from winner data, feed them through existing `handleEvent` pipeline, execute tool calls via real tools, return Result. Reuse existing stream event handler so tool execution, part creation, and doom-loop detection remain consistent
- Step 4: Track `overhead` on the assistant message metadata — ensures billing reflects true Nx spend while context tokens only reflect winner

### Phase 4: Run-Loop Integration

- Step 1: In `src/session/prompt.ts`, before `handle.process(...)` call site (~line 2075), add conditional: if max_mode enabled AND agent is primary AND format is not json_schema → call `MaxMode.runMaxStep(...)` instead
- Step 2: Pass `setStatus` callback that publishes `SessionStatus.Event.Status` with a custom message during candidate/judge phases
- Step 3: Wire `MaxStepInput` from existing scope vars: handle, llm, user, agent, model, sessionID, parentSessionID, permission, system, messages, tools

### Phase 5: Overhead Tracking

- Step 1: Extend `MessageV2.Assistant` metadata to include optional `max_mode?: { winner: number, total: number, thinkingMs: number, overhead: { cost: number, tokensIn: number, tokensOut: number } }`
- Step 2: In `Session.getUsage` and `Usage.aggregate`, include overhead cost in session total cost but NOT in context token counts
- Step 3: Ensure TUI/SDK surfaces overhead as separate line item (additive, no schema breaks)

### Phase 6: Tests

- Step 1: Create `test/session/max-mode.test.ts` — unit tests for `parseJudgeIndex`, `toSchemaOnlyTools`, overhead aggregation
- Step 2: Integration test: mock LLM stream returning known candidates, verify judge selects correctly, verify replay invokes tools
- Step 3: Integration test: all candidates fail → verify fallback to `handle.process`
- Step 4: Integration test: feature flag off → verify normal path taken

## Risks/Edge cases

- **All candidates fail**: Mitigated by fallback to single `handle.process` — never blocks the step
- **Judge returns garbage**: `parseJudgeIndex` defaults to candidate 0 (first survivor) — safe degradation
- **Token cost explosion**: Overhead tracked separately so context estimators don't trigger premature compaction; user sees true cost in usage
- **Replay tool execution failure**: Uses same error-handling/retry path as normal processor — no new failure modes
- **Race with compaction**: Max-mode candidates are stateless (propose-only) — no side effects until replay, so compaction mid-ensemble is safe; messages array is captured before candidates start
- **Provider rate limits**: N concurrent streams may hit rate limits — `SessionRetry` policy handles backoff per candidate independently; worst case some candidates fail (→ fewer survivors, still works)
- **Upstream rebase safety**: All changes additive — new file `max-mode.ts`, new optional interface method `replay`, new optional config fields, conditional branch in prompt.ts guarded by flag
