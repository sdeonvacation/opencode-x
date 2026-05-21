# HLD: MCP Tool Filtering

## Tech Stack

| Category  | Technology         | Purpose                          |
| --------- | ------------------ | -------------------------------- |
| Language  | TypeScript 5.8     | Existing codebase language       |
| Runtime   | Bun 1.3.11         | Existing runtime                 |
| Schema    | Zod (via config)   | Config validation + type gen     |
| Framework | Effect-ts 4.0 beta | Service composition in MCP layer |

## Components

| Component     | Responsibility                         | Dependencies          |
| ------------- | -------------------------------------- | --------------------- |
| Config Schema | Validate `tools` allowlist per server  | Zod, `config.ts`      |
| MCP.tools()   | Filter exposed tools against allowlist | Config, InstanceState |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     User Config                          │
│  opencode.json / .opencode/config.json                  │
│  mcp.server-name.tools: ["toolA", "toolB"]              │
└───────────────────────────┬─────────────────────────────┘
                            │ parsed by Zod
                            ▼
┌─────────────────────────────────────────────────────────┐
│              Config Schema (config.ts)                   │
│  McpLocal / McpRemote → tools?: string[]                │
└───────────────────────────┬─────────────────────────────┘
                            │ read at runtime
                            ▼
┌─────────────────────────────────────────────────────────┐
│              MCP.tools() (mcp/index.ts)                  │
│  for each connected server:                             │
│    entry = config[clientName]                            │
│    allowed = entry?.tools                               │
│    for each mcpTool in cached defs:                     │
│      if (allowed && !allowed.includes(mcpTool.name))    │
│        continue  ← FILTERED OUT                         │
│      result[key] = convertMcpTool(...)                  │
└─────────────────────────────────────────────────────────┘
```

Description: Config schema adds optional `tools` field. `MCP.tools()` reads it at filter time. No new modules, no new dependencies. Two surgical insertions.

## Interfaces

### Config Schema (McpLocal / McpRemote)

| Field   | Type                    | Default   | Behavior                                   |
| ------- | ----------------------- | --------- | ------------------------------------------ |
| `tools` | `string[] \| undefined` | undefined | If set, only listed tool names are exposed |

### MCP.tools() filter logic

| Method         | Input                          | Output              | Behavior                                         | Errors |
| -------------- | ------------------------------ | ------------------- | ------------------------------------------------ | ------ |
| (inline check) | `entry?.tools`, `mcpTool.name` | continue or proceed | Skip tool if allowlist exists and name not in it | None   |

## Data Flow

| Step | Component      | Action                                           | Next           |
| ---- | -------------- | ------------------------------------------------ | -------------- |
| 1    | Config loader  | Parse `mcp.*` entries, validate via Zod schema   | InstanceState  |
| 2    | MCP.tools()    | Get `entry` for each connected `clientName`      | Filter loop    |
| 3    | Filter loop    | Check `entry?.tools` allowlist against tool name | convertMcpTool |
| 4    | convertMcpTool | Build Tool object for allowed tools only         | result map     |

**Error Flows**: No new error paths. Invalid `tools` values (non-string-array) rejected by Zod at config parse time. Missing tool names in allowlist silently ignored (tool just not exposed).

## Data Model

| Entity    | Fields               | Relationships     | Constraints                |
| --------- | -------------------- | ----------------- | -------------------------- |
| McpLocal  | + `tools?: string[]` | Part of Mcp union | Optional, array of strings |
| McpRemote | + `tools?: string[]` | Part of Mcp union | Optional, array of strings |

No DB changes. No migrations. Schema-only addition to Zod config objects.

## Exact Insertion Points

### 1. `packages/opencode/src/config/config.ts` — McpLocal (line 386→387)

Insert AFTER the `timeout` field (line 386, closing paren of `.describe(...)`) and BEFORE `})` + `.strict()` (line 387-388):

```ts
      tools: z.string().array().optional().describe("Allowlist of tool names to expose. If omitted, all tools are exposed."),
```

Resulting context (lines 385-389):

```ts
        .describe("Timeout in ms for MCP server requests. Defaults to 5000 (5 seconds) if not specified."),
      tools: z.string().array().optional().describe("Allowlist of tool names to expose. If omitted, all tools are exposed."),
    })
    .strict()
    .meta({
```

### 2. `packages/opencode/src/config/config.ts` — McpRemote (line 429→430)

Insert AFTER the `timeout` field (line 429, closing paren of `.describe(...)`) and BEFORE `})` + `.strict()` (line 430-431):

```ts
      tools: z.string().array().optional().describe("Allowlist of tool names to expose. If omitted, all tools are exposed."),
