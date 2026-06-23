# HLD: Dream and Distill Self-Improvement

## Summary

Periodic background sessions that consolidate project knowledge ("dream" every 7 days) and extract reusable workflows into skill files ("distill" every 30 days). Triggers on session start when enough time has elapsed, spawning a read-only background subagent that writes to persistent memory or skill files. Feature-flagged, off by default.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    Session Start (prompt.ts)                     │
│                                                                 │
│  User sends first message in top-level session                  │
│       │                                                         │
│       ▼                                                         │
│  DreamTrigger.check(cfg)                                        │
│       │                                                         │
│       ├── shouldAutoDream()  ─── true ──▶ DreamSpawn.dream()    │
│       │                                                         │
│       └── shouldAutoDistill() ─ true ──▶ DreamSpawn.distill()   │
└─────────────────────────────────────────────────────────────────┘
                    │                           │
                    ▼                           ▼
┌──────────────────────────┐    ┌──────────────────────────────┐
│     Dream Subagent       │    │      Distill Subagent        │
│                          │    │                              │
│  Tools: read, glob, grep │    │  Tools: read, glob, grep,   │
│  (NO write/edit/bash)    │    │         write, edit          │
│                          │    │                              │
│  Output: writes to       │    │  Output: creates/updates     │
│  PersistentMemory        │    │  skill files in              │
│  (project type)          │    │  ~/.config/opencode/skills/  │
└──────────────────────────┘    └──────────────────────────────┘
         │                                  │
         ▼                                  ▼
