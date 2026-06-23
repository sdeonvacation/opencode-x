# Plan: Deep Research Workflow

## Overview

Multi-phase autonomous research orchestrator: splits a question into parallel web searches, reads top sources, extracts falsifiable facts, cross-checks each via adversarial jury (majority-reject kills a fact), then synthesizes a cited report with certainty ratings. Replaces shallow single-search answers with rigorous, multi-source, fact-checked output.

## Tech Stack

- TypeScript 5.8, Bun 1.3.11, Effect-ts 4.0.0-beta
- Vercel AI SDK `generateObject` for structured output phases
- Existing `websearch`/`webfetch` tools for search + fetch
- SQLite (drizzle-orm) for research run persistence
- No new npm dependencies (all structured output via AI SDK `generateObject` + zod schemas)

## Testing Strategy

- Unit: schema validation, URL canonicalization, jury quorum logic, fact ranking/capping, group merging
- Integration: full pipeline with mocked LLM responses (plan → search → extract → group → crosscheck → report), abort/timeout handling, budget overflow
- Done when: `/research "topic"` produces a cited report with stats, crosscheck survives edge cases (all-reject, all-abstain, empty sources), feature flag gates entire flow

## Phases

### Phase 1: Foundation — Schema, Config, Flag

- Step 1: Add `OPENCODE_EXPERIMENTAL_DEEP_RESEARCH` to `src/flag/flag.ts` using `enabledByExperimental` pattern
- Step 2: Add `deep_research` boolean to `experimental` config object in `src/config/config.ts`
- Step 3: Create `src/research/schema.ts` — zod schemas for structured output shapes (plan, hits, read, ruling, group, report) plus branded `ResearchID` type
- Step 4: Create `src/research/research.sql.ts` — `research_run` table (id, session_id, question, status, stats_json, created_at, completed_at) with session FK

### Phase 2: Core Engine — Orchestrator Logic

- Step 5: Create `src/research/tunables.ts` — exported constants (JURY_SIZE=3, REJECT_QUORUM=2, SOURCE_BUDGET=15, FACT_CAP=25) with config overrides
- Step 6: Create `src/research/url.ts` — URL canonicalization, dedup map, budget tracking (FIT_RANK sorting, slot allocation)
- Step 7: Create `src/research/prompts.ts` — prompt builders for each phase (plan, search, read, group, crosscheck, report) taking topic + context args
- Step 8: Create `src/research/jury.ts` — crosscheck logic: spawn N jurors per fact via `generateObject`, tally votes, apply quorum rules (abstention = unproven, not kept)
- Step 9: Create `src/research/engine.ts` — main orchestrator function: accepts question + session context, drives phases sequentially (plan → parallel search → extract → group → crosscheck → report), uses `generateObject` for structured LLM calls and `Promise.all`/`Promise.allSettled` for parallelism

### Phase 3: Integration — Tool + Command

- Step 10: Create `src/tool/research.ts` — `Tool.define("research", ...)` wrapping engine.ts, gated by flag, permission "research", returns formatted report + stats
- Step 11: Create `src/tool/research.txt` — tool description for agent prompt injection
- Step 12: Register tool in `src/tool/registry.ts` (additive — append to existing tool list, gated by flag check)
- Step 13: Create `src/cli/cmd/tui/command/research.ts` — `/research` slash command that shows dialog for question input, triggers tool via session prompt
- Step 14: Run migration: `bun run db generate --name deep_research`

### Phase 4: Hardening + Progress

- Step 15: Wire phase progress events via `Bus.publish` so TUI can show phase indicators (Plan → Search → Extract → Group → Crosscheck → Report)
- Step 16: Add abort signal propagation — cancel in-flight LLM calls on session abort
- Step 17: Add timeout per phase (configurable via experimental tunables) with graceful degradation (partial results on timeout)
- Step 18: Write unit tests in `test/research/` — schema parse, jury quorum, URL dedup, fact ranking
- Step 19: Write integration test — full flow with fixture LLM responses

## Risks/Edge cases

- **Token explosion**: 6 parallel searches × 15 source reads × 25 facts × 3 jurors = many LLM calls → Mitigation: honor SOURCE_BUDGET/FACT_CAP hard caps, allow config override for lower budgets, abort early if token budget approached
- **All facts rejected**: Jury kills everything → Mitigation: return "inconclusive" result with rejected facts shown for transparency
- **WebSearch permission spam**: Each search/fetch needs permission → Mitigation: batch-approve research tool with `always: ["*"]` pattern so sub-calls auto-approve after initial grant
- **Structured output failures**: Model returns malformed JSON → Mitigation: zod parse with fallback (treat as empty/skip), log warning, continue with partial data
- **Rate limits**: Many parallel generateObject calls → Mitigation: use existing `src/orchestration/concurrency.ts` acquire/release semaphore per provider
- **Large context blowup**: Research results fed back into session → Mitigation: compress final report via existing LLM-compress, store full data in research_run table, return summary to session
- **Upstream rebase safety**: All new files, single additive line in registry.ts (gated), single additive line in config schema, single additive line in flag.ts → minimal merge conflict surface
