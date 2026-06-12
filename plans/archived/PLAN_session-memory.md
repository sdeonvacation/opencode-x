# Plan: Session Memory

## Overview

Persistent per-session memory that users manage via `/memory_add`, `/memory_edit`, `/memory_delete` commands. Memory entries survive `/clear` and `/clear-compact`, get injected into primary agent's system prompt only, and use the same non-blocking dialog pattern as `/btw`.

## Tech Stack

- SQLite via drizzle-orm (new `MemoryTable`)
- Solid.js TUI (dialog commands)
- Effect-ts (service layer)
- Existing SDK client pattern (new API routes)

## Testing Strategy

- Unit: Memory CRUD operations, prompt injection logic
- Integration: Memory survives clear/compact, memory appears in system prompt, commands open/close correctly
- Done when: Memory persists across clears, shows in primary agent prompt, CRUD commands work

## Phases

### Phase 1: Storage Layer

- Step 1: Create `src/memory/memory.sql.ts` with `MemoryTable` (id, session_id FK cascade, content, position, timestamps)
- Step 2: Generate migration
- Step 3: Create `src/memory/memory.ts` module — CRUD operations (list, create, update, remove) using `Database.use()`/`Database.transaction()` + sync events

### Phase 2: API Routes

- Step 1: Add memory routes to server (`memory.list`, `memory.create`, `memory.update`, `memory.delete`)
- Step 2: Wire into SDK client type definitions

### Phase 3: Prompt Injection

- Step 1: In `prompt.ts` runLoop, after instructions are loaded, fetch memory entries for session
- Step 2: Append as labeled block to system array (only when agent mode is "primary")
- Step 3: Format: `"Session Memory:\n- entry1\n- entry2\n..."`

### Phase 4: TUI Commands

- Step 1: `/memory_add` — `DialogPrompt.show()` → textarea → call `memory.create` → toast confirmation
- Step 2: `/memory_edit` — `DialogSelect` to pick entry → `DialogPrompt.show()` prefilled → call `memory.update`
- Step 3: `/memory_delete` — `DialogSelect` to pick entry → call `memory.delete` → toast confirmation
- Step 4: Register all three in `app.tsx` command list

### Phase 5: Clear Immunity

- Step 1: Verify `/clear` and `/clear-compact` don't touch `MemoryTable` (they shouldn't — they only delete messages/todos/children)
- Step 2: Add integration test confirming memory survives both clear operations

## Risks

- **Schema migration conflicts**: Mitigation — minimal table, single migration file, no FK changes to existing tables
- **Prompt bloat**: Mitigation — consider max memory entries limit (e.g., 20) or total character cap
- **Future subagent injection**: Mitigation — injection point parameterized by agent mode check, easy to extend later
- **Upstream rebase safety**: Mitigation — new files only (`memory.sql.ts`, `memory.ts`, `memory-commands.tsx`), surgical single-line additions to `prompt.ts` and `app.tsx`
