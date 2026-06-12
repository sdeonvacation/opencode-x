# Plan: Goal Judge Independence

## Overview

Port MiMo-Code's independent judge model that validates goal completion. Currently, OpenCode-X trusts the working agent to self-report via `goal_complete` tool — inherently optimistic. The judge is a separate model call that reads the transcript cold and issues a structured verdict (`ok`, `impossible`, `reason`), preventing premature goal completion and enabling automatic re-entry when the judge says "not done yet."

## Tech Stack

- TypeScript 5.8 + Effect-ts 4.0.0-beta (Service/Layer pattern)
- Vercel AI SDK (`generateObject` / `streamObject`) for structured judge output
- Zod schema for `Verdict` type
- SQLite (drizzle) for verdict history (optional, phase 2)
- Existing: `Provider.Service`, `Auth.Service`, `Config.Service`, `Bus.Service`, `MessageV2.toModelMessagesEffect`

## Testing Strategy

- Unit: `Verdict` schema parsing, judge prompt assembly, `GoalJudge.evaluate` with mocked model response
- Integration: goal-complete tool → judge intercept → re-entry flow; impossible verdict → pause
- Done when: `goal_complete` tool invocation triggers judge evaluation, agent re-enters on `ok: false`, goal pauses on `impossible: true`, all gated behind `goal_judge` flag

## Phases

### Phase 1: Judge Service + Verdict Schema

- Step 1: Create `src/goal/verdict.ts` — export `Verdict` zod schema (`{ ok, impossible?, reason }`) and TypeScript type
- Step 2: Create `src/goal/judge.ts` — Effect Service with `evaluate` method accepting `{ condition, msgs, model }`, returning `Verdict`. Uses `Provider.Service` to resolve model, `MessageV2.toModelMessagesEffect` to build transcript, `generateObject`/`streamObject` for structured output. System prompt from MiMo-Code (cold evaluator, quote evidence, independent impossibility check)
- Step 3: Add `goal_judge` flag to `src/config/config.ts` experimental section (`z.boolean().optional()`) and env flag `OPENCODE_EXPERIMENTAL_GOAL_JUDGE` in `src/flag/flag.ts`
- Step 4: Add optional `goal_judge_model` to config experimental section (`{ providerID, modelID }`) — defaults to session's current model if unset

### Phase 2: Wire Judge into Goal Complete Flow

- Step 1: Create `src/goal/judge-gate.ts` — wraps existing `Goal.complete` with judge check. When `goal_judge` enabled: call `GoalJudge.evaluate`, if `ok: true` → proceed with `Goal.complete`, if `ok: false` → return rejection result (agent told to continue), if `impossible: true` → `Goal.pause` with reason
- Step 2: Modify `src/tool/goal-complete.ts` — when flag enabled, call judge-gate instead of direct `Goal.complete`. On rejection, return tool output instructing agent to keep working (include judge's `reason`)
- Step 3: Add `react` counter to goal (new column `react_count` in `goal.sql.ts`, default 0). Increment on each judge rejection. Cap at configurable max (default 5) — auto-complete on cap exceeded

### Phase 3: Bus Events + TUI Integration

- Step 1: Define `BusEvent` in `src/goal/judge.ts` — `goal.judge.verdict` event with `{ sessionID, verdict, attempt, messageID? }`
- Step 2: Publish verdict event after each judge call so TUI can display judge status
- Step 3: Add `goal.judge.error` event for when judge model call fails (fallback: treat as `ok: true` to avoid blocking)

### Phase 4: Migration + Config Wiring

- Step 1: Generate migration adding `react_count INTEGER NOT NULL DEFAULT 0` to goal table
- Step 2: Wire `GoalJudge` layer into session runtime (provide alongside existing `Provider.Service`, `Auth.Service`, `Config.Service`)
- Step 3: Document config options in schema descriptions

## Risks/Edge cases

- **Judge model failure**: Mitigation — on error, default to `ok: true` (don't block agent), emit error event, log warning
- **Infinite rejection loop**: Mitigation — `react_count` cap (default 5); after max re-entries, auto-complete with "max attempts reached" evidence
- **Token cost doubling**: Mitigation — judge sees full transcript; config `goal_judge_model` allows routing to cheaper/faster model (e.g. gpt-4o-mini)
- **Rebase safety**: All new files; only `goal-complete.ts` gets a conditional branch (flag-gated, additive). Config schema addition is append-only
- **Large transcripts**: Mitigation — judge uses same model message conversion as main loop; already handles token limits via provider constraints
