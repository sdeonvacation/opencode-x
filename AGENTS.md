- To regenerate the JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- The default branch in this repo is `dev`.
- Local `main` ref may not exist; use `dev` or `origin/dev` for diffs.
- Prefer automation: execute requested actions without confirmation unless blocked by missing info or safety/irreversibility.
- **[CRITICAL]** All changes to source code must be upstream-rebase safe: surgical edits only, minimum required changes to upstream files, no broad refactors.

## Commands

```bash
# Install dependencies (from repo root)
bun install

# Dev server (TUI/CLI)
bun run dev                         # from repo root
bun run --cwd packages/opencode dev # from any dir

# Build
bun --cwd packages/opencode run build

# Run ALL tests (must be run from packages/opencode, NOT repo root)
bun --cwd packages/opencode test --timeout 30000

# Run a single test file
bun --cwd packages/opencode test test/tool/task.test.ts

# Type check (uses tsgo, NOT tsc)
bun --cwd packages/opencode typecheck

# Regenerate JS SDK
./packages/sdk/js/script/build.ts

# Database migrations
bun --cwd packages/opencode db <drizzle-kit-cmd>
```

> ⚠️ `bun test` from repo root always fails (guard). Always run from `packages/opencode`.

## Project Structure

```
packages/
  opencode/
    src/
      tool/          # All tool definitions (bash, read, edit, task, registry…)
      session/       # Session lifecycle, prompt, message processing
      agent/         # Agent definitions and routing
      orchestration/ # Task spawning, model resolver
      cli/cmd/tui/   # TUI (Solid-based terminal UI via @opentui)
        app.tsx      # Root app component
        thread.ts    # SDK thread/EventSource impl
        worker.ts    # Worker RPC (changeDirectory, etc.)
        context/     # Solid contexts (sdk, sync, event…)
        command/     # Slash commands (clear, goto, btw…)
        effect/      # Side-effect helpers (app-event-listeners…)
      provider/      # AI provider wrappers (Anthropic, OpenAI, etc.)
      storage/       # SQLite via Drizzle (db.bun.ts / db.node.ts)
      effect/        # Effect-ts infrastructure (InstanceState, run-service…)
      config/        # Config loading
      lsp/           # LSP integration
      mcp/           # MCP protocol
      skill/         # Skill loading
    test/            # Mirror of src/ structure
      fixture/       # tmpdir() fixture helper
```

## Tech Stack

- **Runtime**: Bun (1.3.11)
- **Language**: TypeScript 5.8, type-checked via `tsgo` (not `tsc`)
- **Framework**: Effect-ts (`effect` 4.0.0-beta) for service/layer wiring
- **TUI**: `@opentui/core` + `@opentui/solid` (Solid.js-based terminal UI)
- **AI SDK**: Vercel AI SDK (`ai` 6.x) with per-provider packages
- **Database**: SQLite via `drizzle-orm` + `bun:sqlite`
- **Monorepo**: Turborepo + Bun workspaces
- **Testing**: `bun test` (built-in)

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Prefer single word variable names where possible
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream

### Naming

Prefer single word names for variables and functions. Only use multiple words if necessary.

### Naming Enforcement (Read This)

THIS RULE IS MANDATORY FOR AGENT WRITTEN CODE.

- Use single word names by default for new locals, params, and helper functions.
- Multi-word names are allowed only when a single word would be unclear or ambiguous.
- Do not introduce new camelCase compounds when a short single-word alternative is clear.
- Before finishing edits, review touched lines and shorten newly introduced identifiers where possible.
- Good short names to prefer: `pid`, `cfg`, `err`, `opts`, `dir`, `root`, `child`, `state`, `timeout`.
- Examples to avoid unless truly required: `inputPID`, `existingClient`, `connectTimeout`, `workerPath`.

```ts
// Good
const foo = 1
function journal(dir: string) {}

// Bad
const fooBar = 1
function prepareJournal(dir: string) {}
```

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

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

Use snake_case for field names so column names don't need to be redefined as strings.

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

- Avoid mocks as much as possible
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/opencode`.

## Type Checking

- Always run `bun typecheck` from package directories (e.g., `packages/opencode`), never `tsc` directly.
