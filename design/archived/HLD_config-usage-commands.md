# HLD: /config and /usage Slash Commands

## Tech Stack

| Category  | Technology        | Purpose                                             |
| --------- | ----------------- | --------------------------------------------------- |
| Language  | TypeScript 5.8    | Existing codebase language                          |
| Runtime   | Bun 1.3.11        | Existing runtime                                    |
| Framework | Hono              | REST route handlers with `describeRoute()` metadata |
| Database  | SQLite + Drizzle  | Read-only queries on existing `message` table       |
| TUI       | Solid.js @opentui | Slash command factories + toast display             |
| Schema    | Zod               | Response validation and SDK type generation         |
| Test      | bun:test          | Unit tests for aggregation + flattening logic       |

## Components

| Component        | Responsibility                                      | Dependencies                               |
| ---------------- | --------------------------------------------------- | ------------------------------------------ |
| `Usage` module   | Aggregate per-model usage from message rows         | `Database`, `MessageTable`, `SessionTable` |
| `config-command` | TUI `/config` slash command                         | SDK client, `ToastContext`                 |
| `usage-command`  | TUI `/usage` slash command                          | SDK client, `ToastContext`, route context  |
| `SessionRoutes`  | Hosts `GET /:sessionID/usage` endpoint (1-line add) | `Usage` module                             |
| `ConfigRoutes`   | Hosts `GET /flat` endpoint (1-line add)             | `Config.get()`                             |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          TUI Layer                               │
│                                                                  │
│  /config ──▶ createConfigCommand ──▶ SDK fetch GET /config/flat  │
│  /usage  ──▶ createUsageCommand  ──▶ SDK fetch GET /session/:id/usage │
│                                                                  │
│  Both: format response → toast.show({ variant:"info", ... })     │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Server Routes                             │
│                                                                  │
│  ConfigRoutes (config.ts)                                        │
│    GET /flat → Config.get() → flatten → redact → respond         │
│                                                                  │
│  SessionRoutes (session.ts)                                      │
│    GET /:sessionID/usage → Usage.forSession(id) → respond        │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Usage Module                               │
│                                                                  │
│  Usage.forSession(sessionID)                                     │
│    1. Query MessageTable WHERE session_id = :id                  │
│       Parse data JSON → filter role === "assistant"              │
│    2. Group by (providerID, modelID)                             │
│    3. Sum: cost, tokens.*, (time.completed - time.created)       │
│    4. Query child sessions via parent_id (max 3 levels)          │
│    5. Compute wall duration: last msg time - session time_created│
│    6. Return UsageInfo                                           │
└─────────────────────────────────────────────────────────────────┘
         │                                      │
         ▼                                      ▼
┌──────────────────┐                 ┌──────────────────────┐
│  MessageTable    │                 │  SessionTable        │
│  (existing)      │                 │  (existing)          │
│                  │                 │                      │
│  data.role       │                 │  parent_id           │
│  data.modelID    │                 │  time_created        │
│  data.providerID │                 │  cost (aggregate)    │
│  data.cost       │                 │  tokens_* (aggregate)│
│  data.tokens.*   │                 │                      │
│  data.time.*     │                 │                      │
└──────────────────┘                 └──────────────────────┘
```

**Description**: Two independent features sharing one pattern: server route → domain logic → TUI command → toast. The `/config` path reads merged config and flattens it. The `/usage` path reads message rows from SQLite and aggregates per-model metrics. Both expose via Hono `describeRoute()` so the SDK auto-generates typed clients. TUI commands call SDK and render formatted text in toast.

## Interfaces

### Usage Module (`src/session/usage.ts`)

| Method             | Input                  | Output               | Behavior                                                                               | Errors                                   |
| ------------------ | ---------------------- | -------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------- |
| `Usage.forSession` | `sessionID: SessionID` | `Promise<UsageInfo>` | Queries messages, groups by model, sums cost/tokens/duration, includes subagent rollup | Session not found (404 from route layer) |

**Types**:

```typescript
// src/session/usage.ts

