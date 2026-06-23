# Plan: Dream and Distill Self-Improvement

## Overview

Periodic background sessions that automatically consolidate project knowledge (dream: weekly) and extract reusable workflows into skills (distill: monthly). Triggers on session start when enough time has elapsed, spawning a read-only background subagent that writes to persistent memory or skill files.

## Tech Stack

- TypeScript 5.8, Bun 1.3.11
- Effect-ts 4.0.0-beta (Effect.gen, Effect.fn, Effect.sync)
- drizzle-orm + bun:sqlite for last-run tracking
- Existing: `spawnSubagent`, `PersistentMemory`, `SessionTable`, `Config`

## Testing Strategy

- Unit: `shouldAutoDream`/`shouldAutoDistill` interval logic, project-age check, spawn-gap debounce
- Integration: full trigger → spawn flow with fixture sessions at various ages
- Done when: auto-dream fires after 7d gap, auto-distill after 30d, neither fires on young project or recent run, flag disables both

## Phases

### Phase 1: Config + Flag

- Step 1: Add `dream_and_distill` flag to `src/config/config.ts` experimental section (boolean, default false)
- Step 2: Add `OPENCODE_EXPERIMENTAL_DREAM` to `src/flag/flag.ts` using `enabledByExperimental` pattern
- Step 3: Add optional top-level config section for interval overrides:
  ```
  dream?: { auto?: boolean; interval_days?: number }
  distill?: { auto?: boolean; interval_days?: number }
  ```

### Phase 2: Core Module

- Step 1: Create `src/session/auto-dream.ts` — pure logic module exporting:
  - Constants: `DAY_MS`, `DEFAULT_DREAM_INTERVAL_DAYS` (7), `DEFAULT_DISTILL_INTERVAL_DAYS` (30), `MIN_SPAWN_GAP_MS` (10000)
  - `AUTO_DREAM_TITLE`, `AUTO_DISTILL_TITLE` (session title markers for DB lookup)
  - `DREAM_TASK` / `DISTILL_TASK` prompt strings
  - `shouldAutoDream(cfg)` → `Effect.Effect<boolean>` — checks flag, debounce, queries `SessionTable` for last run by title, checks project age
  - `shouldAutoDistill(cfg)` → `Effect.Effect<boolean>` — same pattern, 30d interval
- Step 2: Internal `shouldAutoRun` helper using `Database.use` to query `SessionTable` (match existing `eq`/`desc`/`asc`/`isNull` patterns)
- Step 3: Module-level `let lastDreamSpawnTime`/`lastDistillSpawnTime` for in-process debounce

### Phase 3: Spawn Integration

- Step 1: Create `src/session/dream-spawn.ts` — orchestration glue:
  - `spawnDream(parentSessionID, cfg)` — calls `spawnSubagent` with a dream-specific agent config, `DREAM_TASK` prompt, background mode
  - `spawnDistill(parentSessionID, cfg)` — same for distill
  - Uses existing `Agent.Info` shape with `mode: "subagent"`
- Step 2: Wire into session start hook — add call site in `src/session/prompt.ts` or new file `src/session/dream-trigger.ts` that:
  - On first user message in a top-level session, checks `shouldAutoDream` + `shouldAutoDistill`
  - If true, spawns background session via `spawnDream`/`spawnDistill`
  - Purely additive: new function called from existing code, not replacing any logic

### Phase 4: Agent Definition

- Step 1: Add `dream` agent entry to agent definitions (or create `src/agent/dream.ts` if agents are file-based)
  - Read-only tools only: bash (read-only), read, glob, grep
  - System prompt instructing consolidation into persistent memory
  - No write/edit tools — safety constraint
- Step 2: Add `distill` agent entry — same tools plus write (for creating skill files)

### Phase 5: Tests

- Step 1: Create `test/session/auto-dream.test.ts`:
  - Test `shouldAutoDream` returns false when flag off
  - Test returns false when project < 7 days old
  - Test returns false when last dream < 7 days ago
  - Test returns true when conditions met
  - Test spawn-gap debounce prevents rapid re-triggers
- Step 2: Integration test: insert fixture sessions, verify trigger fires and creates child session with correct title

## Risks/Edge cases

- **Concurrent triggers**: Module-level timestamp debounce prevents double-spawn within same process; title-based DB check prevents cross-restart duplicates
- **Empty project**: Project-age guard skips dream/distill if no sessions older than interval
- **Cost runaway**: Background sessions use subagent timeout (`experimental.subagent_timeout`) as safety cap; dream agent has no write tools
- **Upstream rebase safety**: All new files, config additions are additive optional fields with `.optional()`, no existing signatures modified
- **Provider caching**: Dream/distill sessions are independent child sessions — no mutation to parent session message history or cache keys
- **Flag off by default**: Ships disabled; users opt-in via `experimental.dream_and_distill: true` or env var
