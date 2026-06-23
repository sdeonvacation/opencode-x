# Plan: Section-Aware Budgeted Reading

## Overview

Adds two file-reading utilities — `readBudgeted` (flat truncation) and `readBudgetedSectionAware` (preserves markdown `## ` section structure) — that fit file content within a token budget. Useful for injecting memory files, checkpoint summaries, and large context documents into prompts without exceeding model limits. MiMo-Code uses these for checkpoint/memory/notes injection; OpenCode-X currently has no equivalent (PersistentMemory.inject caps by line count, not tokens).

## Tech Stack

- TypeScript 5.8, Bun runtime
- `Token.estimate` from `src/util/token.ts` (exists, chars/4 heuristic)
- `Bun.file()` for async reads
- No new dependencies

## Testing Strategy

- Unit: parse sections from synthetic markdown; verify budget adherence for both functions; edge cases (empty file, no sections, budget < headers-only)
- Integration: call with real .md file on disk via tmpdir fixture
- Done when: both functions return correct truncation under budget, section headers preserved, hint appended on truncation, 100% branch coverage

## Phases

### Phase 1: Core module

- Step 1: Create `packages/opencode/src/util/budgeted-read.ts` exporting `BudgetedReadResult` interface, `readBudgeted`, and `readBudgetedSectionAware`
- Step 2: Port logic from MiMo-Code, adapt to opencode-x style (single-word vars, no else, Bun.file)
- Step 3: Internal `parseSections` helper stays unexported (same file)

### Phase 2: Feature flag

- Step 1: Add `OPENCODE_EXPERIMENTAL_BUDGETED_READ` to `src/flag/flag.ts` using `enabledByExperimental` pattern
- Step 2: Gate any call-site behavioral changes behind this flag

### Phase 3: Integration — PersistentMemory

- Step 1: Add `injectBudgeted(budget: number)` method to `src/memory/persistent.ts` that reads the combined memory block with `readBudgetedSectionAware` semantics (build combined text, apply section-aware truncation)
- Step 2: In `src/session/prompt.ts` at line ~2034, when flag enabled, call `PersistentMemory.injectBudgeted(cfg.experimental?.persistent_memory_budget ?? 8000)` instead of `inject()`
- Step 3: Keep `inject()` unchanged as fallback when flag disabled

### Phase 4: Integration — Tool output reads (optional)

- Step 1: Expose `readBudgeted` for use in tool output injection (e.g. large file reads that feed into prompt context)
- Step 2: Wire into `applyToolBudget` or new callers as needed — additive, no signature changes

### Phase 5: Tests

- Step 1: Create `packages/opencode/test/util/budgeted-read.test.ts`
- Step 2: Tests: under-budget returns full text; over-budget truncates at newline boundary; section-aware preserves all headers; skeleton mode when headers exceed budget; hint format correct
- Step 3: Test `injectBudgeted` path with fixture memory files

## Risks/Edge cases

- **Token estimate drift**: `chars/4` is approximate; real tokenizers vary. Mitigation: 0.95 safety multiplier already in logic, matches existing `Token.estimate` usage across codebase
- **No sections in file**: Falls through to flat `readBudgeted` behavior (preamble fills budget). Mitigation: test this path explicitly
- **Empty/missing file**: Returns `undefined`, callers already null-check. No change needed
- **Provider cache invalidation**: New `injectBudgeted` produces different text than `inject()` — gated by flag so no impact until opted in. Dynamic prompt section (not cached prefix) so no cache breakage
- **Large persistent memory dir**: `PersistentMemory.list()` already caps at 200 files / 500 lines; budgeted read adds token cap on top — strictly tighter, no perf concern
- **Upstream rebase safety**: All additive — new file, new flag, new method, conditional call-site. No existing signatures modified
