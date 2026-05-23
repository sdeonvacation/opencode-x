- Regenerate JS SDK: `./packages/sdk/js/script/build.ts`.
- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- Default branch: `dev`.
- Local `main` may not exist; use `dev` or `origin/dev` for diffs.
- Prefer automation: execute without confirmation unless blocked by missing info or safety/irreversibility.
- **[CRITICAL]** All plans, designs, source code changes done must be upstream-rebase safe.
- **[CRITICAL]** Any changes made should NOT break provider caching, app stability or performance

## Commands

```bash
bun install

bun run dev
bun run --cwd packages/opencode dev

bun --cwd packages/opencode run build

bun --cwd packages/opencode test --timeout 30000
bun --cwd packages/opencode test test/tool/task.test.ts

bun --cwd packages/opencode typecheck

./packages/sdk/js/script/build.ts

bun --cwd packages/opencode db <drizzle-kit-cmd>
```

> ⚠️ `bun test` from repo root always fails (guard). Always run from `packages/opencode`.

## Project Structure

```
packages/
  opencode/
    src/
      tool/          # bash, read, edit, task, registry…
      session/       # lifecycle, prompt, message processing
      agent/         # definitions + routing
      orchestration/ # task spawning, model resolver
      cli/cmd/tui/   # @opentui Solid-based TUI
        app.tsx      # root component
        thread.ts    # SDK thread/EventSource
        worker.ts    # Worker RPC
        context/     # Solid contexts (sdk, sync, event…)
        command/     # slash commands
        effect/      # side-effect helpers
      provider/      # AI wrappers (Anthropic, OpenAI, etc.)
      storage/       # SQLite via Drizzle
      effect/        # Effect-ts (InstanceState, run-service…)
      config/        # config loading
      lsp/           # LSP integration
      mcp/           # MCP protocol
      skill/         # skill loading
    test/            # mirror of src/
      fixture/       # tmpdir() helper
```

## Tech Stack

- **Runtime**: Bun (1.3.11)
- **Language**: TypeScript 5.8, type-checked via `tsgo` (not `tsc`)
- **Framework**: Effect-ts (`effect` 4.0.0-beta)
- **TUI**: `@opentui/core` + `@opentui/solid` (Solid.js)
- **AI SDK**: Vercel AI SDK (`ai` 6.x)
- **Database**: SQLite via `drizzle-orm` + `bun:sqlite`
- **Monorepo**: Turborepo + Bun workspaces
- **Testing**: `bun test`
- **Logs**: ~/.local/share/opencode/log

## Style Guide

### General Principles

- One function unless composable or reusable
- Avoid `try`/`catch` where possible
- Avoid `any` type
- Prefer single word variable names
- Use Bun APIs when possible (`Bun.file()`)
- Type inference preferred; explicit types only for exports or clarity
- Functional array methods (flatMap, filter, map) over for loops; type guards on filter

### Naming

Single word names by default. Multiple words only when single word unclear.

### Naming Enforcement (Read This)

THIS RULE IS MANDATORY FOR AGENT WRITTEN CODE.

- Single word names by default for locals, params, helper functions.
- Multi-word names allowed only when single word unclear.
- No new camelCase compounds when short single-word alternative exists.
- Short names to prefer: `pid`, `cfg`, `err`, `opts`, `dir`, `root`, `child`, `state`, `timeout`.
- Avoid unless truly required: `inputPID`, `existingClient`, `connectTimeout`, `workerPath`.

```ts
// Good
const foo = 1
function journal(dir: string) {}

// Bad
const fooBar = 1
function prepareJournal(dir: string) {}
```

Inline when value used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Variables

Prefer `const` over `let`. Ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else`. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Schema Definitions (Drizzle)

Use snake_case field names so column names don't need string redefinition.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing

- Avoid mocks
- Test actual implementation, don't duplicate logic in tests
- Tests can't run from repo root (guard); run from `packages/opencode`.

## Type Checking

- `bun typecheck` from package dirs, never `tsc` directly.

## DB

DB data is present in ~/.local/share/opencode/*.db