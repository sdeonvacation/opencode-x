# Plan: Session Usage Totals

## Overview

Port upstream commit 36d40fee (Track session usage totals) to the local fork. Adds pre-computed `cost` + `tokens_*` columns to the `session` table, updates them incrementally via projectors on part events, backfills existing sessions via a data migration, and switches TUI cost display from per-message reduction to reading session-level totals.

## Tech Stack

- TypeScript, Bun, Drizzle ORM (SQLite), Zod, Effect-ts
- TUI: @opentui/solid (Solid.js)
- SDK: OpenAPI spec → auto-generated types

## Testing Strategy

- Unit: `bun --cwd packages/opencode test test/session/` — session schema tests, projector tests
- Integration: `bun --cwd packages/opencode test` — full suite, verify no regressions
- Done when: typecheck clean + all existing tests pass + new session has `cost`/`tokens` fields populated

## Phases

### Phase 1: DB Schema (no dependencies)

- Step 1: Add migration `migration/20260514000000_session_usage/migration.sql` (6 ALTER TABLE statements adding `cost` real, `tokens_input/output/reasoning/cache_read/cache_write` integer — all NOT NULL DEFAULT 0)
- Step 2: Add migration snapshot.json (regenerate via `bun --cwd packages/opencode db generate` or adapt from upstream)
- Step 3: Add columns to `session.sql.ts`: `cost` (real, notNull, default 0), `tokens_input/output/reasoning/cache_read/cache_write` (integer, notNull, default 0)

### Phase 2: Session Info Shape (depends on Phase 1)

- Step 1: Add `cost: z.number()` + `tokens: z.object({ input, output, reasoning, cache: { read, write } })` to `Session.Info` zod schema in `session/index.ts` (lines 121-163)
- Step 2: Update `fromRow()` (line 53-85) to map `row.cost` → `info.cost`, `row.tokens_*` → `info.tokens.*`
- Step 3: Update `toRow()` (line 87-109) to flatten `info.cost` → `cost`, `info.tokens.*` → `tokens_*`
- Step 4: Update `toPartialRow()` in `projectors.ts` (line 38-62) to handle partial cost/tokens updates
- Step 5: Set defaults in session creation: `cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }`

### Phase 3: Projector Incremental Updates (depends on Phase 2)

- Step 1: Add `usage()` helper in `projectors.ts` — extracts `{ cost, tokens }` from a `StepFinishPart`
- Step 2: Add `applyUsage(db, sessionID, value, sign)` helper — executes SQL `SET cost = cost + X, tokens_input = tokens_input + Y, ...`
- Step 3: Wire into `PartUpdated` projector (line 116-129): before upsert, read old row; after upsert, subtract old usage + add new usage
- Step 4: Wire into `PartRemoved` projector (line 110-114): read part before delete, subtract its usage
- Step 5: Wire into message removal: iterate parts of deleted message, subtract each usage

### Phase 4: Data Migration Backfill (depends on Phase 1)

- Step 1: Add backfill logic to `storage/storage.ts` MIGRATIONS array (or equivalent local mechanism)
- Step 2: Paginate sessions (100/batch), aggregate cost/tokens from `message.data` JSON via SQL (`json_extract`), update session rows
- Step 3: Update `storage/json-migration.ts` to include `cost: 0, tokens_*: 0` when inserting session rows

### Phase 5: TUI + Stats Display (depends on Phase 2)

- Step 1: `cli/cmd/stats.ts` — read `session.cost`/`session.tokens` directly instead of reducing over messages
- Step 2: `cli/cmd/tui/component/prompt/index.tsx` — read `session.cost` instead of per-message sum
- Step 3: `cli/cmd/tui/feature-plugins/sidebar/context.tsx` — read `session.cost` instead of per-message sum
- Step 4: `cli/cmd/tui/routes/session/subagent-footer.tsx` — read `session.cost` instead of per-message sum
- Step 5: `cli/cmd/tui/plugin/api.tsx` — add `get(sessionID)` to session state API surface
- Step 6: `cli/cmd/tui/context/sync.tsx` — add braces to if-block (upstream formatting fix)

### Phase 6: SDK + OpenAPI (depends on Phase 2)

- Step 1: Add `cost` (number) + `tokens` object to Session schema in `packages/sdk/openapi.json`
- Step 2: Regenerate SDK types: `./packages/sdk/js/script/build.ts`

### Phase 7: Tests + Validation

- Step 1: Update `test/session/session-schema.test.ts` to include `cost`/`tokens` in expected shape
- Step 2: Update `test/fixture/tui-plugin.ts` if session API surface changed
- Step 3: Run `bun --cwd packages/opencode typecheck`
- Step 4: Run `bun --cwd packages/opencode test --timeout 30000`

## Risks

- **Migration timestamp ordering**: Upstream uses `20260510` but local latest is `20260511`. Use `20260514` or later to avoid ordering conflicts.
- **Snapshot.json divergence**: Local schema includes `memory` table (from `20260511` migration) not present in upstream snapshot. Must regenerate snapshot locally via Drizzle, not copy upstream verbatim.
- **Backfill hook location**: Local has no `data-migration.ts`. Must find correct hook in `storage/storage.ts` or create a new one-shot migration in the MIGRATIONS array.
- **Projector complexity**: Adding read-before-write to part projectors increases I/O per event. Acceptable for SQLite (single-writer, sub-ms reads).
- **SDK regen**: `types.gen.ts` is auto-generated — only modify `openapi.json`, never hand-edit types.
