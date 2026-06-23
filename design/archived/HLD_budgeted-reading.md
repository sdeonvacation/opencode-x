# HLD: Section-Aware Budgeted Reading

## Summary

Adds two pure utility functions — `readBudgeted` (flat token-capped truncation) and `readBudgetedSectionAware` (preserves markdown `##` section structure within budget) — for fitting file content into token budgets. Integrates with `PersistentMemory` to replace line-count capping with token-aware section-preserving injection, gated behind a feature flag.

## Architecture Diagram

```
┌──────────────────────────────────────────────────────────┐
│                    session/prompt.ts                       │
│                                                           │
│  ┌─────────────────┐     ┌────────────────────────────┐  │
│  │ PersistentMemory │────▶│ Flag: BUDGETED_READ        │  │
│  │   .inject()      │     │  enabled? ──┐              │  │
│  └─────────────────┘     └─────────────┼──────────────┘  │
│                                         │                  │
│                          ┌──────────────▼───────────────┐ │
│                          │ PersistentMemory              │ │
│                          │   .injectBudgeted(budget)     │ │
│                          └──────────────┬───────────────┘ │
└─────────────────────────────────────────┼─────────────────┘
                                          │
                           ┌──────────────▼───────────────┐
                           │   util/budgeted-read.ts       │
                           │                               │
                           │  readBudgeted(text, budget)    │
                           │  readBudgetedSectionAware(    │
                           │    text, budget)               │
                           │                               │
                           │  ┌─────────────────────────┐  │
                           │  │ parseSections (internal) │  │
                           │  └─────────────────────────┘  │
                           │                               │
                           │  uses: Token.estimate()       │
                           └───────────────────────────────┘
                                          │
                           ┌──────────────▼───────────────┐
                           │     util/token.ts             │
                           │     Token.estimate(str)       │
                           │     (chars/4 heuristic)       │
                           └───────────────────────────────┘
```

## Components

### Component 1: BudgetedRead module

- **File**: `src/util/budgeted-read.ts`
- **Type**: Pure Module (no services, no Effect, no DB)
- **Exports**: `BudgetedRead` namespace with `Result`, `read`, `readSectionAware`
- **Dependencies**: `Token` from `../util/token`
- **Interface**:

  ```typescript
  export namespace BudgetedRead {
    export type Result = {
      content: string
      truncated: boolean
      sections?: number // total sections found (section-aware only)
      included?: number // sections included in output
    }

    /** Flat truncation at newline boundary within token budget */
    export function read(text: string, budget: number): Result

    /** Section-aware truncation preserving ## headers */
    export function readSectionAware(text: string, budget: number): Result
  }
  ```

### Component 2: Feature Flag

- **File**: `src/flag/flag.ts`
- **Type**: Flag constant
- **Exports**: `Flag.OPENCODE_EXPERIMENTAL_BUDGETED_READ`
- **Dependencies**: None (reads `process.env`)
- **Interface**:
  ```typescript
  // Inside Flag namespace
  export const OPENCODE_EXPERIMENTAL_BUDGETED_READ: boolean
  // Uses enabledByExperimental pattern — on when OPENCODE_EXPERIMENTAL=true
  // or OPENCODE_EXPERIMENTAL_BUDGETED_READ=true
  ```

### Component 3: Config Schema Extension

- **File**: `src/config/config.ts`
- **Type**: Schema (zod within existing experimental object)
- **Exports**: Adds to `Config.Info["experimental"]`
- **Dependencies**: Existing config schema
- **Interface**:
  ```typescript
  // Added inside experimental z.object({...})
  budgeted_read: z.boolean().optional()
    .describe("Use token-budgeted section-aware reading for persistent memory injection"),
  persistent_memory_budget: z.number().int().positive().optional()
    .describe("Token budget for persistent memory injection (default: 8000)"),
  ```

### Component 4: PersistentMemory Extension

- **File**: `src/memory/persistent.ts`
- **Type**: Pure Module (namespace with new method)
- **Exports**: `PersistentMemory.injectBudgeted`
- **Dependencies**: `BudgetedRead`, `Token`, `Flag`
- **Interface**:
  ```typescript
  // Inside PersistentMemory namespace
  export function injectBudgeted(opts?: { project?: string; budget?: number }): string
  ```

### Component 5: Prompt Integration

- **File**: `src/session/prompt.ts`
- **Type**: Integration point (conditional call-site)
- **Exports**: None (modifies existing behavior)
- **Dependencies**: `PersistentMemory`, `Flag`, `Config`
- **Interface**: No new exports. Existing `persistent_memory` block at ~line 2034 gains conditional branch.

