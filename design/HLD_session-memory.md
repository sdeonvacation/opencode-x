# HLD: Session Memory

## Tech Stack

| Category  | Technology        | Purpose                                     |
| --------- | ----------------- | ------------------------------------------- |
| Language  | TypeScript 5.8    | Existing codebase language                  |
| Runtime   | Bun 1.3.11        | Existing runtime                            |
| Framework | Effect 4.0-beta   | Service/layer patterns, `Effect.fn` for ops |
| Database  | SQLite + Drizzle  | Persistent storage via `MemoryTable`        |
| TUI       | Solid.js @opentui | Dialog commands for add/edit/delete         |
| Server    | Hono              | REST routes for memory CRUD                 |
| Schema    | Zod               | API validation and SDK type generation      |
| Test      | bun:test          | Unit + integration tests                    |

## Components

| Component         | Responsibility                                  | Dependencies                        |
| ----------------- | ----------------------------------------------- | ----------------------------------- |
| `MemoryTable`     | Schema definition for persistent memory entries | `SessionTable` (FK), `Timestamps`   |
| `Memory` module   | CRUD operations + bus events                    | `Database`, `Bus`, `SessionID`      |
| `MemoryRoutes`    | HTTP API for memory CRUD                        | `Memory` module, `Hono`, `Zod`      |
| `memory-commands` | TUI slash commands (`/memory_add`, etc.)        | `DialogPrompt`, `DialogSelect`, SDK |
| Prompt injection  | Appends memory block to system prompt array     | `Memory` module, `Agent.mode` check |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        TUI Layer                            │
│                                                             │
│  /memory_add ──┐                                            │
│  /memory_edit ─┼──▶ SDK Client ──▶ MemoryRoutes (Hono)     │
│  /memory_delete┘                                            │
└─────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
┌─────────────────────────────────────────────────────────────┐
│                     Memory Module                           │
│                                                             │
│  Memory.list(sessionID)                                     │
│  Memory.create({ sessionID, content })                      │
│  Memory.update({ id, content })                             │
│  Memory.remove(id)                                          │
│                                                             │
│  Bus.publish(Memory.Event.Updated, { sessionID, entries })  │
└─────────────────────────────────────────────────────────────┘
         │                                    │
         ▼                                    ▼
┌──────────────────┐              ┌───────────────────────────┐
│  SQLite/Drizzle  │              │    Prompt Assembly        │
│  MemoryTable     │              │    (prompt.ts runLoop)    │
│                  │              │                           │
│  id              │              │  if agent.mode==="primary"│
│  session_id (FK) │              │    fetch Memory.list()    │
│  content         │              │    append to system[]     │
│  position        │              │                           │
│  time_created    │              │  Format:                  │
│  time_updated    │              │  "Session Memory:\n- ..." │
└──────────────────┘              └───────────────────────────┘
```

**Description**: Memory entries are stored in a dedicated `MemoryTable` with cascade-delete FK to `SessionTable`. The Memory module provides Effect-based CRUD. Routes expose HTTP API consumed by the SDK client. TUI commands use dialog patterns (prompt for add, select+prompt for edit, select for delete). At LLM call time, `prompt.ts` fetches entries and appends them to the `system` array only for primary agents. Since `/clear` and `/clear-compact` only delete from `MessageTable`, `PartTable`, `TodoTable`, and child sessions — `MemoryTable` is untouched (clear immunity by design).

## Interfaces

### Memory Module (`src/memory/memory.ts`)

| Method   | Input                                       | Output                   | Behavior                                        | Errors          |
| -------- | ------------------------------------------- | ------------------------ | ----------------------------------------------- | --------------- |
| `list`   | `sessionID: SessionID`                      | `Promise<Memory.Info[]>` | Returns all entries ordered by position         | None (empty []) |
| `create` | `{ sessionID: SessionID, content: string }` | `Promise<Memory.Info>`   | Inserts entry at next position, publishes event | FK violation    |
| `update` | `{ id: MemoryID, content: string }`         | `Promise<Memory.Info>`   | Updates content + time_updated, publishes event | NotFound        |
| `remove` | `id: MemoryID`                              | `Promise<void>`          | Deletes entry, publishes event                  | NotFound        |

### Memory Routes (`src/server/routes/memory.ts`)

| Method | Path                           | Input                            | Output          | OperationID             |
| ------ | ------------------------------ | -------------------------------- | --------------- | ----------------------- |
| GET    | `/:sessionID/memory`           | `param: { sessionID }`           | `Memory.Info[]` | `session.memory.list`   |
| POST   | `/:sessionID/memory`           | `param + json: { content }`      | `Memory.Info`   | `session.memory.create` |
| PUT    | `/:sessionID/memory/:memoryID` | `param + json: { content }`      | `Memory.Info`   | `session.memory.update` |
| DELETE | `/:sessionID/memory/:memoryID` | `param: { sessionID, memoryID }` | `boolean`       | `session.memory.delete` |

### TUI Commands (`src/cli/cmd/tui/command/memory-commands.tsx`)

| Command          | Dialog Flow                                           | SDK Call                |
| ---------------- | ----------------------------------------------------- | ----------------------- |
| `/memory_add`    | `DialogPrompt.show("Memory", { placeholder })` → text | `session.memory.create` |
| `/memory_edit`   | `DialogSelect` (pick entry) → `DialogPrompt` (edit)   | `session.memory.update` |
| `/memory_delete` | `DialogSelect` (pick entry) → confirm                 | `session.memory.delete` |

## Data Flow

### Add Memory

| Step | Component     | Action                                 | Next          |
| ---- | ------------- | -------------------------------------- | ------------- |
| 1    | TUI Command   | User invokes `/memory_add`             | DialogPrompt  |
| 2    | DialogPrompt  | User types content, submits            | SDK Client    |
| 3    | SDK Client    | POST `/:sessionID/memory`              | MemoryRoutes  |
| 4    | MemoryRoutes  | Validates, calls `Memory.create()`     | Memory Module |
| 5    | Memory Module | INSERT into MemoryTable, publish event | Bus           |
| 6    | Bus           | `Memory.Event.Updated` fires           | SyncEvent     |
| 7    | SyncEvent     | Projector updates client-side store    | TUI (toast)   |

### Prompt Injection

| Step | Component     | Action                                    | Next         |
| ---- | ------------- | ----------------------------------------- | ------------ |
| 1    | prompt.ts     | `runLoop` enters step, resolves agent     | Check mode   |
| 2    | prompt.ts     | `agent.mode === "primary"` guard          | Fetch memory |
| 3    | Memory Module | `Memory.list(sessionID)` returns entries  | Format       |
| 4    | prompt.ts     | Format as labeled block, push to `system` | LLM call     |

**Error Flows**:

- FK violation on create → session doesn't exist → route returns 404
- NotFound on update/delete → entry doesn't exist → route returns 404
- Empty memory list → no block appended to system prompt (no-op)
- Memory fetch failure in prompt.ts → `Effect.orElseSucceed(() => [])` → graceful degradation

## Data Model

| Entity   | Fields                                                                                                                                     | Relationships            | Constraints                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------ |
| `memory` | `id: text (MemoryID, PK)`, `session_id: text (FK)`, `content: text`, `position: integer`, `time_created: integer`, `time_updated: integer` | `SessionTable` (cascade) | `id` PK, `session_id` NOT NULL + FK, `content` NOT NULL, index on `session_id` |

### Drizzle Schema Definition

```typescript
// src/memory/memory.sql.ts
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/session.sql"
import { Timestamps } from "../storage/schema.sql"
import type { SessionID } from "../session/schema"
import type { MemoryID } from "./schema"

