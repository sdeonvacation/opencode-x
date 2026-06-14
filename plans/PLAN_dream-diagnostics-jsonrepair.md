# Plan: /dream Memory Consolidation + Wire Diagnostics + Tool Call JSON Repair

## Overview

Three independent fork-only additions: (1) `/dream` slash command for AI-driven memory deduplication, (2) runtime wire diagnostics for request profiling, (3) robust streaming tool call JSON repair for non-standard providers.

## Tech Stack

- TypeScript, Effect-ts, Bun APIs
- Existing: PersistentMemory, CacheDebugLog, AI SDK `experimental_repairToolCall`
- New: LLM-driven consolidation call, JSONL diagnostic writer, JSON state machine parser

## Testing Strategy

- Unit: mock memory entries → verify dedup logic, mock malformed JSON → verify repair, mock request → verify diagnostic output
- Integration: end-to-end /dream with real memory dir, diagnostic log rotation
- Done when: `bun --cwd packages/opencode typecheck && bun --cwd packages/opencode test --timeout 30000` passes

## Phases

### Phase 1: `/dream` Memory Consolidation

- Step 1: Add `dream()` function to `src/memory/persistent.ts` — reads all entries, calls local/small model with consolidation prompt, writes merged output
- Step 2: Add `/dream` slash command in `src/cli/cmd/tui/command/memory-commands.tsx` — triggers consolidation, shows toast with before/after count
- Step 3: Add `POST /session/:sessionID/memory/dream` API route (optional, for SDK access)

**Details:**

- Consolidation prompt: "Merge related entries, remove duplicates, keep facts only. Output one entry per line in format `[type] name: content`"
- Uses `resolveLocal()` (same as microcompact) for the LLM call — prefers local model, falls back to small_model
- Backs up existing memory dir before overwrite (`memory.bak/` timestamped)
- Respects `MAX_FILES = 200` cap post-consolidation
- Idempotent: running twice produces same result

### Phase 2: Runtime Wire Diagnostics

- Step 1: Add `src/session/wire-diagnostics.ts` — per-request profiling service
- Step 2: Hook into `streamText` call in `src/session/llm.ts` — capture pre/post metrics
- Step 3: Write JSONL to `~/.local/share/opencode/wire-diagnostics/` (same pattern as cache-debug-log)
- Step 4: Gate behind `experimental.wire_diagnostics: true` config flag

**Metrics captured (NO content, privacy-safe):**

- `ts`: timestamp
- `sessionID`: session
- `modelID`: model used
- `messages.count`: total message count
- `messages.byRole`: `{ system: N, user: N, assistant: N, tool: N }`
- `messages.totalBytes`: total serialized byte count
- `tools.count`: number of tools
- `tools.schemaBytes`: total schema byte size
- `providerOptions.bytes`: providerOptions size
- `response.inputTokens`, `response.outputTokens`, `response.cacheRead`, `response.cacheWrite`
- `response.durationMs`: wall clock time
- `response.toolCalls`: count of tool calls in response

### Phase 3: Streaming Tool Call JSON Repair

- Step 1: Add `src/provider/json-repair.ts` — state machine parser for partial/corrupted JSON
- Step 2: Wire into `experimental_repairToolCall` in `src/session/llm.ts` — attempt JSON repair before rejecting
- Step 3: Add fallback: if AI SDK's native streaming fails, attempt repair on accumulated buffer

**Repair capabilities:**

- Auto-close unclosed strings (missing closing `"`)
- Auto-close unclosed objects/arrays (missing `}` or `]`)
- Strip trailing commas before closers
- Handle truncated numbers (e.g., `123.` → `123.0`)
- Handle null bytes / control characters (strip them)

**NOT in scope:**

- Custom streaming parser replacing AI SDK (AI SDK handles streaming natively)
- Per-provider streaming differences (handled by AI SDK's provider implementations)

## Risks/Edge cases

- **`/dream` data loss**: Mitigated by timestamped backup before overwrite
- **`/dream` LLM hallucination**: Mitigated by keeping backup; user can restore
- **Wire diagnostics perf**: JSONL append is non-blocking (fire-and-forget write); disabled by default
- **JSON repair false positive**: Repair only attempted on FAILED tool calls (after AI SDK gives up); no risk of corrupting valid calls
- **Rebase safety**: All three are fork-only additions in new files or additive hooks — zero conflict with upstream

## Rebase Safety Analysis

| Change                                              | Location                      | Risk                                                          |
| --------------------------------------------------- | ----------------------------- | ------------------------------------------------------------- |
| `dream()` in persistent.ts                          | Additive function             | **None** — fork-only file                                     |
| `/dream` command in memory-commands.tsx             | New array entry               | **None** — fork-only file                                     |
| wire-diagnostics.ts                                 | New file                      | **None**                                                      |
| Config flag `wire_diagnostics`                      | Additive field                | **Low**                                                       |
| json-repair.ts                                      | New file                      | **None**                                                      |
| `experimental_repairToolCall` enhancement in llm.ts | Existing hook, additive logic | **Low** — hook already exists, we add repair before rejecting |

## Implementation Order

```
Phase 1 ─── Phase 2 ─── Phase 3
  /dream     diagnostics   JSON repair
  [independent — can be parallel]
```

All three are fully independent. No cross-dependencies.