export namespace Usage {
  export const ModelUsage = z.object({
    providerID: z.string(),
    modelID: z.string(),
    cost: z.number(),
    tokens: z.object({
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cache: z.object({
        read: z.number(),
        write: z.number(),
      }),
    }),
    duration: z.number(), // ms of API time
  })
  export type ModelUsage = z.infer<typeof ModelUsage>

  export const Info = z.object({
    total: z.object({
      cost: z.number(),
      tokens: z.object({
        input: z.number(),
        output: z.number(),
        reasoning: z.number(),
        cache: z.object({
          read: z.number(),
          write: z.number(),
        }),
      }),
      duration: z.number(),    // total API duration ms
      wall: z.number(),        // wall clock duration ms
    }),
    byModel: ModelUsage.array(),
    subagents: z.object({
      cost: z.number(),
      tokens: z.object({
        input: z.number(),
        output: z.number(),
        reasoning: z.number(),
        cache: z.object({
          read: z.number(),
          write: z.number(),
        }),
      }),
      count: z.number(),       // number of child sessions
      sessions: z.array(z.object({
        title: z.string(),     // e.g. "@coder subagent" or task description
        cost: z.number(),
      })),                     // per-subagent cost breakdown
    }),
  }).meta({ ref: "SessionUsage" })
  export type Info = z.infer<typeof Info>

  export async function forSession(sessionID: SessionID): Promise<Info> { ... }
}
```

### Config Flat Route (handler in `src/server/routes/config.ts`)

| Method             | Input | Output                                             | Behavior                                                                        | Errors                         |
| ------------------ | ----- | -------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------ |
| `GET /config/flat` | none  | `{ entries: Array<{key: string, value: string}> }` | Flattens `Config.get()` to dot-path keys, redacts secrets, sorts alphabetically | None (config always available) |

**Response schema**:

```typescript
z.object({
  entries: z.array(
    z.object({
      key: z.string(),
      value: z.string(),
    }),
  ),
}).meta({ ref: "ConfigFlat" })
```

### Session Usage Route (handler in `src/server/routes/session.ts`)

| Method                          | Input                  | Output       | Behavior                                             | Errors                                    |
| ------------------------------- | ---------------------- | ------------ | ---------------------------------------------------- | ----------------------------------------- |
| `GET /session/:sessionID/usage` | `param: { sessionID }` | `Usage.Info` | Calls `Usage.forSession()`, returns aggregated usage | 400 (invalid ID), 404 (session not found) |

### Config Command (`src/cli/cmd/tui/command/config-command.tsx`)

| Export                | Signature                                    | Behavior                                                        |
| --------------------- | -------------------------------------------- | --------------------------------------------------------------- |
| `createConfigCommand` | `(deps: ConfigCommandDeps) => CommandOption` | Fetches `/config/flat`, formats two-column text, shows in toast |

```typescript
export type ConfigCommandDeps = {
  sdk: { url: string; fetch: typeof fetch }
  toast: Pick<ToastContext, "show">
  dialog: Pick<DialogContext, "clear">
}

export function createConfigCommand(deps: ConfigCommandDeps): CommandOption
```

### Usage Command (`src/cli/cmd/tui/command/usage-command.tsx`)

| Export               | Signature                                   | Behavior                                                                 |
| -------------------- | ------------------------------------------- | ------------------------------------------------------------------------ |
| `createUsageCommand` | `(deps: UsageCommandDeps) => CommandOption` | Fetches `/session/:id/usage`, formats multi-line summary, shows in toast |

```typescript
export type UsageCommandDeps = {
  sdk: { url: string; fetch: typeof fetch }
  toast: Pick<ToastContext, "show">
  dialog: Pick<DialogContext, "clear">
  route: { data: { type: string; sessionID?: string } }
}