## Data Flow

### Main Flow: Budgeted Persistent Memory Injection

| Step | Component                           | Action                                                                                 | Next          |
| ---- | ----------------------------------- | -------------------------------------------------------------------------------------- | ------------- |
| 1    | `prompt.ts`                         | Check `cfg.experimental?.budgeted_read` and `Flag.OPENCODE_EXPERIMENTAL_BUDGETED_READ` | 2 or fallback |
| 2    | `PersistentMemory.injectBudgeted()` | Call `list()` to get entries, build combined text block                                | 3             |
| 3    | `BudgetedRead.readSectionAware()`   | Parse text into sections, fit within budget                                            | 4             |
| 4    | `prompt.ts`                         | Push result string into `system[]` array                                               | done          |

### Internal Flow: readSectionAware

| Step | Action                 | Detail                                                                  |
| ---- | ---------------------- | ----------------------------------------------------------------------- |
| 1    | Parse sections         | Split on `## ` boundaries, track preamble                               |
| 2    | Calculate header costs | Sum token estimate of all `## ` lines                                   |
| 3    | Budget check           | If headers alone exceed budget → skeleton mode (truncated headers only) |
| 4    | Distribute budget      | Remaining budget after headers → fill section bodies in order           |
| 5    | Flat truncate bodies   | Each body truncated at newline boundary if over per-section share       |
| 6    | Assemble output        | Join headers + truncated bodies, append `[truncated]` hint if any cut   |
| 7    | Return Result          | `{ content, truncated, sections, included }`                            |

### Fallback Flow

When flag disabled: existing `PersistentMemory.inject()` runs unchanged (line-count cap at 500 lines).

## Database Schema

No database changes. This feature operates on filesystem files (persistent memory `.md` files in `~/.local/share/opencode/memory/`) and in-memory string processing.

## Configuration

Added to `experimental` object in config schema:

```typescript
// src/config/config.ts — inside experimental z.object({...})
budgeted_read: z.boolean().optional()
  .describe("Use token-budgeted section-aware reading for persistent memory injection"),
persistent_memory_budget: z.number().int().positive().optional()
  .describe("Token budget for persistent memory injection (default: 8000)"),
```

**Defaults**:

- `budgeted_read`: `undefined` (off unless flag or config enables)
- `persistent_memory_budget`: `8000` tokens (~32K chars)

**Resolution order**: `cfg.experimental?.budgeted_read ?? Flag.OPENCODE_EXPERIMENTAL_BUDGETED_READ`

## Feature Flag

- **Name**: `OPENCODE_EXPERIMENTAL_BUDGETED_READ`
- **Env var**: `OPENCODE_EXPERIMENTAL_BUDGETED_READ=true` or via umbrella `OPENCODE_EXPERIMENTAL=true`
- **Pattern**: `enabledByExperimental("OPENCODE_EXPERIMENTAL_BUDGETED_READ")`
- **Gating behavior**: When disabled, all code paths remain unchanged. When enabled, `prompt.ts` calls `injectBudgeted()` instead of `inject()`.

## Integration Points

| File                           | Function/Location                 | How                                                                                                                                                 |
| ------------------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/session/prompt.ts` ~L2034 | Persistent memory injection block | Add `if` branch: when budgeted_read enabled, call `PersistentMemory.injectBudgeted({ budget: cfg.experimental?.persistent_memory_budget ?? 8000 })` |
| `src/memory/persistent.ts`     | New `injectBudgeted()` method     | Builds combined text from `list()`, applies `BudgetedRead.readSectionAware()`                                                                       |
| `src/flag/flag.ts` ~L86        | Experimental flags section        | Add `OPENCODE_EXPERIMENTAL_BUDGETED_READ` using `enabledByExperimental`                                                                             |
| `src/config/config.ts` ~L1659  | After `persistent_memory` field   | Add `budgeted_read` and `persistent_memory_budget` fields                                                                                           |

## Error Handling

| Scenario                    | Behavior                                                                    | Fallback                                  |
| --------------------------- | --------------------------------------------------------------------------- | ----------------------------------------- |
| Empty/missing memory dir    | `list()` returns `[]`, `injectBudgeted` returns `""`                        | Same as `inject()`                        |
| Budget < 1                  | Return `{ content: "", truncated: true, sections: N, included: 0 }`         | Caller gets empty string, no crash        |
| No `##` sections in text    | `readSectionAware` treats entire text as preamble, falls to flat truncation | Graceful degradation                      |
| File read error in `list()` | Existing `try/catch` in `parse()` returns `undefined`, file skipped         | No change                                 |
| Token estimate inaccuracy   | 0.95 safety multiplier applied to budget internally                         | Slight under-fill preferred over overflow |

