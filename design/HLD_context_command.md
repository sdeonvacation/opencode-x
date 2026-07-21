# HLD: /context Command

## Tech Stack

| Category  | Technology          | Purpose                                     |
| --------- | ------------------- | ------------------------------------------- |
| Language  | TypeScript + Effect | Server-side data assembly with Effect-ts    |
| Framework | Hono                | HTTP route (`GET /session/:id/context`)     |
| UI        | Solid-js + @opentui | TUI dialog rendering (scrollable breakdown) |
| Heuristic | chars/4             | Token estimation without model-specific BPE |

## Components

| Component             | Responsibility                                      | Dependencies                                                                 |
| --------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------- |
| `ContextUsage`        | Assemble token estimates per category for a session | Provider, ToolRegistry, MCP, Skill, PersistentMemory, Agent, MessageV2, Goal |
| Session Route         | Expose `GET /session/:sessionID/context` endpoint   | ContextUsage, Session                                                        |
| `context-command.tsx` | TUI command: fetch data, render dialog              | SDK (fetch), Dialog, Toast, Route context                                    |

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  TUI (context-command.tsx)                                │
│  ┌─────────────┐   fetch    ┌──────────────────────────┐ │
│  │ /context cmd │──────────▶│ GET /session/:id/context  │ │
│  └─────────────┘            └────────────┬─────────────┘ │
│                                          │               │
│                              ┌───────────▼────────────┐  │
│                              │    ContextUsage.get()   │  │
│                              └───────────┬────────────┘  │
│                                          │               │
│         ┌────────────────────────────────┼───────────┐   │
│         │            Parallel assembly   │           │   │
│   ┌─────▼──┐ ┌──────▼───┐ ┌─────▼────┐ ┌───▼────┐  │   │
│   │Provider│ │ToolRegist │ │   MCP    │ │Messages│  │   │
│   │ .model │ │  .tools() │ │ .tools() │ │filtered│  │   │
│   └────────┘ └───────────┘ └──────────┘ └────────┘  │   │
│   ┌────────┐ ┌───────────┐ ┌──────────┐ ┌────────┐  │   │
│   │ Skills │ │ Memory    │ │  Agents  │ │  Goal  │  │   │
│   │activated│ │persistent │ │  custom  │ │  text  │  │   │
│   └────────┘ └───────────┘ └──────────┘ └────────┘  │   │
│         └────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

Description: TUI command triggers HTTP fetch. Route delegates to `ContextUsage.get()` which assembles estimates from multiple subsystems in parallel where possible (tools, skills, memory are independent). Each category's char-count is divided by 4 to estimate tokens. Response includes the model's context window limit for percentage calculations.

## Interfaces

### ContextUsage (new: `src/session/context-usage.ts`)

| Method | Input                  | Output              | Behavior                                                                    | Errors                                |
| ------ | ---------------------- | ------------------- | --------------------------------------------------------------------------- | ------------------------------------- |
| `get`  | `sessionID: SessionID` | `ContextUsage.Info` | Resolves model, assembles all category token estimates, computes free space | Session not found, model not resolved |

### Response Schema (`ContextUsage.Info`)

```typescript
namespace ContextUsage {
  type CategoryItem = {
    name: string
    tokens: number
    source?: string // e.g. "mcp__server__tool", "user", "plugin"
  }

  type Category = {
    name: string
    tokens: number
    items?: CategoryItem[] // sub-items (individual tools, skills, memory entries)
  }

  type Info = {
    model: {
      providerID: string
      modelID: string
      name: string
      contextLimit: number // from Provider.Model.limit.context
    }
    total: number // sum of all category tokens
    free: number // contextLimit - total (clamped to 0)
    categories: Category[] // ordered: system, instructions, tools, mcp, agents, memory, skills, messages, hooks
  }
}
```

### Session Route (addition to `src/server/routes/session.ts`)

| Method                    | Input                  | Output                     | Behavior                            | Errors                                    |
| ------------------------- | ---------------------- | -------------------------- | ----------------------------------- | ----------------------------------------- |
| `GET /:sessionID/context` | `param: { sessionID }` | `ContextUsage.Info` (JSON) | Calls `ContextUsage.get(sessionID)` | 400 (invalid ID), 404 (session not found) |

### TUI Command (`context-command.tsx`)