export const MemoryTable = sqliteTable(
  "memory",
  {
    id: text().$type<MemoryID>().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    content: text().notNull(),
    position: integer().notNull(),
    ...Timestamps,
  },
  (table) => [index("memory_session_idx").on(table.session_id)],
)
```

### Branded ID Schema

```typescript
// src/memory/schema.ts
import { Schema } from "effect"
import z from "zod"

export type MemoryID = string & { readonly MemoryID: unique symbol }
export const MemoryID = {
  zod: z.string().meta({ description: "Memory entry ID" }) as unknown as z.ZodType<MemoryID>,
  generate: () => crypto.randomUUID() as MemoryID,
}
```

## Decisions

| Decision                          | Choice                              | Reason                                                    | Alternatives                       | Tradeoffs                                        |
| --------------------------------- | ----------------------------------- | --------------------------------------------------------- | ---------------------------------- | ------------------------------------------------ |
| Separate table vs JSON in session | Separate `MemoryTable`              | Enables individual CRUD, indexing, future features        | JSON column on SessionTable        | Extra table + migration vs simpler single-column |
| Injection in prompt.ts vs llm.ts  | `prompt.ts` system array            | Joins env/skills/instructions naturally; cached with them | `llm.ts` system array manipulation | prompt.ts is higher-level, better semantic fit   |
| Primary-only guard                | Check `agent.mode === "primary"`    | Memory is user-facing context, irrelevant to subagents    | Always inject                      | Subagents don't see memory; extensible later     |
| Position field                    | Integer `position` column           | Preserves user-defined ordering                           | Timestamp-based ordering           | Explicit ordering allows reorder in future       |
| Cascade delete via FK             | `onDelete: "cascade"`               | Memory dies with session automatically                    | Manual cleanup                     | No orphan entries; no extra cleanup code needed  |
| Max entries limit                 | 20 entries cap (enforced in module) | Prevents prompt bloat                                     | Character cap, no limit            | Simple to implement; may need tuning later       |
| Routes nested under session       | `/:sessionID/memory`                | Memory is session-scoped; follows todo pattern            | Separate `/memory` top-level       | Consistent with existing `/:sessionID/todo`      |

## Risks

| Risk                      | Impact                                      | Likelihood | Mitigation                                                   |
| ------------------------- | ------------------------------------------- | ---------- | ------------------------------------------------------------ |
| Schema migration conflict | Merge conflicts with concurrent migrations  | Low        | Single new file, no changes to existing tables               |
| Prompt token bloat        | Excessive memory entries consume context    | Med        | Cap at 20 entries; total content limit ~2000 chars           |
| Stale memory in prompt    | Memory fetched at step start, not real-time | Low        | Acceptable — memory changes between steps are user-initiated |
| Upstream rebase conflict  | Edits to prompt.ts/app.tsx conflict         | Low        | Single-line surgical additions; easy to resolve              |
| DialogSelect empty state  | No entries → edit/delete show empty dialog  | Low        | Show toast "No memory entries" and return early              |

## Test Plan

### Unit Tests

**Memory Module** (`test/memory/memory.test.ts`):

- `create` → inserts entry, returns with ID and position
- `create` → respects 20-entry limit (rejects at cap)
- `list` → returns entries ordered by position
- `update` → modifies content, updates `time_updated`
- `update` → returns error for non-existent ID
- `remove` → deletes entry
- `remove` → returns error for non-existent ID
- Bus events fire on each mutation

**Prompt Injection** (`test/session/prompt-memory.test.ts`):

- Memory entries formatted as `"Session Memory:\n- entry1\n- entry2"`
- Empty memory → no block appended
- Non-primary agent → no memory injected
- Primary agent → memory block present in system array

### Integration Tests

**Clear Immunity** (`test/memory/clear-immunity.test.ts`):

- Create session → add memory → `/clear` (delete all messages) → memory still exists
- Create session → add memory → `/clear-compact` (summarize + delete) → memory still exists
- Delete session → memory cascade-deleted (FK)

**API Routes** (`test/memory/routes.test.ts`):

- Full CRUD cycle via HTTP: create → list → update → list → delete → list
- 404 on invalid sessionID
- 404 on invalid memoryID for update/delete

### End-to-End Tests

- `/memory_add` → type content → verify appears in next prompt's system array
- `/memory_edit` → select entry → modify → verify updated in prompt
- `/memory_delete` → select entry → verify removed from prompt
- Memory persists across multiple `/clear` invocations

### Non-Functional Tests

- Response time: memory CRUD < 50ms (SQLite local, indexed)
- Prompt assembly: memory fetch adds < 5ms overhead
- No security concerns: memory is user-authored, session-scoped, no cross-session access

## File Manifest

### New Files

| File                                          | Purpose                                    |
| --------------------------------------------- | ------------------------------------------ |
| `src/memory/memory.sql.ts`                    | Drizzle schema for MemoryTable             |
| `src/memory/schema.ts`                        | MemoryID branded type                      |
| `src/memory/memory.ts`                        | CRUD module (list, create, update, remove) |
| `src/memory/projectors.ts`                    | SyncEvent projectors for memory events     |
| `src/server/routes/memory.ts`                 | Hono routes for memory API                 |
| `src/cli/cmd/tui/command/memory-commands.tsx` | TUI commands (add/edit/delete)             |
| `migration/<timestamp>_memory/migration.sql`  | Generated migration                        |
| `test/memory/memory.test.ts`                  | Unit tests                                 |
| `test/memory/clear-immunity.test.ts`          | Integration tests                          |

### Existing Files (Surgical Edits)

| File                                  | Change                                                              |
| ------------------------------------- | ------------------------------------------------------------------- |
| `src/session/prompt.ts` (~line 1390)  | Add memory fetch + append to `system` array (3-5 lines)             |
| `src/cli/cmd/tui/app.tsx` (~line 550) | Register memory commands in command list (1 line)                   |
| `src/server/routes/session.ts`        | Mount `MemoryRoutes` sub-router OR add to existing session Hono app |

## Clear Immunity Explanation

`/clear` and `/clear-compact` (in `clear-commands.tsx`) operate exclusively on:

1. `MessageTable` — via `session.deleteMessage` per message
2. `TodoTable` — via `session.clearTodo`
3. Child sessions — via `session.delete` for each child

They never reference or touch `MemoryTable`. Since `MemoryTable` is a separate table with its own FK to `SessionTable`, it is invisible to clear operations. Memory only deletes when the **session itself** is deleted (cascade FK). No code changes needed for clear immunity — it's architectural by default.

## Future Extensibility

**Subagent injection path**: The primary-only guard in `prompt.ts` is a simple `agent.mode === "primary"` check. To extend memory to subagents:

1. Add `memory_scope` field to agent definition (e.g., `"primary" | "all" | "none"`)
2. Change guard to `agent.mode === "primary" || agent.memoryScope === "all"`
3. No schema or API changes needed

**Global memory** (cross-session): Future work could add a `project_id` FK alternative to `session_id`, with a separate `GlobalMemoryTable`. The prompt injection point already has access to project context via `InstanceState.context`.

**Memory categories/tags**: The `position` field and simple `content` text allow future extension to structured entries (JSON content with type/tag fields) without schema migration — just a content format convention.