## Constraints

- **Upstream-rebase safe**: All changes additive — new file (`budgeted-read.ts`), new flag, new config fields, new method, conditional branch in prompt. No existing function signatures or return types modified.
- **Provider cache**: Persistent memory is injected into a dynamic system prompt section (not cached prefix). Budgeted output differs from line-count output only when flag enabled. No cache invalidation risk for existing users.
- **Performance**: `parseSections` is O(n) string split + O(sections) token estimates. For typical memory files (<50KB combined), completes in <1ms. No async I/O added beyond existing `list()`.

## Decisions

| Decision                    | Choice                                   | Reason                                                                         | Alternatives            | Tradeoffs                                         |
| --------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------ | ----------------------- | ------------------------------------------------- |
| Pure module, no Effect      | Namespace with plain functions           | No services needed, no async beyond existing `list()`, matches `Token` pattern | Effect.fn wrapper       | Simpler, zero overhead, easier to test            |
| Chars/4 heuristic           | Reuse `Token.estimate`                   | Already used across codebase, consistent behavior                              | tiktoken/real tokenizer | Approximate but fast, 0.95 multiplier compensates |
| Safety multiplier 0.95      | Applied inside `read`/`readSectionAware` | Prevents over-budget from estimate drift                                       | Exact tokenization      | Minor under-fill vs dependency cost               |
| Newline-boundary truncation | Truncate at last `\n` before budget      | Avoids mid-word/mid-line cuts                                                  | Character-exact cut     | Wastes at most one line of budget                 |
| Config + flag dual gate     | Either config or env enables             | Matches goal_system pattern, flexible for users                                | Config only             | Slight complexity, but standard pattern           |

## Risks

| Risk                                          | Impact                                       | Likelihood | Mitigation                                                                                 |
| --------------------------------------------- | -------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------ |
| Token estimate drift                          | Content slightly over/under real token limit | Med        | 0.95 safety multiplier; same risk as all existing `Token.estimate` usage                   |
| Large combined memory text                    | Slow `parseSections` on huge inputs          | Low        | `list()` already caps at 200 files / 500 lines; budget truncates early                     |
| Section-aware cuts useful context             | Important content in later sections dropped  | Low        | Sections ordered by recency (newest entries first from `list()`); user can increase budget |
| Flag interaction with persistent_memory=false | Both flags affect same code path             | Low        | Check `persistent_memory !== false` first (existing gate), then budgeted_read inside       |

## Test Plan

### Unit Tests

**File**: `test/util/budgeted-read.test.ts`

| Scenario                      | Input                                       | Expected                                           |
| ----------------------------- | ------------------------------------------- | -------------------------------------------------- |
| Under budget — full text      | 100-char text, budget=1000                  | `{ content: full, truncated: false }`              |
| Over budget — flat truncation | 10000-char text, budget=100                 | Truncated at newline ≤400 chars, `truncated: true` |
| Section-aware — all fit       | 3 sections totaling 500 tokens, budget=1000 | All sections preserved, `truncated: false`         |
| Section-aware — partial       | 5 sections, budget fits 3                   | First 3 sections complete, `[truncated]` hint      |
| Skeleton mode                 | Headers alone exceed budget                 | Truncated header list only                         |
| No sections                   | Plain text (no `## `)                       | Falls to flat truncation                           |
| Empty text                    | `""`                                        | `{ content: "", truncated: false }`                |
| Budget zero                   | Any text, budget=0                          | `{ content: "", truncated: true }`                 |
| Single section                | One `## ` header + body                     | Works correctly                                    |
| Preamble before first section | Text before first `## `                     | Preamble included in budget                        |

### Integration Tests

**File**: `test/memory/persistent-budgeted.test.ts`

| Scenario                                    | What                                                               |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `injectBudgeted` with fixture memory files  | Create tmpdir with .md memory files, verify output respects budget |
| `injectBudgeted` returns `""` for empty dir | No crash on missing/empty memory                                   |
| Budget smaller than single entry            | Truncates gracefully, includes `[truncated]`                       |
| Project filter works                        | Only matching project entries included                             |

### Non-Functional

- **Performance**: `readSectionAware` on 50KB input completes <5ms (verify in test with `performance.now()`)
- **No regressions**: Existing `inject()` behavior unchanged when flag disabled
- **Branch coverage**: All `if` branches in `readSectionAware` hit (skeleton mode, partial, full, no-sections)
