# Plan: /config and /usage Slash Commands

## Overview

Add two native slash commands (`/config`, `/usage`) that display merged configuration and per-model session usage in TUI toasts. Replaces the external tokenscope plugin for quick usage checks. No DB schema changes — all data already exists in message rows.

## Tech Stack

- TypeScript, Bun, Effect-ts
- TUI: @opentui/solid (Solid.js), Toast system
- Database: Drizzle ORM + SQLite (read-only queries, no schema changes)
- Server: Hono routes with `describeRoute()` (auto-generates OpenAPI)

## Testing Strategy

- Unit: `bun --cwd packages/opencode test test/session/` — usage aggregation logic
- Integration: TUI manual test — `/config` shows key-values, `/usage` shows per-model breakdown
- Done when: typecheck clean + both commands render correct data in toasts

## Rebase Safety

| Change Type     | File                                                          | Risk           |
| --------------- | ------------------------------------------------------------- | -------------- |
| New file        | `src/session/usage.ts`                                        | None           |
| New file        | `src/cli/cmd/tui/command/config-command.tsx`                  | None           |
| New file        | `src/cli/cmd/tui/command/usage-command.tsx`                   | None           |
| 1-line addition | `src/server/routes/session.ts` — add usage handler            | Low (additive) |
| 1-line addition | `src/server/routes/config.ts` — add flat dump handler         | Low (additive) |
| 2-line addition | `src/cli/cmd/tui/app.tsx` — import + spread in register array | Low (additive) |
| Auto-generated  | `packages/sdk/openapi.json` — regenerated from route metadata | None           |

**Strategy**: All logic lives in new files. Existing files get only additive 1-2 line insertions (imports + registrations). OpenAPI spec auto-regenerates from `describeRoute()` metadata — never hand-edited.

## Phases

### Phase 1: Server — Usage Aggregation (no dependencies)

- Step 1: Create `src/session/usage.ts` — `Usage.forSession(sessionID)` Effect function
  - Query assistant messages grouped by `(providerID, modelID)` — both fields already stored per-message
  - For each group: sum `cost`, `tokens.input/output/reasoning/cache.read/write`
  - Compute API duration per group: sum of `(time.completed - time.created)` for assistant messages where both timestamps exist
  - Return `{ total: { cost, tokens, duration }, byModel: [{ providerID, modelID, cost, tokens, duration }] }`
- Step 2: Include subagent costs — query child sessions via `parent_id` column, recursively aggregate their message costs into `subagents: { cost, tokens, count }` field. Cap recursion at 3 levels.
- Step 3: Wall duration = `last_message.time.completed - session.time_created`
- Step 4: Add handler in `src/server/routes/session.ts` — `GET /:sessionID/usage` with `describeRoute()` metadata. Single line addition in route chain.

### Phase 2: Server — Config Flat Dump (no dependencies)

- Step 1: Add handler in `src/server/routes/config.ts` — `GET /config/flat` with `describeRoute()` metadata. Single line addition in route chain.
- Step 2: Implementation: call `Config.get()`, flatten nested object to `{ "dot.path.key": value }` map
- Step 3: Redact sensitive values — any key matching `/key|token|secret|password|credential/i` gets value replaced with `"[REDACTED]"`
- Step 4: Return `{ entries: [{ key: string, value: string }] }` sorted alphabetically

### Phase 3: SDK Regeneration (depends on Phase 1 + 2)

- Step 1: Run `./packages/sdk/js/script/build.ts` — auto-generates `openapi.json` + typed client from route `describeRoute()` metadata
- Step 2: No manual openapi.json edits needed (it's auto-generated from Hono route definitions)

### Phase 4: TUI — /config Command (depends on Phase 2 + 3)

- Step 1: Create `src/cli/cmd/tui/command/config-command.tsx` — export `createConfigCommand(deps)` factory
- Step 2: `onSelect`: fetch `GET /config/flat` via SDK client, format as aligned two-column text:
  ```
  model                      claude-sonnet-4-20250514
  theme                      dark
  experimental.goal_system   true
  providers.anthropic        [REDACTED]
  ...
  ```
- Step 3: Show in toast (info type, long duration/persistent)
- Step 4: Add import + `...createConfigCommand({...})` spread in `app.tsx` register array (2 lines)

### Phase 5: TUI — /usage Command (depends on Phase 1 + 3)

- Step 1: Create `src/cli/cmd/tui/command/usage-command.tsx` — export `createUsageCommand(deps)` factory
- Step 2: `onSelect`: fetch `GET /session/:sessionID/usage` via SDK client, format as:

  ```
  Session
  Total cost:            $X.XX
  Total duration (API):  Xh Xm Xs
  Total duration (wall): Xd Xh Xm

  Usage by model:
    claude-opus-4-6:    Xk input, Xk output, Xm cache read, Xm cache write ($X.XX)
    claude-sonnet-4-6:  Xk input, Xk output, Xm cache read, Xm cache write ($X.XX)

  Subagents:             $X.XX (N sessions)
    @coder (HLD impl):       $X.XX
    @coder (tests):          $X.XX
    @explore (find auth):    $X.XX
  ```

- Step 3: Number formatting helpers in same file: `formatTokens(n)` (k/m suffixes), `formatCost(n)` ($X.XX), `formatDuration(ms)` (Xh Xm Xs)
- Step 4: Show in toast (info type, long duration/persistent)
- Step 5: Add import + `...createUsageCommand({...})` spread in `app.tsx` register array (2 lines)

### Phase 6: Tests + Validation

- Step 1: Unit test `test/session/usage.test.ts` for aggregation logic — messages with different models, verify grouping + arithmetic
- Step 2: Unit test for config flattening + redaction logic
- Step 3: Run `bun --cwd packages/opencode typecheck`
- Step 4: Run `bun --cwd packages/opencode test --timeout 30000`

## Risks

| Risk                                          | Mitigation                                            |
| --------------------------------------------- | ----------------------------------------------------- |
| Toast overflow with large config              | Truncate after 30 lines, append "(+N more)"           |
| `time.completed` null on interrupted messages | Skip in duration calc, note "partial" if >20% missing |
| Deeply nested subagent trees slow to traverse | Cap recursion at 3 levels                             |
| API key leak in /config                       | Regex redaction on key name patterns before response  |
| Merge conflict in app.tsx register array      | Additive-only spread at end of array — trivial merge  |
| Merge conflict in route files                 | Single `.get()` handler addition — trivial merge      |