```

### 3. `packages/opencode/src/mcp/index.ts` — MCP.tools() (line 710→711)

Insert one line BEFORE the `for` loop (line 711) and add `continue` inside:

**Before (lines 710-713):**

```ts
const timeout = entry?.timeout ?? defaultTimeout
for (const mcpTool of listed) {
  result[sanitize(clientName) + "_" + sanitize(mcpTool.name)] = convertMcpTool(mcpTool, client, timeout)
}
```

**After:**

```ts
const timeout = entry?.timeout ?? defaultTimeout
const allowed = entry?.tools
for (const mcpTool of listed) {
  if (allowed && !allowed.includes(mcpTool.name)) continue
  result[sanitize(clientName) + "_" + sanitize(mcpTool.name)] = convertMcpTool(mcpTool, client, timeout)
}
```

## Rebase Safety

- **2 files touched**, 3 insertions total (~5 lines of new code)
- No line deletions, no reformatting, no moving existing code
- Each insertion is additive-only at a clear boundary
- No adjacent-line modifications — minimizes merge conflict surface
- `.strict()` on schemas means unknown fields already rejected; adding a known field is safe

## Decisions

| Decision                | Choice                                   | Reason                                                     | Alternatives                | Tradeoffs                                            |
| ----------------------- | ---------------------------------------- | ---------------------------------------------------------- | --------------------------- | ---------------------------------------------------- |
| Filter location         | Inside `MCP.tools()` loop                | Single point of enforcement, no new abstraction            | Separate filter function    | Inline = less indirection, harder to unit test alone |
| Matching semantics      | Exact string match on raw `mcpTool.name` | Simple, predictable, matches server's `listTools()` output | Glob/regex patterns         | Exact = no regex bugs, users copy tool name verbatim |
| Allowlist vs blocklist  | Allowlist only                           | Safer default (explicit > implicit), simpler               | Blocklist, or both          | Allowlist forces user to know tool names             |
| Empty array `tools: []` | Blocks all tools                         | Consistent with "only items in list are allowed"           | Treat empty as "no filter"  | Users might accidentally block all; documented       |
| Claude Code override    | User redeclares server name in config    | Existing precedence logic (line 541) already handles this  | Separate override mechanism | No new code needed for override path                 |

## Risks

| Risk                                  | Impact                           | Likelihood | Mitigation                                            |
| ------------------------------------- | -------------------------------- | ---------- | ----------------------------------------------------- |
| User typos tool name in allowlist     | Tool silently not exposed        | Med        | Document that names must match `listTools()` exactly  |
| `tools: []` blocks all accidentally   | Server's tools completely hidden | Low        | Document behavior; could add warning log in future    |
| Schema `.strict()` breaks old configs | N/A — field is additive optional | None       | Zod strict rejects unknown keys, not missing optional |

## Test Plan

### Unit Tests

**Config schema validation** (existing test infra):

- `tools: ["a", "b"]` → parses OK
- `tools: undefined` (omitted) → parses OK
- `tools: [123]` → Zod rejects (non-string)
- `tools: "single"` → Zod rejects (not array)

**MCP.tools() filter logic**:

- Server with `tools: ["X"]` → only tool "X" in result
- Server with `tools: []` → no tools in result
- Server with `tools: undefined` → all tools in result
- Server with `tools: ["nonexistent"]` → no tools (name doesn't match any)

### Integration Tests

- Configure MCP server in test config with `tools` allowlist
- Start server, verify `MCP.tools()` returns only allowed subset
- Verify other servers (without `tools`) unaffected

### End-to-End Tests

- Manual: add `tools: ["read"]` to an MCP server in `opencode.json`
- Run `/mcp` TUI command → verify only "read" tool listed for that server
- Remove `tools` field → verify all tools return

### Non-Functional Tests

- Performance: `Array.includes()` on small arrays (<100 tools) is negligible
- No security implications (reduces attack surface by limiting tool exposure)

## Backward Compatibility

- `tools` field is optional with no default → existing configs unchanged
- `undefined` means "expose all" → zero behavior change for current users
- Auto-discovered Claude Code servers get no `tools` field → all tools exposed as before
- Users opt-in by adding `tools` to their config override
