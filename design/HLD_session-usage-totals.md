# HLD: Session Usage Totals

## Tech Stack

| Category   | Technology          | Purpose                                    |
| ---------- | ------------------- | ------------------------------------------ |
| Language   | TypeScript 5.8      | Existing codebase language                 |
| Runtime    | Bun 1.3.11          | Runtime + test runner                      |
| ORM        | Drizzle ORM         | SQLite schema, migrations, queries         |
| Database   | SQLite (bun:sqlite) | Local storage, single-writer, sub-ms reads |
| Validation | Zod                 | Session.Info schema (local fork uses Zod)  |
| Framework  | Effect-ts 4.0       | Service composition, migrations            |
| SDK        | OpenAPI + codegen   | Auto-generated client types                |
| TUI        | @opentui/solid      | Cost display components                    |

## Components

| Component              | Responsibility                                      | Dependencies                        |
| ---------------------- | --------------------------------------------------- | ----------------------------------- |
| Migration SQL          | Add 6 columns to session table                      | Drizzle Kit                         |
| SessionTable schema    | Declare new columns in Drizzle schema               | session.sql.ts                      |
| Session.Info (Zod)     | Add cost/tokens to domain type                      | session/index.ts                    |
| fromRow / toRow        | Map flat DB columns ↔ nested Info shape             | session/index.ts                    |
| toPartialRow           | Handle partial updates with new fields              | session/projectors.ts               |
| usage() helper         | Extract cost/tokens from StepFinishPart data        | projectors.ts                       |
| applyUsage() helper    | Increment/decrement session usage columns via SQL   | projectors.ts, SessionTable         |
| PartUpdated projector  | On part upsert: diff old vs new usage, apply delta  | PartTable, SessionTable             |
| PartRemoved projector  | On part delete: subtract usage                      | PartTable, SessionTable             |
| MessageRemoved handler | On message delete: subtract all part usages         | PartTable, SessionTable             |
| Backfill migration     | One-shot SQL: aggregate existing parts → session    | storage/storage.ts or standalone    |
| json-migration patch   | Include cost=0, tokens\_\*=0 in session insert      | storage/json-migration.ts           |
| TUI consumers          | Read session.cost directly instead of reducing msgs | stats.ts, prompt, sidebar, subagent |
| OpenAPI schema         | Add cost + tokens to Session object                 | packages/sdk/openapi.json           |
| SDK codegen            | Regenerate types.gen.ts                             | packages/sdk/js/script/build.ts     |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         TUI / API Layer                          │
│  stats.ts  prompt/index.tsx  sidebar/context.tsx  subagent.tsx   │
│                          │                                       │
│                    reads session.cost / session.tokens            │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│                      Session.Info (Zod)                           │
│  { cost: number, tokens: { input, output, reasoning,             │
│                             cache: { read, write } } }           │
└──────────────────────────┬──────────────────────────────────────┘
                           │ fromRow() / toRow()
┌──────────────────────────▼──────────────────────────────────────┐
│                    SessionTable (Drizzle)                         │
│  + cost REAL NOT NULL DEFAULT 0                                  │
│  + tokens_input INTEGER NOT NULL DEFAULT 0                       │
│  + tokens_output INTEGER NOT NULL DEFAULT 0                      │
│  + tokens_reasoning INTEGER NOT NULL DEFAULT 0                   │
│  + tokens_cache_read INTEGER NOT NULL DEFAULT 0                  │
│  + tokens_cache_write INTEGER NOT NULL DEFAULT 0                 │
└──────────────────────────▲──────────────────────────────────────┘
                           │ applyUsage(db, sessionID, delta, sign)
┌──────────────────────────┴──────────────────────────────────────┐
│                      Projectors (SyncEvent)                       │
│                                                                  │
│  PartUpdated ──► usage(newPart) - usage(oldPart) ──► applyUsage │
│  PartRemoved ──► usage(deletedPart)              ──► applyUsage │
│  MessageRemoved ──► Σ usage(parts)               ──► applyUsage │
└──────────────────────────▲──────────────────────────────────────┘
                           │ StepFinishPart.data.cost / .tokens