| Method                 | Input                | Output          | Behavior                                         | Errors                               |
| ---------------------- | -------------------- | --------------- | ------------------------------------------------ | ------------------------------------ |
| `createContextCommand` | `ContextCommandDeps` | `CommandOption` | Returns slash-command registration object        | -                                    |
| `onSelect` (internal)  | -                    | renders dialog  | Fetches route, renders `DialogContext` component | toast on no session or fetch failure |

## Data Flow

| Step | Component                 | Action                                                                                                            | Next                           |
| ---- | ------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 1    | TUI                       | User types `/context` or selects from command palette                                                             | onSelect fires                 |
| 2    | context-command.tsx       | Check active session (from route context)                                                                         | If none → toast warning + bail |
| 3    | context-command.tsx       | `fetch(sdk.url + "/session/" + id + "/context")`                                                                  | Await response                 |
| 4    | Session Route             | Validate sessionID param                                                                                          | ContextUsage.get()             |
| 5    | ContextUsage.get          | Resolve session model via `Session.get(id)` + `Provider.Model` lookup                                             | Parallel assembly              |
| 6    | ContextUsage.get          | Assemble system prompt text: `SystemPrompt.environment(model)`                                                    | cheapTokenEstimate             |
| 7    | ContextUsage.get          | Assemble instructions: `Instruction.system()`                                                                     | cheapTokenEstimate             |
| 8    | ContextUsage.get          | Assemble tools: `ToolRegistry.tools({providerID, modelID, agent})` → serialize definitions                        | cheapTokenEstimate per tool    |
| 9    | ContextUsage.get          | Assemble MCP tools: `MCP.tools()` → serialize definitions, keyed by server                                        | cheapTokenEstimate per tool    |
| 10   | ContextUsage.get          | Assemble agents: custom agent prompts from `Agent.list()`                                                         | cheapTokenEstimate per agent   |
| 11   | ContextUsage.get          | Assemble memory: `PersistentMemory.list()` entries + `PersistentMemory.inject()` text                             | cheapTokenEstimate             |
| 12   | ContextUsage.get          | Assemble skills: `Skill.activated(agent)` → listing text                                                          | cheapTokenEstimate per skill   |
| 13   | ContextUsage.get          | Assemble messages: `MessageV2.filterCompactedEffect(sessionID)` → reuse `cheapTokenEstimate` from cache-debug-log | total message tokens           |
| 14   | ContextUsage.get          | Assemble hooks + goal if present                                                                                  | cheapTokenEstimate             |
| 15   | ContextUsage.get          | Compute total, free = contextLimit - total (clamped 0)                                                            | Return Info                    |
| 16   | Session Route             | Return JSON                                                                                                       | HTTP 200                       |
| 17   | context-command.tsx       | Parse response, call `dialog.replace(() => <DialogContext ... />)`                                                | Render                         |
| 18   | DialogContext (component) | Render: header bar, category breakdown with percentages, sub-item tree                                            | User views/scrolls             |

**Error Flows**:

- No active session → toast "No active session" + `dialog.clear()`
- Fetch fails (network/500) → toast error message + `dialog.clear()`
- Session not found (404) → toast "Session not found" + `dialog.clear()`
- Model limit = 0 (unknown) → omit percentage bar, show "unknown" for free space

## Data Model

| Entity              | Fields                                                               | Relationships               | Constraints                                      |
| ------------------- | -------------------------------------------------------------------- | --------------------------- | ------------------------------------------------ |
| `ContextUsage.Info` | model: ModelRef, total: number, free: number, categories: Category[] | References session's model  | total = sum(categories[*].tokens), free >= 0     |
| `Category`          | name: string, tokens: number, items?: CategoryItem[]                 | Contains zero-to-many items | tokens = sum(items[*].tokens) when items present |
| `CategoryItem`      | name: string, tokens: number, source?: string                        | Belongs to a Category       | tokens = Math.ceil(charCount / 4)                |

No new database tables. All data is computed on-the-fly from existing subsystems.

## Category Assembly Detail

