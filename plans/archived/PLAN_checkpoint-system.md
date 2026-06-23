# Plan: Checkpoint System

## Overview

File-based checkpoint system that periodically summarizes long sessions into structured markdown files (checkpoint.md, memory.md, notes.md), enabling context rebuild after compaction. A background writer subagent reads the conversation delta, produces section-structured summaries, and inserts a synthetic rebuild boundary so the main agent can seamlessly resume work after context trimming.

## Tech Stack

- TypeScript 5.8, Bun 1.3.11
- Effect-ts 4.0.0-beta (Service/Layer pattern, Effect.fn, Deferred, Scope)
- Vercel AI SDK `generateText` (writer subagent LLM calls)
- drizzle-orm + bun:sqlite (session table column for boundary tracking)
- Bun.file / fs/promises (checkpoint artifact I/O)

## Testing Strategy

- Unit: `computeBoundary` pure function (token budget, role-aware, edge cases), `alignToNonToolResultUser`, `buildProgressDiff`, template validators, checkpoint-paths resolution
- Integration: writer spawn → settle → checkpoint.md exists, `renderRebuildContext` produces correct sections, `insertRebuildBoundary` microcompact clears tool results, `drainWriters` shutdown path
- Done when: checkpoint writer spawns on overflow, produces valid checkpoint.md, rebuild context injects correctly, existing compaction/sliding-window flows unaffected with flag off

## Phases

### Phase 1: Foundation — Paths, Templates, Schema

- Step 1: Create `src/session/checkpoint-paths.ts` — pure functions `metaDir`, `checkpointPath`, `memoryPath`, `globalMemoryPath`, `notesPath`, `tasksDir`, `progressPath`, `migrateProjectMemory` (port from MiMo, adapt to use opencode-x `Global.Path.data`)
- Step 2: Create `src/session/checkpoint-templates.ts` — export `CHECKPOINT_TEMPLATE`, `MEMORY_TEMPLATE`, `NOTES_TEMPLATE`, `CHECKPOINT_SECTION_BUDGETS`, `MEMORY_SECTION_BUDGETS`
- Step 3: Create `src/session/checkpoint-align.ts` — pure function `alignToNonToolResultUser`
- Step 4: Create `src/session/checkpoint-context.ts` — in-memory Map store for per-writer context (priorTitles, expectedRevisions)
- Step 5: Add `last_checkpoint_message_id` column to `SessionTable` in a new migration (additive, nullable `text().$type<MessageID>()`)
- Step 6: Add `OPENCODE_EXPERIMENTAL_CHECKPOINT` flag in `src/flag/flag.ts` (env-gated, default off)

### Phase 2: Boundary Computation & Budget Utils

- Step 1: Create `src/session/checkpoint-boundary.ts` — export `computeBoundary` (token-budgeted tail with `TAIL_MIN_TOKENS=10000`, `TAIL_MAX_TOKENS=20000`), `estimateMessageTokens`, `COMPACTABLE_TOOL_NAMES` set
- Step 2: Create `src/session/budgeted-read.ts` — `readBudgeted` and `readBudgetedSectionAware` utilities for token-capped file reads (used by renderRebuildContext)
- Step 3: Create `src/session/checkpoint-progress-reconcile.ts` — port `parseWrittenAt`, `parseReconciledMap`, `buildProgressDiffItems`, `buildProgressDiff`
- Step 4: Unit tests for `computeBoundary` (empty msgs, single msg, boundary walk-back, max-tokens cap)

### Phase 3: Writer Prompt & Validation

- Step 1: Create `src/agent/prompt/checkpoint-writer.txt` — writer system prompt (section budgets, absolute-paths-only constraint, tool whitelist)
- Step 2: Create `src/session/checkpoint-writer-prompt.ts` — `composeWriterPrompt`, `renderSectionBudgets` (compose system-reminder + paths + template)
- Step 3: Create `src/session/checkpoint-validator.ts` — `validateSnapshot`, `validateLearning`, `validateMemory`, `validateProgress`, `validateBudget`, `validateBudgetSections`, `extractTitlesFromLearning`
- Step 4: Create `src/session/checkpoint-retry.ts` — `loadPriorDiscoveredTitles`, `runValidatorsForCkpt`, `quarantineCheckpoint`, `buildReflectionMessage`

