- Regenerate JS SDK: `./packages/sdk/js/script/build.ts`.
- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- Default branch: `dev`.
- Local `main` may not exist; use `dev` or `origin/dev` for diffs.
- Prefer automation: execute without confirmation unless blocked by missing info or safety/irreversibility.
- **[CRITICAL]** Source code changes must be upstream-rebase safe: surgical edits only, minimum required changes, no broad refactors.

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

- One function unless reusable
- Avoid `try`/`catch` where possible
- Avoid `any` type
- Prefer single word variable names
- Use Bun APIs when possible (`Bun.file()`)
- Type inference preferred; explicit types only for exports or clarity
- Functional array methods (flatMap, filter, map) over for loops; type guards on filter
- Avoid unnecessary destructuring; use dot notation (`obj.a` not `const { a } = obj`)
- Prefer `const` over `let`; ternaries or early returns instead of reassignment
- Avoid `else`; prefer early returns

### Naming (MANDATORY)

Single word names by default. Multi-word names only when single word unclear.

Preferred short names: `pid`, `cfg`, `err`, `opts`, `dir`, `root`, `child`, `state`, `timeout`.
Avoid: `inputPID`, `existingClient`, `connectTimeout`, `workerPath`.

```ts
// Good
const foo = 1
function journal(dir: string) {}
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const fooBar = 1
function prepareJournal(dir: string) {}
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
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
