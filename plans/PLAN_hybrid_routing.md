# Plan: Hybrid Routing v1 (Cloud-Default, Cost-Aware)

## Overview

Add intelligent local/cloud LLM routing to opencode. Cloud is the default brain for risky/important work. Local models handle cheap, high-frequency operations (read, search, simple bash). A lightweight preflight classifier determines operation type and confidence before each turn, then a deterministic policy routes to the correct model. All behavior gated behind `experimental.hybrid_routing.enabled` (default `false`). Flag off = zero behavior change.

## Tech Stack

- TypeScript 5.8, Bun 1.3.11
- Effect 4.0 (service/layer patterns, Effect.fn)
- Zod for config schema extensions
- Vercel AI SDK `generateObject` for non-streaming preflight
- Existing Bus (typed pub/sub) for telemetry events
- Existing Provider service for model resolution
- bun:test for unit tests

## Testing Strategy

- **Unit**: Each new module gets dedicated test file (`test/orchestration/hybrid-*.test.ts`, `test/orchestration/verify.test.ts`)
- **Integration**: Primary prompt path flag-on/flag-off, task routing consistency, verification command behavior
- **Done when**: All new tests pass, `bun typecheck` clean, flag-off path produces identical behavior to current codebase

## Phases

### Phase 1: Config Schema + Types (foundation, no behavior change)

- Step 1: Add `experimental.hybrid_routing` object to config schema in `src/config/config.ts` with fields: `enabled`, `threshold`, `preflight_model`, `local_models`, `verify_commands`, `verify_cache_ttl_ms`
- Step 2: Create `src/orchestration/hybrid-types.ts` — shared type definitions: `PreflightInput`, `PreflightResult`, `RouteDecision`, `OverrideReason`, `InvocationType`, `OperationType`
- Step 3: Validate config parses cleanly with new fields, flag defaults to `false`

### Phase 2: Bash Heuristics + Preflight Classifier

- Step 1: Create `src/orchestration/hybrid-heuristics.ts` — regex-based bash classification: complex pattern `/(npm|yarn|pnpm|bun|docker|gradle|mvn|build|deploy|test)\b/i`, simple pattern `/(echo|pwd|whoami|env)\b/i`. Heuristics override upward only (simple→complex, never complex→simple)
- Step 2: Create `src/orchestration/hybrid-preflight.ts` — structured non-streaming model call via `generateObject`. Input: prompt, agent, `invocation_type`, `command_string`, parts summary, selected model. Output: `confidence`, `info_gap`, `needs_code_change`, `operation_type`, `assumptions`, `ask_candidates`
- Step 3: Implement preflight model fallback chain: configured `preflight_model` → first `local_models` entry → base model non-streaming. Log which fallback used
- Step 4: When `invocation_type === "command"`, trust `command_string` heavily for `operation_type` before LLM call
- Step 5: Add tests: `test/orchestration/hybrid-heuristics.test.ts`, `test/orchestration/hybrid-preflight.test.ts`

### Phase 3: Deterministic Router + Ask Formatter

- Step 1: Create `src/orchestration/hybrid-router.ts` — accepts base model, local model list, preflight result, explicit user-selected model flag. Returns `RouteDecision` with chosen model, route, override metadata
- Step 2: Implement policy order: (1) `info_gap=high → ask`, (2) `code_change → cloud`, (3) `read/bash_simple → local`, (4) `bash_complex → cloud`, (5) other ops + `confidence < threshold → cloud`, (6) else `local`. Confidence ignored for read/bash_simple
- Step 3: If routed model differs from explicit user-selected model: set `was_overridden=true`, `override_reason` from enum (`code_change | low_confidence | policy_bash_complex | info_gap | preflight_unavailable`)
- Step 4: Create ask formatter helper — fixed output format: `I need more information to proceed:\n\n- Missing: <X>\n- Options:\n  1) ...\n  2) ...\n\nPlease clarify.` Populate from `ask_candidates` when present, else list missing info
- Step 5: Add tests: `test/orchestration/hybrid-router.test.ts` — cover all 6 policy branches, override reasons, ask formatting