export function createUsageCommand(deps: UsageCommandDeps): CommandOption
```

## Data Flow

### /config Command

| Step | Component            | Action                                       | Next         |
| ---- | -------------------- | -------------------------------------------- | ------------ |
| 1    | TUI `/config`        | User types `/config`, triggers `onSelect`    | SDK fetch    |
| 2    | SDK client           | `GET /config/flat`                           | Config route |
| 3    | Config route handler | `Config.get()` → flatten → redact → sort     | Response     |
| 4    | `config-command.tsx` | Format entries as padded 2-column text       | Toast        |
| 5    | Toast                | Display formatted config (duration: 15000ms) | Done         |

### /usage Command

| Step | Component             | Action                                                       | Next               |
| ---- | --------------------- | ------------------------------------------------------------ | ------------------ |
| 1    | TUI `/usage`          | User types `/usage`, triggers `onSelect`                     | Validate session   |
| 2    | `usage-command.tsx`   | Check `route.data.sessionID` exists                          | SDK fetch          |
| 3    | SDK client            | `GET /session/:sessionID/usage`                              | Session route      |
| 4    | Session route handler | Validate param, call `Usage.forSession(id)`                  | Usage module       |
| 5    | `Usage.forSession`    | Query `MessageTable` for session messages                    | Parse + aggregate  |
| 6    | `Usage.forSession`    | Query child sessions (parent_id), recurse ≤3 levels          | Sum subagent costs |
| 7    | `Usage.forSession`    | Compute wall duration from session timestamps                | Return `Info`      |
| 8    | `usage-command.tsx`   | Format: total cost, duration, per-model breakdown, subagents | Toast              |
| 9    | Toast                 | Display formatted usage (duration: 15000ms)                  | Done               |

**Error Flows**:

- No active session → toast warning "No active session", `dialog.clear()`
- Fetch fails (network/server error) → toast error with message
- Messages with null `time.completed` → skipped in duration calculation

## Data Model

No new tables or schema changes. Reads from existing tables:

| Entity    | Fields Used                                                                    | Relationships       | Constraints                                 |
| --------- | ------------------------------------------------------------------------------ | ------------------- | ------------------------------------------- |
| `message` | `session_id`, `data` (JSON: `{role, modelID, providerID, cost, tokens, time}`) | FK → `session.id`   | Indexed on `(session_id, time_created, id)` |
| `session` | `id`, `parent_id`, `time_created`, `time_updated`, `cost`, `tokens_*`          | `parent_id` self-FK | Indexed on `parent_id`                      |

**Message data JSON structure** (for assistant role):

```typescript
{
  role: "assistant",
  modelID: string,        // e.g. "claude-opus-4-6"
  providerID: string,     // e.g. "anthropic"
  cost: number,           // dollar cost
  tokens: {
    input: number,
    output: number,
    reasoning: number,
    cache: { read: number, write: number }
  },
  time: {
    created: number,      // epoch ms
    completed?: number    // epoch ms (null if interrupted)
  }
}
```

## File Layout

All new files (rebase-safe):

```
packages/opencode/src/
  session/
    usage.ts              ← NEW: Usage.forSession() + types
  cli/cmd/tui/command/
    config-command.tsx     ← NEW: /config slash command factory
    usage-command.tsx      ← NEW: /usage slash command factory + formatters
```

Existing file changes (additive only):

```
packages/opencode/src/
  server/routes/session.ts    ← +1 .get() handler in chain (before closing paren)
  server/routes/config.ts     ← +1 .get() handler in chain (before closing paren)
  cli/cmd/tui/app.tsx          ← +2 imports, +2 spreads in register array
```

Test files:

```
packages/opencode/test/
  session/
    usage.test.ts             ← NEW: unit tests for aggregation
