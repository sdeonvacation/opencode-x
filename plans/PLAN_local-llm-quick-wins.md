# Plan: Local LLM Quick Wins

## Overview

Extend hybrid routing to offload 4 non-reasoning LLM tasks to the configured `hybrid.cheap_model`: session title generation, conversation compaction, summary agent, and webfetch/websearch output compression. Each change is ≤10 lines on existing files, config-gated by `hybrid.enabled`, and falls back to current behavior when no local model is configured.

## Tech Stack

- TypeScript 5.8, Bun 1.3.11
- Effect 4.0 (Effect.fn, services)
- Existing hybrid routing infrastructure (`route-classifier.ts`, `llm-compress.ts`)
- Existing `getSmallModel()` fallback chain in `provider.ts`
- bun:test for unit tests

## Testing Strategy

- **Unit**: Extend `test/session/route-classifier.test.ts` for new shouldCompress entries; add title/compaction model resolution tests
- **Integration**: Verify title generation uses local model when hybrid enabled; verify compaction uses local model; verify webfetch output gets compressed
- **Done when**: All existing tests pass, new tests pass, `bun typecheck` clean, no behavioral change when `hybrid.enabled = false`

## Phases

### Phase 1: Title Generation → Local Model

- Step 1: In `src/session/prompt.ts` `ensureTitle()` (~line 168), add local model resolution before `getSmallModel` fallback — check `cfg.hybrid?.enabled` + `cfg.hybrid?.cheap_model`, resolve via `Provider.getModel()`, fall through to existing chain on failure
- Step 2: Read config once at top of `ensureTitle` via `Config.get()` (already available in scope via `config` service)
- Step 3: Add test in `test/session/prompt.test.ts` verifying local model is selected when hybrid config present

**Touch points**: `src/session/prompt.ts` (~5 lines added to model resolution block)

### Phase 2: Compaction → Local Model

- Step 1: In `src/session/compaction.ts` (~line 182), extend model resolution to check `cfg.hybrid?.enabled` + `cfg.hybrid?.cheap_model` before falling back to user message model
- Step 2: Resolution chain becomes: agent.model → hybrid.cheap_model → user message model
- Step 3: Add test verifying compaction selects local model when hybrid enabled

**Touch points**: `src/session/compaction.ts` (~6 lines added to model resolution block)

### Phase 3: Summary Agent → Local Model

- Step 1: In `src/session/prompt.ts` `complete()` (~line 974), extend model resolution to check hybrid local model when `input.small !== false`
- Step 2: Resolution chain becomes: input.model → hybrid.cheap_model (if small) → getSmallModel → base model
- Step 3: Add test verifying complete() with small=true selects local model when hybrid enabled

**Touch points**: `src/session/prompt.ts` (~5 lines added to model resolution in `complete()`)

### Phase 4: WebFetch/WebSearch Output Compression

- Step 1: In `src/session/route-classifier.ts` `shouldCompress()` (~line 315), add `webfetch` and `websearch` entries with appropriate line thresholds
- Step 2: In `templateFor()` (~line 307), add `webfetch → "summarize"` and `websearch → "extract"` mappings
- Step 3: In `complexityClassify()` (~line 100), add `webfetch`/`websearch` to the SPLIT or LOCAL_ONLY category so they participate in routing decisions
- Step 4: Add tests for new shouldCompress/templateFor entries

**Touch points**: `src/session/route-classifier.ts` (~8 lines across 3 functions)

## Risks

| Risk                                                                  | Mitigation                                                                                                     |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Local model unavailable at title/compaction time                      | Fall through to existing chain — identical behavior to hybrid disabled                                         |
| Local model produces bad titles                                       | Title is ≤50 chars, heavily constrained by prompt template; truncated anyway                                   |
| Local model produces bad compaction summaries                         | Compaction has structured template (Goal/Instructions/Discoveries/etc.) that constrains output                 |
| WebFetch compression loses important content                          | Compression system prompt enforces lossless extraction; validation rejects expansion; original used on failure |
| Config coupling — all 4 features tied to single `hybrid.enabled` flag | Intentional: single toggle for all local model offloading; per-feature flags would add config bloat            |
| Rebase conflicts on prompt.ts                                         | Changes are in model resolution blocks only (3-5 lines each), not in hot message processing paths              |