### Phase 4: Primary Prompt Integration

- Step 1: Add routing hook in `src/session/prompt.ts` before `createUserMessage` call (~line 943-960). Gate behind `experimental.hybrid_routing.enabled`
- Step 2: Build preflight input from: text parts, agent name, invocation type (detect from call path: `prompt` → `"chat"`, `command` → `"command"`, `shell` → `"tool"`), command string if available
- Step 3: If route = `ask`: create assistant message with fixed-format clarification text, skip model loop, return early
- Step 4: If route = `local` or `cloud`: stamp routed model onto user message, continue existing loop
- Step 5: If route = `local` and assumptions exist: prepend synthetic text part `Assuming:\n- ...\n- ...` to assistant output
- Step 6: Flag off: existing `input.model ?? ag.model ?? lastModel(...)` unchanged
- Step 7: Add tests: `test/session/hybrid-prompt.test.ts` — flag-off legacy, flag-on ask path, routed model persisted, assumptions surfaced

### Phase 5: Subagent Integration

- Step 1: Add routing hook in `src/tool/task.ts` after existing `resolveTaskModel` call (~line 100-108). Gate behind flag
- Step 2: Flag-on precedence: (1) ultrawork explicit/keyword, (2) hybrid router for all subagents with no subagent-specific overrides, (3) fallback model
- Step 3: Keep category mapping outside hybrid router — existing `resolveTaskModel` stays as upstream fallback only when flag off
- Step 4: Flag off: current `resolveTaskModel(...)` unchanged
- Step 5: Add tests in `test/tool/task.test.ts` or new file — ultrawork wins, all subagents use same hybrid routing policy, fallback path

### Phase 6: Verification Runner

- Step 1: Create `src/orchestration/verify.ts` — triggered only when `operation_type === "code_change"` and flag on
- Step 2: Configured commands first (`verify_commands` from config): spawn process, capture exit code
- Step 3: Distinguish failure modes: process fails to start (command missing) → fallback to LLM verification. Process runs and exits non-zero → verification failed, NO fallback
- Step 4: If no commands configured: cached autodetect. Key by repo root + lockfile/package file mtimes. Respect `verify_cache_ttl_ms`. Detect available scripts/tools once per TTL
- Step 5: If no commands available after autodetect: LLM verification. If LLM confidence < 0.6 → mark unverified + warn. Never silently pass
- Step 6: Add tests: `test/orchestration/verify.test.ts` — command missing fallback, command run-fail no fallback, LLM low confidence warning, autodetect cache hit/miss

### Phase 7: Telemetry + Observability

- Step 1: Add `orchestration.route` event in `src/orchestration/events.ts` with fields: `route`, `operation_type`, `confidence`, `info_gap`, `needs_code_change`, `assumptions_count`, `verification_used`, `success`, `was_overridden`, `override_reason`, `preflight_fallback`
- Step 2: Emit event from primary prompt path and subagent path after route decision. Only when flag on
- Step 3: Add route metadata to `experimental_telemetry.metadata` in `src/session/llm.ts` when available (additive only)
- Step 4: Add tests: telemetry event emitted with correct fields, not emitted when flag off

## Risks

| Risk                                                      | Mitigation                                                                    |
| --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Local preflight misclassifies bash_simple vs bash_complex | Regex heuristics run first, LLM refines only when heuristic not decisive      |
| Preflight model unavailable                               | 3-level fallback chain: configured → first local → cloud non-streaming        |
| User confused by silent model override                    | `was_overridden` + `override_reason` in telemetry; debug text in v2           |
| Verification command crashes vs missing conflated         | Explicit distinction: missing → LLM fallback; crash → hard fail               |
| Flag-on regression in existing flows                      | Flag-off tests prove zero behavior change; flag-on tests prove new behavior   |
| Upstream rebase conflict on `prompt.ts` or `task.ts`      | Minimal surgical edits (~10 lines each), gated behind early-return flag check |
| Ask path format drift                                     | Fixed template enforced by formatter, tested                                  |
| Category routing confusion with hybrid router             | Category mapping kept outside hybrid layer entirely                           |