┌──────────────────────────────────────────────────────────────┐
│                    SessionTable (SQLite)                      │
│                                                              │
│  title LIKE 'Auto Dream%' / 'Auto Distill%'                 │
│  → used for last-run detection via time_created query        │
└──────────────────────────────────────────────────────────────┘
```

## Components

### Component 1: AutoDream Logic Module

- **File**: `src/session/auto-dream.ts`
- **Type**: Pure Module
- **Exports**: `shouldAutoDream`, `shouldAutoDistill`, constants, prompt strings
- **Dependencies**: `Database`, `SessionTable`, `Config`, `Flag`
- **Interface**:

  ```typescript
  export namespace AutoDream {
    const DAY_MS = 86_400_000
    const DEFAULT_DREAM_INTERVAL_DAYS = 7
    const DEFAULT_DISTILL_INTERVAL_DAYS = 30
    const MIN_SPAWN_GAP_MS = 10_000

    const AUTO_DREAM_TITLE = "Auto Dream"
    const AUTO_DISTILL_TITLE = "Auto Distill"

    function shouldAutoDream(cfg: Config.Info): boolean
    function shouldAutoDistill(cfg: Config.Info): boolean
  }
  ```

### Component 2: Dream Spawn Orchestration

- **File**: `src/session/dream-spawn.ts`
- **Type**: Pure Module
- **Exports**: `dream`, `distill`
- **Dependencies**: `Session`, `spawnSubagent`, `Agent`, `Config`
- **Interface**:
  ```typescript
  export namespace DreamSpawn {
    function dream(parentID: SessionID, cfg: Config.Info): Promise<void>
    function distill(parentID: SessionID, cfg: Config.Info): Promise<void>
  }
  ```

### Component 3: Dream Trigger Hook

- **File**: `src/session/dream-trigger.ts`
- **Type**: Pure Module
- **Exports**: `check`
- **Dependencies**: `AutoDream`, `DreamSpawn`, `Config`
- **Interface**:
  ```typescript
  export namespace DreamTrigger {
    function check(input: { sessionID: SessionID; cfg: Config.Info }): Promise<void>
  }
  ```

### Component 4: Dream Agent Definition

- **File**: `src/agent/agent.ts` (additive entries in `agents` record)
- **Type**: Agent definition (inline, like `compaction`/`explore`)
- **Exports**: None (consumed via `Agent.Service.get("dream")`)
- **Dependencies**: `Permission`, `PROMPT_DREAM`, `PROMPT_DISTILL`
- **Interface**:

  ```typescript
  // Added to agents record in Agent.state:
  dream: {
    name: "dream",
    mode: "subagent",
    native: true,
    hidden: true,
    prompt: PROMPT_DREAM,
    permission: Permission.merge(defaults, Permission.fromConfig({
      "*": "deny",
      read: "allow",
      glob: "allow",
      grep: "allow",
      memory_persist: "allow",
    }), user),
    options: {},
  }

  distill: {
    name: "distill",
    mode: "subagent",
    native: true,
    hidden: true,
    prompt: PROMPT_DISTILL,
    permission: Permission.merge(defaults, Permission.fromConfig({
      "*": "deny",
      read: "allow",
      glob: "allow",
      grep: "allow",
      write: "allow",
      edit: "allow",
      memory_persist: "allow",
      external_directory: { [skillDir]: "allow" },
    }), user),
    options: {},
  }
  ```

### Component 5: Agent Prompts

- **File**: `src/agent/prompt/dream.txt`
- **File**: `src/agent/prompt/distill.txt`
- **Type**: Text prompt files (imported as string)
- **Exports**: Imported by agent definitions
- **Dependencies**: None

### Component 6: Config Schema Additions

- **File**: `src/config/config.ts` (additive to existing schema)
- **Type**: Schema extension
- **Exports**: Part of `Config.Info` type
- **Dependencies**: Zod

### Component 7: Feature Flag

- **File**: `src/flag/flag.ts` (additive)
- **Type**: Flag constant
- **Exports**: `OPENCODE_EXPERIMENTAL_DREAM`
- **Dependencies**: `enabledByExperimental` pattern

## Data Flow

### Dream Trigger Flow

| Step | Component                   | Action                                                      | Next                      |
| ---- | --------------------------- | ----------------------------------------------------------- | ------------------------- |
| 1    | `prompt.ts`                 | First user message in top-level session detected            | DreamTrigger.check        |
| 2    | `DreamTrigger.check`        | Load config, check flag enabled                             | AutoDream.shouldAutoDream |
| 3    | `AutoDream.shouldAutoDream` | Check in-process debounce timestamp                         | Query DB                  |
| 4    | `AutoDream.shouldAutoDream` | Query SessionTable for latest session titled "Auto Dream"   | Compare time              |
| 5    | `AutoDream.shouldAutoDream` | Check if `time_created` of last run > interval days ago     | Return boolean            |
| 6    | `AutoDream.shouldAutoDream` | Check project age (oldest session > interval)               | Return boolean            |
| 7    | `DreamTrigger.check`        | If true, call `DreamSpawn.dream(sessionID, cfg)`            | Spawn                     |
| 8    | `DreamSpawn.dream`          | Call `spawnSubagent` with dream agent, background mode      | Background session        |
| 9    | Dream subagent              | Reviews recent sessions, consolidates into PersistentMemory | Done                      |

### Distill follows same pattern with 30d interval and skill-file output.

## Database Schema

No new tables. Uses existing `SessionTable` for last-run tracking via `title` column matching.

```typescript
// Query pattern (within auto-dream.ts):
Database.use((db) =>
  db
    .select({ time_created: SessionTable.time_created })
    .from(SessionTable)
    .where(like(SessionTable.title, `${AUTO_DREAM_TITLE}%`))
    .orderBy(desc(SessionTable.time_created))
    .limit(1)
    .all(),
)
```

Project age check:

```typescript
Database.use((db) =>
  db
    .select({ time_created: SessionTable.time_created })
    .from(SessionTable)
    .orderBy(asc(SessionTable.time_created))
    .limit(1)
    .all(),
)
```

## Configuration

```typescript
// Added to top-level config schema (alongside existing compaction, provider, etc.):
dream: z.object({
  auto: z.boolean().optional().describe("Enable automatic dream consolidation"),
  interval_days: z.number().int().positive().optional()
    .describe("Days between dream runs (default: 7)"),
}).optional(),