| Category          | Source                                                                                                 | Token Calculation                       |
| ----------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| System Prompt     | `SystemPrompt.environment(model)` joined text                                                          | `chars / 4`                             |
| Instructions      | `Instruction.system()` (AGENTS.md, CLAUDE.md)                                                          | `chars / 4`                             |
| Built-in Tools    | `ToolRegistry.tools(model)` → `JSON.stringify(tool.parameters.jsonSchema) + tool.description` per tool | `chars / 4` per tool definition         |
| MCP Tools         | `MCP.tools()` → record keyed `mcp__server__toolname` → same serialization                              | `chars / 4` per tool, grouped by server |
| Custom Agents     | `Agent.list()` → filter custom (non-native) → serialize prompt text                                    | `chars / 4` per agent prompt            |
| Persistent Memory | `PersistentMemory.inject()` full block text                                                            | `chars / 4` of injected block           |
| Skills            | `Skill.activated(agent)` → each skill's listing/content text                                           | `chars / 4` per skill                   |
| Messages          | `MessageV2.filterCompactedEffect(sessionID)` → reuse `CacheDebugLog.cheapTokenEstimate`                | chars/4 over text+tool parts            |
| Goal              | `Goal.get(sessionID)` → `Goal.addendum(goal)`                                                          | `chars / 4`                             |
| Hooks             | `HookContext.getSession(id)` + `HookContext.getTurn(id)`                                               | `chars / 4`                             |

## Decisions

| Decision               | Choice                                                | Reason                                                                   | Alternatives                | Tradeoffs                                                            |
| ---------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------- | -------------------------------------------------------------------- |
| Token estimation       | `chars / 4` heuristic                                 | Already used by `CacheDebugLog.cheapTokenEstimate`; consistent, zero-dep | tiktoken/model-specific BPE | ~20% variance vs actual; fast, no WASM dependency                    |
| Data assembly location | New `src/session/context-usage.ts` namespace          | Isolates logic from route handler; testable independently                | Inline in route handler     | Slightly more files; much better testability                         |
| Route pattern          | `GET /session/:sessionID/context`                     | Matches existing `/usage` pattern exactly                                | WebSocket push / SSE        | Unnecessary complexity for on-demand data                            |
| Category granularity   | Per-tool, per-skill, per-memory items                 | Users need to identify which specific items are largest                  | Aggregate-only categories   | Slightly larger response; much more useful                           |
| No caching of result   | Compute fresh each call                               | Context changes every turn; stale data misleads                          | Cache with invalidation     | Added complexity, marginal perf gain for rare command                |
| Tool serialization     | `JSON.stringify(parameters.jsonSchema) + description` | Approximates what AI SDK sends to provider                               | Send actual wire-format     | Wire format varies by provider; approximation sufficient for display |

## Risks

| Risk                                | Impact                                                      | Likelihood | Mitigation                                                                           |
| ----------------------------------- | ----------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------ |
| Token estimate diverges from actual | User sees "80% used" but model returns context-length error | Medium     | Label as "Estimated"; use same heuristic consistently; provide total chars alongside |
| MCP servers disconnected            | `MCP.tools()` returns empty/partial                         | Low        | Show "0 tools (disconnected)" for unavailable servers                                |
| Large response payload              | Many MCP tools + skills → large JSON                        | Low        | Items sorted by tokens desc; TUI shows top N with "(+X more)"                        |
| Model limit unknown (custom models) | Can't compute percentage or free space                      | Low        | Omit bar/percentage when `contextLimit === 0`; show "unknown"                        |
| Race with active generation         | Assembly mid-turn gets partial messages                     | Low        | Acceptable — shows point-in-time snapshot; no locking needed                         |

## Test Plan

### Unit Tests

**`src/session/context-usage.test.ts`**:

- `cheapTokenEstimate` consistency: verify chars/4 matches `CacheDebugLog.cheapTokenEstimate` for same input
- Category assembly with mocked subsystems: verify total = sum of categories
- Free space clamping: when total > contextLimit, free = 0 (not negative)
- Empty session (no messages): returns 0 for messages category
- Missing model limit (0): free = 0, categories still computed
- Items within category sorted by tokens descending
- MCP tools grouped by server name correctly

### Integration Tests

**Route integration (`test/server/session-context.test.ts`)**:

- `GET /session/:id/context` returns 200 with valid `Info` shape
- Returns 404 for non-existent session
- Response `total` field equals sum of all `categories[*].tokens`
- Response `free` = `model.contextLimit - total` (clamped)
- Categories array contains expected names (system, instructions, tools, etc.)

### End-to-End Tests

- `/context` command in active session renders dialog without crash
- `/context` from home screen (no session) shows warning toast
- Dialog displays model name, usage ratio, and at least one category
- Scrollable dialog handles large tool lists without overflow

### Non-Functional Tests

- **Performance**: Assembly completes < 200ms for session with 100 messages + 50 tools
- **No side effects**: Route is read-only; repeated calls produce consistent results
- **Input validation**: Invalid sessionID format returns 400 (Zod validation)