```

## Integration Points — Exact Changes to Existing Files

### `src/server/routes/session.ts`

**Where**: After the last `.post(...)` handler (currently the goal handler ending at line ~1207), before the closing `)` of `lazy()`.

**What**: Add a single `.get()` handler:

```typescript
    .get(
      "/:sessionID/usage",
      describeRoute({
        summary: "Get session usage",
        description: "Get per-model token usage and cost breakdown for a session.",
        operationId: "session.usage",
        responses: {
          200: {
            description: "Session usage breakdown",
            content: {
              "application/json": {
                schema: resolver(Usage.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ sessionID: SessionID.zod })),
      async (c) => {
        const id = c.req.valid("param").sessionID
        const usage = await Usage.forSession(id)
        return c.json(usage)
      },
    )
```

**Import addition** (line 1 area): `import { Usage } from "../../session/usage"`

### `src/server/routes/config.ts`

**Where**: After the last `.get("/providers", ...)` handler (line ~98), before the closing `)` of `lazy()`.

**What**: Add a single `.get()` handler:

```typescript
    .get(
      "/flat",
      describeRoute({
        summary: "Get flat configuration",
        description: "Get merged configuration as flattened key-value pairs with sensitive values redacted.",
        operationId: "config.flat",
        responses: {
          200: {
            description: "Flat config entries",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    entries: z.array(z.object({
                      key: z.string(),
                      value: z.string(),
                    })),
                  }).meta({ ref: "ConfigFlat" }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const config = await Config.get()
        const entries = flattenConfig(config)
        return c.json({ entries })
      },
    )
```

**Helper** (`flattenConfig`) lives in the new `usage.ts` or inline — but to keep config.ts minimal, define `flattenConfig` as a local function within the route file or import from a tiny helper. Given rebase-safety, best to inline it in the route handler or add a `configFlat` helper function at the top of config.ts.

**Alternative (preferred for rebase safety)**: Create `src/config/flat.ts` with the flatten+redact logic, import it in config.ts with one line.

### `src/cli/cmd/tui/app.tsx`

**Imports** (after line 8):

```typescript
import { createConfigCommand } from "@tui/command/config-command"
import { createUsageCommand } from "@tui/command/usage-command"
```

**Registration** (after line 574 — after `createGoalCommand`):

```typescript
    createConfigCommand({ sdk: { url: sdk.url, fetch: sdk.fetch }, toast, dialog }),
    createUsageCommand({ sdk: { url: sdk.url, fetch: sdk.fetch }, toast, dialog, route }),
```

## Decisions

| Decision                                         | Choice                                                                          | Reason                                                                                                                 | Alternatives                           | Tradeoffs                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------- |
| Aggregate in app code, not SQL                   | JS aggregation over raw message rows                                            | Message `data` is JSON blob — can't aggregate with SQL without JSON extraction which is fragile across SQLite versions | Raw SQL with `json_extract`            | Slightly more memory for large sessions but simpler, testable, portable         |
| Flatten config as array of {key,value}           | Array vs. flat object                                                           | Array preserves order (sorted), maps cleanly to two-column display                                                     | `Record<string, string>`               | Array slightly more verbose in JSON but deterministic ordering                  |
| Redact by key name regex                         | `/key\|token\|secret\|password\|credential/i`                                   | Simple, covers common patterns, no false negatives on standard config                                                  | Explicit allowlist                     | May over-redact unusual key names — acceptable for read-only diagnostic display |
| Toast for output (not dialog)                    | Toast with long duration (15000ms)                                              | Consistent with existing commands (memory, goal), non-blocking, auto-dismisses                                         | Modal dialog, log output               | Large configs may exceed toast width — mitigated by 30-line truncation          |
| Subagent recursion cap at 3                      | Hard limit on depth                                                             | Prevents runaway queries on deeply nested task trees                                                                   | Unlimited recursion, single-level only | Misses costs beyond level 3 — negligible in practice                            |
| Format helpers inline in command file            | Co-locate `formatTokens`, `formatCost`, `formatDuration` in `usage-command.tsx` | Single-use helpers, no need for shared util                                                                            | Shared util module                     | If reused later, extract; for now YAGNI                                         |
| Use raw fetch in commands (not SDK typed client) | `deps.sdk.fetch(url)` pattern                                                   | Matches `memory-commands.tsx` pattern exactly — new routes not yet in typed SDK until regeneration                     | SDK typed client                       | After SDK regen, could refactor to typed calls; raw fetch works immediately     |

## Risks

| Risk                                                    | Impact                                    | Likelihood | Mitigation                                                                                                           |
| ------------------------------------------------------- | ----------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------- |
| Toast overflow with large config (>30 lines)            | Truncated display, user misses entries    | Medium     | Truncate after 30 lines, append `(+N more)` suffix                                                                   |
| `time.completed` null on interrupted messages           | Incorrect duration calculation            | Medium     | Skip messages with null `time.completed` in duration sum; if >20% skipped, append `(partial)` note                   |
| Deeply nested subagent trees (>3 levels)                | Missed cost attribution                   | Low        | Cap at 3 levels, note in output if capped                                                                            |
| API key/token leak in `/config/flat`                    | Security issue — sensitive data exposed   | High       | Regex redaction on key patterns before response; test covers known sensitive keys                                    |
| Config.get() returns complex nested objects with arrays | Flattening arrays produces verbose output | Low        | Represent arrays as `key[0]`, `key[1]` or as JSON string for array values                                            |
| Merge conflict in `app.tsx` register array              | Rebase friction                           | Low        | Additive-only spread at end of array — trivial 3-way merge                                                           |
| Large session with 1000+ messages                       | Slow aggregation                          | Low        | All data in single SQLite query (already indexed on session_id); JS aggregation is O(n) — fast for thousands of rows |

## Test Plan

### Unit Tests (`test/session/usage.test.ts`)

**Usage Aggregation**:

- Happy path: 5 messages across 2 models → verify grouping, cost sum, token sums, duration
- Single model: all messages same provider/model → single entry in `byModel`
- No messages: empty session → zeros for all fields
- Null `time.completed`: messages without completion time → excluded from duration, total still correct
- Subagent costs: session with 2 child sessions → `subagents.cost` sums child session costs, `subagents.count` = 2, `subagents.sessions` has 2 entries with title + cost each
- Recursion cap: 4 levels deep → only 3 levels aggregated
- Wall duration: computed from session `time_created` to last message `time.completed`
- Mixed roles: user messages ignored, only assistant messages contribute

**Config Flattening**:

- Flat object: `{a: 1}` → `[{key: "a", value: "1"}]`
- Nested: `{a: {b: 1}}` → `[{key: "a.b", value: "1"}]`
- Redaction: `{api_key: "sk-xxx"}` → `[{key: "api_key", value: "[REDACTED]"}]`
- Non-sensitive pass-through: `{model: "claude"}` → `[{key: "model", value: "claude"}]`
- Sorted output: keys appear alphabetically
- Array values: `{plugins: ["a","b"]}` → `[{key: "plugins[0]", value: "a"}, {key: "plugins[1]", value: "b"}]`
- Null/undefined values: skipped in output

### Integration Tests

| Components                | Verification                                                    | Failure Scenario              |
| ------------------------- | --------------------------------------------------------------- | ----------------------------- |
| Route → Usage module      | `GET /session/:id/usage` returns valid `Usage.Info` shape       | Invalid session ID → 400      |
| Route → Config flatten    | `GET /config/flat` returns sorted entries with redacted secrets | —                             |
| TUI command → SDK → Route | Full round-trip: command fetches, formats, displays             | Network failure → toast error |

### End-to-End Tests (Manual)

1. Start TUI, open session, type `/usage` → toast shows cost breakdown per model
2. Type `/config` → toast shows flattened config with redacted API keys
3. Type `/usage` with no active session → toast shows "No active session" warning
4. Session with subagent tasks → `/usage` includes subagent cost rollup

### Non-Functional

- **Performance**: Usage aggregation for 1000-message session < 50ms (single indexed query + O(n) JS)
- **Security**: All key patterns matching `/key|token|secret|password|credential/i` redacted; tested explicitly
- **Stability**: Read-only queries, no writes, no schema changes — zero risk to app stability or provider caching

## Implementation Sequence

1. `src/session/usage.ts` — pure logic, no external deps needed
2. `src/config/flat.ts` — pure flatten + redact logic (optional; can inline in route)
3. Route handlers in `session.ts` and `config.ts` (1-line additions each + imports)
4. SDK regeneration: `./packages/sdk/js/script/build.ts`
5. `config-command.tsx` and `usage-command.tsx` — TUI commands
6. `app.tsx` — 2 imports + 2 registration lines
7. Tests + typecheck