distill: z.object({
  auto: z.boolean().optional().describe("Enable automatic distill skill extraction"),
  interval_days: z.number().int().positive().optional()
    .describe("Days between distill runs (default: 30)"),
}).optional(),
```

Config values merge with defaults:

- `dream.auto` defaults to `true` (when flag enabled)
- `dream.interval_days` defaults to `7`
- `distill.auto` defaults to `true` (when flag enabled)
- `distill.interval_days` defaults to `30`

## Feature Flag

| Item                    | Value                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| Flag name               | `OPENCODE_EXPERIMENTAL_DREAM`                                                                                |
| Pattern                 | `enabledByExperimental("OPENCODE_EXPERIMENTAL_DREAM")`                                                       |
| Experimental config key | `experimental.dream_and_distill`                                                                             |
| Config schema addition  | `dream_and_distill: z.boolean().optional().describe("Enable dream/distill self-improvement")`                |
| Default                 | `false`                                                                                                      |
| Enable                  | `OPENCODE_EXPERIMENTAL=true` or `OPENCODE_EXPERIMENTAL_DREAM=true` or `experimental.dream_and_distill: true` |

Gating behavior: `DreamTrigger.check` exits early (no-op) when flag is off.

## Integration Points

| Location          | File                              | How                                                                                                                                                 |
| ----------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trigger call site | `src/session/prompt.ts`           | Add call to `DreamTrigger.check()` after first user message detection in top-level session, fire-and-forget (no await blocking the prompt response) |
| Agent definitions | `src/agent/agent.ts`              | Add `dream` and `distill` entries to `agents` record inside `InstanceState.make`                                                                    |
| Config schema     | `src/config/config.ts`            | Add `dream` and `distill` optional objects to top-level schema; add `dream_and_distill` to experimental object                                      |
| Flag              | `src/flag/flag.ts`                | Add `OPENCODE_EXPERIMENTAL_DREAM` using `enabledByExperimental`                                                                                     |
| Spawn mechanism   | `src/orchestration/task-spawn.ts` | Use existing `spawnSubagent` (no modifications needed)                                                                                              |
| Memory output     | `src/memory/persistent.ts`        | Dream agent uses existing `PersistentMemory.write()` via `memory_persist` tool                                                                      |
| Skill output      | `~/.config/opencode/skills/`      | Distill agent writes skill files via `write`/`edit` tools                                                                                           |

## Error Handling

| Scenario                    | Handling                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------- |
| Flag disabled               | `DreamTrigger.check` returns immediately, no-op                                         |
| DB query fails              | Catch in `shouldAutoDream`/`shouldAutoDistill`, return `false` (fail-safe: don't spawn) |
| Spawn fails (limit reached) | `spawnSubagent` throws `SpawnLimitError`, caught and logged, parent session unaffected  |
| Dream subagent errors       | Independent child session; errors isolated; no parent session impact                    |
| Concurrent triggers         | Module-level `let lastDreamSpawnTime` prevents double-spawn within 10s window           |
| Cross-restart duplicates    | Title-based DB query prevents re-spawn if last run is within interval                   |
| Young project               | Skip if oldest session < interval days old                                              |

**Fallback behavior**: All failures result in "don't dream/distill" — never blocks or disrupts normal session flow.

## Constraints

- **Upstream-rebase safe**: All changes are additive — new files (`auto-dream.ts`, `dream-spawn.ts`, `dream-trigger.ts`, prompt txts), new optional config fields (`.optional()`), no existing function signatures modified
- **Provider cache**: Dream/distill sessions are independent child sessions with separate message histories — zero mutation to parent session cache keys or message arrays
- **Performance**: Trigger check is synchronous DB read (single indexed query) + timestamp comparison — sub-millisecond. Spawn is fire-and-forget, non-blocking. No impact on session start latency beyond the single query.

## Decisions

| Decision                 | Choice                              | Reason                                                                        | Alternatives                | Tradeoffs                                                                    |
| ------------------------ | ----------------------------------- | ----------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------- |
| No new table             | Use SessionTable title for tracking | Avoids migration, matches existing pattern (compaction uses session metadata) | Dedicated `dream_run` table | Simpler, fewer migrations; title-matching is slightly fragile but sufficient |
| Module-level debounce    | `let lastSpawnTime` in-memory       | Prevents rapid re-triggers within single process lifetime                     | DB-based lock               | Simpler; cross-restart deduplication handled by DB query                     |
| Fire-and-forget spawn    | Don't await dream/distill result    | Must never block user session                                                 | Await + timeout             | Zero latency impact; downside is no error surfacing to user                  |
| Read-only dream agent    | No write/edit/bash tools            | Safety — dream should only observe and write memory                           | Full tool access            | Limits dream power but prevents accidental mutations                         |
| Distill gets write       | Needs to create skill files         | Skills are `.md` files on disk                                                | Memory-only output          | Must write to be useful                                                      |
| Existing `spawnSubagent` | Reuse orchestration infra           | Gets spawn limits, depth tracking, bus events for free                        | Custom spawn                | Consistency with task tool behavior                                          |

## Risks

| Risk                                              | Impact                                               | Likelihood | Mitigation                                                                                                                      |
| ------------------------------------------------- | ---------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Cost runaway from unbounded dream sessions        | Unexpected API charges                               | Low        | `experimental.subagent_timeout` caps execution time; dream has no write tools to loop                                           |
| Stale/wrong memory from hallucinating dream agent | Bad persistent memories pollute future sessions      | Medium     | Dream agent prompt explicitly says "only consolidate facts from actual sessions"; project-type memories can be manually deleted |
| Distill writes broken skill files                 | Bad skills degrade agent performance                 | Low        | Distill agent gets thorough prompt with skill format spec; user can delete bad skills                                           |
| Title collision                                   | Non-dream session titled "Auto Dream..." causes skip | Very Low   | Use distinctive prefix unlikely in user titles                                                                                  |
| Flag interaction with existing experimental flags | Unexpected behavior                                  | Low        | Independent flag, no coupling to other experimental features                                                                    |

## Test Plan

### Unit Tests (`test/session/auto-dream.test.ts`)

| Scenario                                                       | Expected                    |
| -------------------------------------------------------------- | --------------------------- |
| `shouldAutoDream` returns `false` when flag disabled           | No spawn                    |
| `shouldAutoDream` returns `false` when project < 7 days old    | No spawn                    |
| `shouldAutoDream` returns `false` when last dream < 7 days ago | No spawn                    |
| `shouldAutoDream` returns `true` when all conditions met       | Spawn eligible              |
| In-process debounce prevents double-call within 10s            | Second call returns `false` |
| Custom `interval_days` config overrides default                | Respects user config        |
| `shouldAutoDistill` same matrix with 30d interval              | Mirrors dream logic         |

### Integration Tests (`test/session/dream-spawn.test.ts`)

| Scenario                                              | Expected                                      |
| ----------------------------------------------------- | --------------------------------------------- |
| Insert fixture sessions aged > 7d, trigger check      | Creates child session with "Auto Dream" title |
| Insert recent dream session (< 7d ago), trigger check | No new session created                        |
| Full dream → spawn → session exists in DB             | Validates end-to-end flow                     |
| Spawn respects `maxDepth`/`maxDescendants` limits     | SpawnLimitError when exceeded                 |

### Non-Functional

| Concern   | Requirement                                        |
| --------- | -------------------------------------------------- |
| Latency   | Trigger check < 5ms (single indexed DB query)      |
| Safety    | Dream agent cannot write/edit/execute bash         |
| Isolation | Dream/distill session failure never affects parent |
| Cost      | Bounded by `subagent_timeout` (default 15min)      |