### Phase 4: Core Service Implementation

- Step 1: Create `src/session/checkpoint.ts` — Effect Service with `Interface` exposing: `tryStartCheckpointWriter`, `waitForWriter`, `drainWriters`, `hasCheckpoint`, `hasMemoryOrTasks`, `loadLatest`, `loadCheckpoints`, `renderIndex`, `renderRebuildContext`, `lastBoundary`, `isWriterRunning`, `insertRebuildBoundary`
- Step 2: Implement layer closure with `writers: Map<SessionID, WriterState>` (Deferred-based writer tracking, 1-slot pending queue for F40 coalescing)
- Step 3: Implement `tryStartCheckpointWriter` — gated by flag, computes boundary via `computeBoundary`, adjusts for API invariants, spawns writer subagent via existing task spawn infrastructure (`spawnSubagent` from `orchestration/task-spawn`), advances `last_checkpoint_message_id` on settle
- Step 4: Implement `renderRebuildContext` — reads checkpoint.md/memory.md/notes.md with budgets, composes tasks ledger + session checkpoint + project memory + global memory + memory keys index + seam framing + tail-aware reminders
- Step 5: Implement `insertRebuildBoundary` — inserts synthetic user message with checkpoint part + rebuild text + microcompact clearing of compactable tool results
- Step 6: Wire `defaultLayer` with dependencies: `Session.Service`, `Bus.Service`, `Config.Service`; export convenience wrappers (`hasCheckpoint`, `loadLatest`, etc.)

### Phase 5: Integration Points (flag-gated)

- Step 1: In session processor/prompt loop, after assistant finish + overflow detection: call `tryStartCheckpointWriter` when flag enabled (additive hook, no existing signature changes)
- Step 2: In compaction/rebuild path: when checkpoint exists and flag enabled, call `renderRebuildContext` + `insertRebuildBoundary` instead of (or alongside) existing compaction summary
- Step 3: Add checkpoint-writer agent definition in `src/agent/` (tools: read, write, edit, glob, grep, task; no arbitrary tools)
- Step 4: Wire drain path: on CLI shutdown, call `drainWriters` so in-flight writers settle before exit

### Phase 6: Auxiliary Reminders & Polish

- Step 1: Add tail-aware system reminders (`autonomousLoopReminder`, `stopReminder`, `toolResultContinueReminder`) to rebuild context
- Step 2: Add memory recall reminder — when `hasMemoryOrTasks` returns true, inject recall protocol hint into per-user-message context
- Step 3: Wire Bus event for writer cache performance metrics (observability)
- Step 4: Integration tests: full cycle (spawn → writer settles → checkpoint.md valid → rebuild context non-empty → microcompact fires)

## Risks/Edge cases

- **Layer cycle (Checkpoint ↔ Agent/Prompt)**: Mitigation: use late-bound ref pattern (like MiMo's `spawnRef`) or spawn via existing `spawnSubagent` from orchestration which already breaks the cycle
- **Empty delta / degenerate sessions**: Mitigation: bail early with "skipped" when boundary computation yields no meaningful messages
- **Writer timeout blocking main agent**: Mitigation: `waitForWriter` has 300s cap; `renderRebuildContext` races writer settlement against 60s timeout then falls back to on-disk state
- **Concurrent writers (same session)**: Mitigation: 1-slot pending queue; newest evicts older pending (strict superset range guarantees no duplicate work)
- **Migration column addition**: Mitigation: nullable column with no NOT NULL constraint; existing rows unaffected; old code ignores the column
- **Checkpoint artifacts on disk (not DB)**: Mitigation: `metaDir` uses `Global.Path.data` which is already stable; no file lock needed (single writer per session enforced by Map)
- **Upstream rebase safety**: All new files; only additions to `SessionTable` (nullable column) and `flag.ts` (new export). No signature changes to existing functions
- **Provider caching impact**: Writer subagent runs in child session; parent's prompt prefix is untouched; no cache-breaking changes to main agent's message sequence