┌──────────────────────────┴──────────────────────────────────────┐
│                       PartTable (existing)                        │
│  data JSON: { type: "step-finish", cost, tokens: {...} }         │
└─────────────────────────────────────────────────────────────────┘
```

**Description**: Cost/token data originates in `StepFinishPart` stored in `PartTable.data` JSON. Projectors intercept part lifecycle events (create/update/delete) and incrementally maintain running totals on the session row. TUI reads totals directly from `Session.Info` — no more per-message reduction. A one-shot backfill migration aggregates historical data on first run.

## Interfaces

### Session.Info (Zod schema addition)

| Field              | Type            | Default   | Description              |
| ------------------ | --------------- | --------- | ------------------------ |
| cost               | `z.number()`    | 0         | Total session cost (USD) |
| tokens             | `z.object(...)` | all zeros | Nested token counts      |
| tokens.input       | `z.number()`    | 0         | Input tokens             |
| tokens.output      | `z.number()`    | 0         | Output tokens            |
| tokens.reasoning   | `z.number()`    | 0         | Reasoning tokens         |
| tokens.cache.read  | `z.number()`    | 0         | Cache read tokens        |
| tokens.cache.write | `z.number()`    | 0         | Cache write tokens       |

### SessionTable (new Drizzle columns)

| Column             | Drizzle Type | SQL Type | Constraint         |
| ------------------ | ------------ | -------- | ------------------ |
| cost               | `real()`     | REAL     | NOT NULL DEFAULT 0 |
| tokens_input       | `integer()`  | INTEGER  | NOT NULL DEFAULT 0 |
| tokens_output      | `integer()`  | INTEGER  | NOT NULL DEFAULT 0 |
| tokens_reasoning   | `integer()`  | INTEGER  | NOT NULL DEFAULT 0 |
| tokens_cache_read  | `integer()`  | INTEGER  | NOT NULL DEFAULT 0 |
| tokens_cache_write | `integer()`  | INTEGER  | NOT NULL DEFAULT 0 |

### usage() helper

| Method        | Input                            | Output                                                                            | Behavior                                                                   | Errors              |
| ------------- | -------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------- |
| `usage(part)` | `PartData` (from PartTable.data) | `{ cost: number, tokens: { input, output, reasoning, cache_read, cache_write } }` | If part.type === "step-finish", extract cost/tokens; else return all zeros | None (safe default) |

### applyUsage() helper

| Method                                   | Input                                                                                 | Output | Behavior                                                                                                                        | Errors                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `applyUsage(db, sessionID, value, sign)` | `db`: Drizzle instance, `sessionID`: string, `value`: usage output, `sign`: `1 \| -1` | void   | Executes `UPDATE session SET cost = cost + (sign * value.cost), tokens_input = tokens_input + (sign * value.tokens.input), ...` | FK constraint if session deleted (caught by foreign() helper) |

### fromRow() changes

| Method         | Input                         | Output                          | Behavior                                                                    | Errors |
| -------------- | ----------------------------- | ------------------------------- | --------------------------------------------------------------------------- | ------ |
| `fromRow(row)` | SessionRow (with new columns) | Session.Info (with cost/tokens) | Maps `row.cost` → `info.cost`, `row.tokens_*` → nested `info.tokens` object | None   |

### toRow() changes

| Method        | Input        | Output                         | Behavior                                                                  | Errors |
| ------------- | ------------ | ------------------------------ | ------------------------------------------------------------------------- | ------ |
| `toRow(info)` | Session.Info | Row object (with flat columns) | Flattens `info.cost` → `cost`, `info.tokens.input` → `tokens_input`, etc. | None   |

### toPartialRow() changes

| Method               | Input                     | Output             | Behavior                                                                    | Errors |
| -------------------- | ------------------------- | ------------------ | --------------------------------------------------------------------------- | ------ |
| `toPartialRow(info)` | DeepPartial<Session.Info> | Partial row object | Maps `info.cost` → `cost`, `info.tokens?.input` → `tokens_input` via grab() | None   |

## Data Flow

### Incremental Update (PartUpdated)

| Step | Component             | Action                                                                                   | Next      |
| ---- | --------------------- | ---------------------------------------------------------------------------------------- | --------- |
| 1    | SyncEvent bus         | Emits `MessageV2.Event.PartUpdated` with part data                                       | Projector |
| 2    | PartUpdated projector | Query existing part row from PartTable (if exists)                                       | Step 3    |
| 3    | PartUpdated projector | Compute `oldUsage = usage(existingPart)` (zeros if new)                                  | Step 4    |
| 4    | PartUpdated projector | Upsert part into PartTable (existing logic)                                              | Step 5    |
| 5    | PartUpdated projector | Compute `newUsage = usage(newPart)`                                                      | Step 6    |
| 6    | PartUpdated projector | `applyUsage(db, sessionID, oldUsage, -1)` then `applyUsage(db, sessionID, newUsage, +1)` | Done      |

### Part Removal (PartRemoved)

| Step | Component             | Action                                      | Next      |
| ---- | --------------------- | ------------------------------------------- | --------- |
| 1    | SyncEvent bus         | Emits `MessageV2.Event.PartRemoved`         | Projector |
| 2    | PartRemoved projector | Query part row from PartTable before delete | Step 3    |
| 3    | PartRemoved projector | Compute `oldUsage = usage(part)`            | Step 4    |
| 4    | PartRemoved projector | Delete part from PartTable                  | Step 5    |
| 5    | PartRemoved projector | `applyUsage(db, sessionID, oldUsage, -1)`   | Done      |

### Message Removal (MessageRemoved)

| Step | Component                | Action                                      | Next      |
| ---- | ------------------------ | ------------------------------------------- | --------- |
| 1    | SyncEvent bus            | Emits `MessageV2.Event.Removed`             | Projector |
| 2    | MessageRemoved projector | Query all parts for message from PartTable  | Step 3    |
| 3    | MessageRemoved projector | Sum `usage(part)` for each part             | Step 4    |
| 4    | MessageRemoved projector | `applyUsage(db, sessionID, totalUsage, -1)` | Step 5    |
| 5    | MessageRemoved projector | Delete message (cascade deletes parts)      | Done      |

### TUI Read Path

| Step | Component     | Action                                            | Next    |
| ---- | ------------- | ------------------------------------------------- | ------- |
| 1    | TUI component | Reads session from sync state                     | Step 2  |
| 2    | Session.Info  | Access `session.cost` / `session.tokens` directly | Display |

**Error Flows**:

- **Projector FK failure**: If session was deleted before part event arrives, `foreign()` helper catches SQLITE_CONSTRAINT_FOREIGNKEY → log warning, skip update (existing pattern)
- **Backfill partial failure**: Each session batch is independent; failed batch logged, continues to next
- **Negative totals**: Theoretically impossible with correct sign logic; if detected, backfill can re-aggregate to correct

## Data Model

| Entity                   | Fields                                                                                                                                                    | Relationships                           | Constraints                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------- |
| Session (extended)       | `cost: real`, `tokens_input: integer`, `tokens_output: integer`, `tokens_reasoning: integer`, `tokens_cache_read: integer`, `tokens_cache_write: integer` | Has many Messages → Parts               | NOT NULL DEFAULT 0 on all 6 columns |
| Part (unchanged)         | `data: JSON` containing `{ type, cost?, tokens? }`                                                                                                        | Belongs to Message, Session             | FK to message_id, session_id        |
| StepFinishPart (virtual) | `cost: number`, `tokens: { input, output, reasoning, cache: { read, write } }`                                                                            | Subset of Part where type="step-finish" | None (extracted from JSON)          |

## Decisions

| Decision                       | Choice                                                              | Reason                                                                             | Alternatives                                                           | Tradeoffs                                                       |
| ------------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| Incremental vs. recompute      | Incremental (add/subtract deltas)                                   | O(1) per event vs O(n) full scan; matches upstream pattern                         | Full recompute on each part event                                      | Incremental is faster but requires correct sign accounting      |
| Column types                   | `real` for cost, `integer` for tokens                               | Cost has decimals (USD cents); tokens are always whole numbers                     | All real, or store cost as integer cents                               | Real avoids multiplication/division for display                 |
| Backfill location              | SQL-level aggregation in Drizzle migration or storage.ts MIGRATIONS | No `data-migration.ts` in local fork; MIGRATIONS array is the hook                 | Separate script, application-level iteration                           | SQL json_extract is fastest for bulk; MIGRATIONS auto-runs once |
| Default values                 | NOT NULL DEFAULT 0                                                  | Existing sessions get valid zeros until backfill runs; no nullable handling needed | Nullable columns                                                       | Non-null simplifies all read paths                              |
| Read-before-write in projector | SELECT part before upsert                                           | Need old usage to subtract; SQLite sub-ms reads acceptable                         | RETURNING clause (not available for old value on INSERT...ON CONFLICT) | Extra read per part event; negligible for SQLite                |
| Migration timestamp            | 20260514000000                                                      | After latest local migration (20260511134433); avoids ordering conflicts           | Any timestamp > 20260511134433                                         | None significant                                                |

## Risks

| Risk                            | Impact                                                                        | Likelihood | Mitigation                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------ |
| Snapshot.json divergence        | Drizzle Kit may fail to generate if snapshot doesn't match actual DB state    | Med        | Regenerate snapshot locally via `bun db generate`, don't copy upstream         |
| Negative totals from bugs       | Display shows negative cost (confusing)                                       | Low        | Add floor(0) in TUI display; backfill can correct                              |
| Backfill timeout on large DBs   | First startup after upgrade is slow                                           | Low        | Paginate 100 sessions/batch; use json_extract in SQL (no app-level JSON parse) |
| Part event ordering             | PartUpdated arrives after session deleted                                     | Low        | Existing foreign() guard handles this; log + skip                              |
| Concurrent projector writes     | Two part events for same session race                                         | Very Low   | SQLite single-writer serializes; Drizzle transactions are atomic               |
| json-migration missing defaults | Old JSON sessions imported without cost/tokens columns → constraint violation | Med        | Add `cost: 0, tokens_*: 0` to sessionValues in json-migration.ts               |

## Test Plan

### Unit Tests

**Session schema tests** (`test/session/session-schema.test.ts`):

- Verify `Session.Info` Zod parse succeeds with cost/tokens fields
- Verify `Session.Info` Zod parse succeeds with defaults (cost=0, tokens all zeros)
- Verify `fromRow()` correctly maps flat columns → nested tokens object
- Verify `toRow()` correctly flattens nested tokens → flat columns
- Verify `toPartialRow()` handles partial cost/tokens updates
- Verify `toPartialRow()` omits cost/tokens when not present in input

**usage() helper tests**:

- StepFinishPart with full cost/tokens → correct extraction
- Non-step-finish part (e.g., text, tool-call) → all zeros
- StepFinishPart with missing/null tokens fields → zeros for missing

**applyUsage() helper tests**:

- sign=+1 increments all columns
- sign=-1 decrements all columns
- Zero usage → no-op (still valid SQL, just adds 0)

### Integration Tests

**Projector integration** (requires SQLite in-memory DB):

- PartUpdated with new StepFinishPart → session cost/tokens incremented
- PartUpdated replacing existing StepFinishPart → old subtracted, new added
- PartRemoved for StepFinishPart → session cost/tokens decremented
- MessageRemoved with multiple parts → all part usages subtracted
- PartUpdated for non-step-finish part → session unchanged
- PartUpdated when session already deleted → foreign key caught, no crash

**Backfill integration**:

- Session with multiple StepFinishParts → correct aggregate
- Session with no StepFinishParts → remains at zero
- Partially failed backfill → subsequent run completes remaining

### End-to-End Tests

**TUI display** (manual/snapshot):

- New session: cost shows $0.00 initially
- After assistant response: cost updates to reflect StepFinishPart
- After message deletion: cost decreases appropriately
- Sidebar shows correct per-session cost

**SDK contract**:

- `GET /session/:id` response includes `cost` and `tokens` fields
- Values match what's stored in DB

### Non-Functional Tests

**Performance**:

- Projector overhead: < 1ms additional per PartUpdated event (SQLite read + update)
- Backfill: < 5s for 1000 sessions with ~50 parts each
- TUI render: no reduction loop → faster initial paint for large sessions

**Data integrity**:

- Sum of all StepFinishPart costs in a session == session.cost (invariant check)
- Backfill result matches manual aggregation for sample sessions
