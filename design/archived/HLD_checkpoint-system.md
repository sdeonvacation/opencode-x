# HLD: Checkpoint System

## Summary

File-based checkpoint system that periodically summarizes long sessions into structured markdown artifacts (checkpoint.md, memory.md, notes.md). A background writer subagent runs on context overflow, reads conversation delta, produces section-structured summaries, and inserts a synthetic rebuild boundary so the main agent resumes seamlessly after compaction trims context.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Session Loop (existing)                      │
│                                                                     │
│  ┌──────────┐    overflow    ┌──────────────────────┐               │
│  │ Assistant │──────────────▶│ tryStartCheckpoint   │               │
│  │  Finish   │               │  Writer              │               │
│  └──────────┘               └──────────┬───────────┘               │
│                                         │                           │
│                                         │ spawn (child session)     │
│                                         ▼                           │
│                              ┌──────────────────────┐               │
│                              │  Writer Subagent     │               │
│                              │  (background)        │               │
│                              │  - read/write/edit   │               │
│                              │  - glob/grep/task    │               │
│                              └──────────┬───────────┘               │
│                                         │                           │
│                                         │ writes                    │
│                                         ▼                           │
│                              ┌──────────────────────┐               │
│                              │  Checkpoint Artifacts │               │
│                              │  ~/.local/share/      │               │
│                              │    opencode/meta/     │               │
│                              │    <session>/         │               │
│                              │    ├─ checkpoint.md   │               │
│                              │    ├─ memory.md       │               │
│                              │    └─ notes.md        │               │
│                              └──────────────────────┘               │
│                                                                     │
│  ┌──────────┐  compaction    ┌──────────────────────┐               │
│  │ Compaction│──────────────▶│ renderRebuildContext  │               │
│  │ Trigger   │               │ + insertRebuild      │               │
│  └──────────┘               │   Boundary            │               │
│                              └──────────────────────┘               │
└─────────────────────────────────────────────────────────────────────┘
```

## Components

### Component 1: Checkpoint Paths

- **File**: `src/session/checkpoint-paths.ts`
- **Type**: Pure Module
- **Exports**: `metaDir`, `checkpointPath`, `memoryPath`, `globalMemoryPath`, `notesPath`, `tasksDir`, `progressPath`, `migrateProjectMemory`
- **Dependencies**: `Global.Path.data`
- **Interface**:
  ```typescript
  export function metaDir(session: SessionID): string
  export function checkpointPath(session: SessionID): string
  export function memoryPath(session: SessionID): string
  export function globalMemoryPath(): string
  export function notesPath(session: SessionID): string
  export function tasksDir(session: SessionID): string
  export function progressPath(session: SessionID): string
  export function migrateProjectMemory(dir: string): void
  ```

### Component 2: Checkpoint Templates

- **File**: `src/session/checkpoint-templates.ts`
- **Type**: Pure Module
- **Exports**: `CHECKPOINT_TEMPLATE`, `MEMORY_TEMPLATE`, `NOTES_TEMPLATE`, `CHECKPOINT_SECTION_BUDGETS`, `MEMORY_SECTION_BUDGETS`
- **Dependencies**: None
- **Interface**:
  ```typescript
  export const CHECKPOINT_TEMPLATE: string
  export const MEMORY_TEMPLATE: string
  export const NOTES_TEMPLATE: string
  export const CHECKPOINT_SECTION_BUDGETS: Record<string, number>
  export const MEMORY_SECTION_BUDGETS: Record<string, number>
  ```

### Component 3: Checkpoint Align

- **File**: `src/session/checkpoint-align.ts`
- **Type**: Pure Module
- **Exports**: `alignToNonToolResultUser`
- **Dependencies**: `MessageV2`
- **Interface**:
  ```typescript
  // Walk backward from a boundary index to find a user message
  // that is NOT a tool-result-only message (API invariant safe)
  export function alignToNonToolResultUser(messages: MessageV2.WithParts[], index: number): number
  ```

### Component 4: Checkpoint Context Store

- **File**: `src/session/checkpoint-context.ts`
- **Type**: Pure Module
- **Exports**: `WriterContext`, `getContext`, `setContext`, `clearContext`
- **Dependencies**: `SessionID`
- **Interface**:

  ```typescript
  export type WriterContext = {
    titles: string[] // prior discovered section titles
    revisions: number // expected revision count
  }

  export function getContext(session: SessionID): WriterContext | undefined
  export function setContext(session: SessionID, ctx: WriterContext): void
  export function clearContext(session: SessionID): void
  ```

### Component 5: Checkpoint Boundary

- **File**: `src/session/checkpoint-boundary.ts`
- **Type**: Pure Module
- **Exports**: `computeBoundary`, `estimateMessageTokens`, `COMPACTABLE_TOOL_NAMES`, `TAIL_MIN_TOKENS`, `TAIL_MAX_TOKENS`
- **Dependencies**: `MessageV2`, `Token`, `checkpoint-align`
- **Interface**:

  ```typescript
  export const TAIL_MIN_TOKENS = 10_000
  export const TAIL_MAX_TOKENS = 20_000
  export const COMPACTABLE_TOOL_NAMES: Set<string>

  export type BoundaryResult = {
    index: number // message index where checkpoint coverage ends
    id: MessageID // message ID at boundary
    tail: MessageV2.WithParts[] // messages AFTER boundary (kept verbatim)
    head: MessageV2.WithParts[] // messages BEFORE boundary (summarized)
  }

  export function estimateMessageTokens(msg: MessageV2.WithParts): number

  // Compute boundary: walk backward from end, accumulate tokens
  // until TAIL_MIN_TOKENS..TAIL_MAX_TOKENS budget exhausted.
  // Then align to non-tool-result user message.
  export function computeBoundary(
    messages: MessageV2.WithParts[],
    opts?: { min?: number; max?: number },
  ): BoundaryResult | undefined
  ```

### Component 6: Budgeted Read

- **File**: `src/session/budgeted-read.ts`
- **Type**: Pure Module
- **Exports**: `readBudgeted`, `readBudgetedSectionAware`
- **Dependencies**: `Bun.file`, `Token`
- **Interface**:

  ```typescript
  // Read file up to token budget, return content + whether truncated
  export function readBudgeted(path: string, budget: number): Promise<{ content: string; truncated: boolean }>

  // Section-aware: preserve section headers, truncate within sections
  export function readBudgetedSectionAware(
    path: string,
    budget: number,
  ): Promise<{ content: string; truncated: boolean; sections: string[] }>
  ```

### Component 7: Checkpoint Progress Reconcile

- **File**: `src/session/checkpoint-progress-reconcile.ts`
- **Type**: Pure Module
- **Exports**: `parseWrittenAt`, `parseReconciledMap`, `buildProgressDiffItems`, `buildProgressDiff`
- **Dependencies**: None (string parsing)
- **Interface**:

  ```typescript
  export type ProgressItem = { path: string; status: string; at: number }

  export function parseWrittenAt(line: string): number | undefined
  export function parseReconciledMap(content: string): Map<string, ProgressItem>
  export function buildProgressDiffItems(
    prev: Map<string, ProgressItem>,
    curr: Map<string, ProgressItem>,
  ): ProgressItem[]
  export function buildProgressDiff(prev: string, curr: string): string
  ```

### Component 8: Checkpoint Writer Prompt

- **File**: `src/session/checkpoint-writer-prompt.ts`
- **Type**: Pure Module
- **Exports**: `composeWriterPrompt`, `renderSectionBudgets`
- **Dependencies**: `checkpoint-templates`, `checkpoint-paths`
- **Interface**:

  ```typescript
  export function renderSectionBudgets(budgets: Record<string, number>): string

  export function composeWriterPrompt(input: {
    session: SessionID
    paths: { checkpoint: string; memory: string; notes: string }
    template: string
    budgets: Record<string, number>
  }): string
  ```

### Component 9: Checkpoint Validator

- **File**: `src/session/checkpoint-validator.ts`
- **Type**: Pure Module
- **Exports**: `validateSnapshot`, `validateLearning`, `validateMemory`, `validateProgress`, `validateBudget`, `validateBudgetSections`, `extractTitlesFromLearning`
- **Dependencies**: `checkpoint-templates`
- **Interface**:

  ```typescript
  export type ValidationResult = { valid: boolean; errors: string[] }

  export function validateSnapshot(content: string): ValidationResult
  export function validateLearning(content: string): ValidationResult
  export function validateMemory(content: string): ValidationResult
  export function validateProgress(content: string): ValidationResult
  export function validateBudget(content: string, budgets: Record<string, number>): ValidationResult
  export function validateBudgetSections(content: string, budgets: Record<string, number>): ValidationResult
  export function extractTitlesFromLearning(content: string): string[]
  ```

### Component 10: Checkpoint Retry

- **File**: `src/session/checkpoint-retry.ts`
- **Type**: Pure Module
- **Exports**: `loadPriorDiscoveredTitles`, `runValidatorsForCkpt`, `quarantineCheckpoint`, `buildReflectionMessage`
- **Dependencies**: `checkpoint-validator`, `checkpoint-paths`, `Bun.file`
- **Interface**:
  ```typescript
  export function loadPriorDiscoveredTitles(session: SessionID): Promise<string[]>
  export function runValidatorsForCkpt(session: SessionID): Promise<ValidationResult>
  export function quarantineCheckpoint(session: SessionID): Promise<void>
  export function buildReflectionMessage(errors: string[]): string
  ```

### Component 11: Checkpoint Service

- **File**: `src/session/checkpoint.ts`
- **Type**: Effect Service
- **Exports**: `Checkpoint` namespace with `Interface`, `Service`, `layer`, `defaultLayer`, convenience wrappers
- **Dependencies**: `Session.Service`, `Bus.Service`, `Config.Service`, `checkpoint-paths`, `checkpoint-boundary`, `checkpoint-templates`, `budgeted-read`, `checkpoint-context`, `task-spawn`
- **Interface**:

  ```typescript
  export namespace Checkpoint {
    export interface Interface {
      readonly tryStartCheckpointWriter: (input: {
        sessionID: SessionID
        messages: MessageV2.WithParts[]
      }) => Effect.Effect<boolean>

      readonly waitForWriter: (input: { sessionID: SessionID; timeout?: number }) => Effect.Effect<boolean>

      readonly drainWriters: () => Effect.Effect<void>

      readonly hasCheckpoint: (input: { sessionID: SessionID }) => Effect.Effect<boolean>

      readonly hasMemoryOrTasks: (input: { sessionID: SessionID }) => Effect.Effect<boolean>

      readonly loadLatest: (input: {
        sessionID: SessionID
      }) => Effect.Effect<{ checkpoint?: string; memory?: string; notes?: string }>

      readonly renderRebuildContext: (input: {
        sessionID: SessionID
        tail: MessageV2.WithParts[]
      }) => Effect.Effect<string>

      readonly insertRebuildBoundary: (input: {
        sessionID: SessionID
        context: string
        messages: MessageV2.WithParts[]
      }) => Effect.Effect<void>

      readonly isWriterRunning: (input: { sessionID: SessionID }) => Effect.Effect<boolean>

      readonly lastBoundary: (input: { sessionID: SessionID }) => Effect.Effect<MessageID | undefined>
    }

    export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Checkpoint") {}
  }
  ```

### Component 12: Checkpoint Writer Agent

- **File**: `src/agent/agents/checkpoint-writer.ts`
- **Type**: Agent Definition
- **Exports**: agent config registered via agent system
- **Dependencies**: Agent registry, tools: `read`, `write`, `edit`, `glob`, `grep`, `task`
- **Interface**: Standard agent definition (markdown prompt + tool whitelist)

### Component 13: Writer System Prompt

- **File**: `src/agent/prompt/checkpoint-writer.txt`
- **Type**: Static text resource
- **Exports**: N/A (loaded by agent definition)
- **Dependencies**: None

## Data Flow

### Main Flow: Checkpoint Writer Spawn

| Step | Component           | Action                                                | Next                 |
| ---- | ------------------- | ----------------------------------------------------- | -------------------- |
| 1    | Session Loop        | Assistant finish + overflow detected                  | Checkpoint Service   |
| 2    | Checkpoint Service  | Check flag enabled, check no writer running           | Boundary Computation |
| 3    | Checkpoint Boundary | `computeBoundary(messages)` → head/tail split         | Writer Spawn         |
| 4    | Checkpoint Service  | Spawn writer subagent via `spawnSubagent`             | Writer Subagent      |
| 5    | Writer Subagent     | Read delta messages, produce structured summary       | Disk Artifacts       |
| 6    | Writer Subagent     | Write checkpoint.md, memory.md, notes.md              | Settle               |
| 7    | Checkpoint Service  | On settle: advance `last_checkpoint_message_id` in DB | Done                 |

### Rebuild Flow: Context Restoration

| Step | Component          | Action                                                      | Next               |
| ---- | ------------------ | ----------------------------------------------------------- | ------------------ |
| 1    | Compaction Trigger | Overflow + checkpoint exists + flag on                      | Checkpoint Service |
| 2    | Checkpoint Service | `waitForWriter` (60s race, fallback to on-disk)             | Render             |
| 3    | Checkpoint Service | `renderRebuildContext` reads artifacts with budgets         | Insert             |
| 4    | Checkpoint Service | `insertRebuildBoundary` → synthetic user msg + microcompact | Session            |
| 5    | Session            | Continues with rebuilt context, tail preserved              | Loop Resume        |

### Shutdown Flow

| Step | Component          | Action                                                    | Next               |
| ---- | ------------------ | --------------------------------------------------------- | ------------------ |
| 1    | CLI Shutdown       | Signal received                                           | Checkpoint Service |
| 2    | Checkpoint Service | `drainWriters()` — await all in-flight writers (300s cap) | Exit               |

## Database Schema

```typescript
// Addition to existing SessionTable in src/session/session.sql.ts
// New nullable column — additive migration, no NOT NULL constraint
export const SessionTable = sqliteTable("session", {
  // ... existing columns ...
  last_checkpoint_message_id: text().$type<MessageID>(),
})
```

Migration file: `migration/<timestamp>_add_checkpoint_boundary/migration.sql`

```sql
ALTER TABLE session ADD COLUMN last_checkpoint_message_id TEXT;
```

## Configuration

Addition to `experimental` object in config schema (`src/config/config.ts`):

```typescript
checkpoint: z.boolean().optional().describe("Enable checkpoint system for long session context preservation"),
```

No new top-level config keys. Checkpoint behavior controlled entirely by feature flag + experimental config toggle.

## Feature Flag

- **Flag name**: `OPENCODE_EXPERIMENTAL_CHECKPOINT`
- **Env var**: `OPENCODE_EXPERIMENTAL_CHECKPOINT`
- **Location**: `src/flag/flag.ts`
- **Pattern**: `truthy("OPENCODE_EXPERIMENTAL_CHECKPOINT")` (consistent with existing flags)
- **Gating behavior**: When false (default), all checkpoint code paths are no-ops. `tryStartCheckpointWriter` returns `false` immediately. `renderRebuildContext` is never called. Existing compaction flow unchanged.

```typescript
// In src/flag/flag.ts
export const OPENCODE_EXPERIMENTAL_CHECKPOINT = truthy("OPENCODE_EXPERIMENTAL_CHECKPOINT")
```

## Integration Points

| Where                 | File                            | How                                                                                                                                                       |
| --------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session loop overflow | `src/session/` (processor/loop) | After assistant finish + overflow detection, call `Checkpoint.tryStartCheckpointWriter` when flag enabled. Additive hook — no existing signature changes. |
| Compaction rebuild    | `src/session/compaction.ts`     | When checkpoint exists + flag enabled, call `renderRebuildContext` + `insertRebuildBoundary`. Gated branch alongside existing flow.                       |
| Agent registry        | `src/agent/`                    | Register `checkpoint-writer` agent definition. No modification to existing agents.                                                                        |
| CLI shutdown          | CLI entry point                 | Call `Checkpoint.drainWriters()` before exit. Additive.                                                                                                   |
| Flag file             | `src/flag/flag.ts`              | New export `OPENCODE_EXPERIMENTAL_CHECKPOINT`.                                                                                                            |
| Config schema         | `src/config/config.ts`          | Add `checkpoint` to `experimental` object.                                                                                                                |
| Session schema        | `src/session/session.sql.ts`    | Add nullable `last_checkpoint_message_id` column.                                                                                                         |
| Bus events            | `src/bus/`                      | New `BusEvent.define("checkpoint.writer.settled", ...)` for observability.                                                                                |

## Error Handling

| Scenario                         | Handling                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Writer timeout (>300s)           | `waitForWriter` resolves with `false`; rebuild uses on-disk state (stale but safe)                          |
| Writer LLM failure               | Writer subagent errors logged; checkpoint artifacts not written; next overflow triggers fresh attempt       |
| Empty delta (degenerate session) | `computeBoundary` returns `undefined` → `tryStartCheckpointWriter` returns `false`, no spawn                |
| Concurrent writer same session   | 1-slot pending queue; newest evicts older pending (strict superset guarantees no duplicate work)            |
| Disk write failure               | Writer subagent tool error propagates; quarantine via `checkpoint-retry`                                    |
| Validation failure               | `runValidatorsForCkpt` detects; `quarantineCheckpoint` moves bad file; `buildReflectionMessage` feeds retry |
| Missing checkpoint on rebuild    | `hasCheckpoint` returns `false`; compaction proceeds with existing summary-only flow                        |
| Flag disabled mid-session        | All entry points check flag; in-flight writers allowed to settle but no new spawns                          |

## Constraints

- **Upstream-rebase safe**: All new files. Only additions: nullable column to `SessionTable`, new export in `flag.ts`, new key in config `experimental` schema. No signature changes to existing functions.
- **Provider cache**: Writer subagent runs in child session. Parent's prompt prefix untouched. No cache-breaking changes to main agent's message sequence. `insertRebuildBoundary` only fires during compaction (already a cache-invalidating event).
- **Performance**: Writer runs in background (fire-and-forget). Main agent loop never blocks on writer. `waitForWriter` only called during compaction rebuild path with 60s timeout + fallback. `computeBoundary` is O(n) single-pass over messages — negligible vs LLM latency.
- **Disk usage**: Checkpoint artifacts are small markdown files (~2-10KB each). No unbounded growth — each write overwrites previous per-session.
- **Concurrency**: Single writer per session enforced by Map + 1-slot pending queue. No file locks needed.

## Test Plan

### Unit Tests

**`checkpoint-boundary.test.ts`**:

- Empty messages → returns `undefined`
- Single message → returns `undefined` (nothing to checkpoint)
- Walk-back finds correct boundary at TAIL_MIN_TOKENS
- Max-tokens cap respected
- `alignToNonToolResultUser` skips tool-result-only messages
- `estimateMessageTokens` handles text/tool/file parts

**`checkpoint-align.test.ts`**:

- Aligns to nearest user message without tool-result parts
- Edge: all messages are tool-result → returns 0

**`checkpoint-paths.test.ts`**:

- Paths resolve correctly relative to `Global.Path.data`
- `migrateProjectMemory` creates target dir

**`checkpoint-validator.test.ts`**:

- Valid checkpoint passes all validators
- Missing sections fail `validateSnapshot`
- Over-budget sections fail `validateBudget`
- `extractTitlesFromLearning` extracts markdown headings

**`checkpoint-progress-reconcile.test.ts`**:

- `parseWrittenAt` extracts timestamps
- `buildProgressDiff` produces correct diff from prev/curr

**`budgeted-read.test.ts`**:

- Truncates at token budget
- Section-aware preserves headers
- Returns `truncated: true` when content exceeds budget
- Missing file returns empty

### Integration Tests

**`checkpoint.test.ts`**:

- Full cycle: spawn writer → settle → checkpoint.md exists on disk
- `renderRebuildContext` produces non-empty string with correct sections
- `insertRebuildBoundary` creates synthetic user message + clears compactable tool results
- `drainWriters` awaits in-flight writer before resolving
- Flag off → `tryStartCheckpointWriter` returns `false`, no disk artifacts
- Concurrent calls → only one writer runs, second queued

### End-to-End Tests

- Session with enough messages to trigger overflow → checkpoint writer spawns → artifacts valid
- Compaction fires with checkpoint present → rebuild context injected → agent resumes coherently
- Existing compaction flow unchanged when flag is off (regression guard)

### Non-Functional Tests

- Writer must settle within 300s (timeout test)
- `renderRebuildContext` must complete within 60s (timeout race)
- No orphan subagent processes after `drainWriters`
