- Regenerate JS SDK: `./packages/sdk/js/script/build.ts`
- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE
- Default branch: `main`. Use `main` or `origin/main` for diffs.
- Prefer automation: execute without confirmation unless blocked by missing info or safety/irreversibility.
- **[CRITICAL]** All changes must be upstream-rebase safe.
- **[CRITICAL]** Do NOT break provider caching, app stability or performance.

## Commands

```bash
bun install
bun run --cwd packages/opencode dev
bun --cwd packages/opencode run build
bun --cwd packages/opencode test --timeout 30000
bun --cwd packages/opencode test test/tool/task.test.ts
bun --cwd packages/opencode typecheck        # tsgo, never tsc
./packages/sdk/js/script/build.ts
bun --cwd packages/opencode db <drizzle-kit-cmd>
```

> `bun test` from repo root always fails (guard). Run from `packages/opencode`.

## Structure

```
packages/opencode/src/
  tool/           # bash, read, edit, task, registry
  session/        # lifecycle, prompt, compaction, checkpoint
  agent/          # definitions + routing
  orchestration/  # task spawning, model resolver
  cli/cmd/tui/    # @opentui Solid-based TUI
  provider/       # AI wrappers (Anthropic, OpenAI, etc.)
  storage/        # SQLite via Drizzle
  effect/         # Effect-ts (InstanceState, run-service)
  config/         # config loading
  lsp/            # LSP integration
  mcp/            # MCP protocol
  skill/          # skill loading
  test/           # mirrors src/, fixture/ has tmpdir() helper
```

## Tech Stack

Bun 1.3.11 | TypeScript 5.8 (tsgo) | Effect-ts 4.0-beta | @opentui/core+solid | AI SDK 6.x | SQLite+drizzle-orm | Turborepo+Bun workspaces | Logs: ~/.local/share/opencode/log

## Style

- Single-word names default. Multi-word only when ambiguous. Prefer: `pid`, `cfg`, `err`, `opts`, `dir`, `root`, `child`, `state`, `timeout`.
- Inline values used once: `await Bun.file(path.join(dir, "x.json")).json()` not `const p = path.join(...); await Bun.file(p).json()`
- Dot notation over destructuring: `obj.a` not `const { a } = obj`
- `const` over `let`. Ternaries/early returns over reassignment.
- No `else`. Early returns only.
- No `try`/`catch` where avoidable. No `any`.
- Functional array methods (flatMap, filter, map) over for loops; type guards on filter.
- Type inference preferred; explicit types only for exports.
- Use Bun APIs (`Bun.file()`) when possible.
- Drizzle schemas: snake_case fields, no string column name args.

## Testing

- Avoid mocks. Test actual implementation.
- Run from `packages/opencode`, never repo root.

## Database

- Data: ~/.local/share/opencode/\*.db
- Schema: `src/**/*.sql.ts`. Tables/columns snake*case. Join cols: `<entity>_id`. Indexes: `<table>*<column>\_idx`.
- Migrations: `bun run db generate --name <slug>` → `migration/<ts>_<slug>/migration.sql`

## npm Release

**[CRITICAL]** Published package = self-contained binary (zero deps). Postinstall downloads from GitHub releases.

```bash
# 1. Bump version in packages/opencode/package.json
# 2. Pack (prepack strips deps)
cd packages/opencode && npm pack
# 3. Verify zero deps
tar -xzf sdeonvacation-opencode-x-<ver>.tgz
node -e "const p=require('./package/package.json'); console.log(p.dependencies, p.devDependencies)"
# Must print: undefined undefined
rm -rf package
# 4. Publish FROM tarball (not `npm publish .`)
npm publish sdeonvacation-opencode-x-<ver>.tgz --access public --registry https://registry.npmjs.org/
# 5. Verify: npm view @sdeonvacation/opencode-x@<ver> dependencies
# 6. GitHub release: tag v<ver>, target main, upload 12 platform binaries
```

`npm publish .` with auth flags skips lifecycle scripts. npm versions are immutable.

## Effect Rules

See `specs/effect-migration.md` for full reference.

- `Effect.gen(function* () { ... })` for composition
- `Effect.fn("Domain.method")` for named/traced effects; `Effect.fnUntraced` for internal helpers
- `Effect.callback` for callback-based APIs
- `DateTime.nowAsDate` over `new Date(yield* Clock.currentTimeMillis)`
- `Schema.Class` for multi-field data; `Schema.brand` for single-value types
- `Schema.TaggedErrorClass` for typed errors; `Schema.Defect` for defect causes
- `yield* new MyError(...)` over `yield* Effect.fail(new MyError(...))`
- `makeRuntime` (from `src/effect/run-service.ts`) for all services — shared `memoMap` deduplicates layers
- `InstanceState` for per-directory state needing per-instance cleanup (ScopedCache keyed by dir)
- Do work directly in `InstanceState.make` closure. No extra fibers/flags/ensure().
- `Effect.addFinalizer` / `Effect.acquireRelease` inside closure for cleanup
- `Effect.forkScoped` for background stream consumers
- Prefer Effect services: `FileSystem`, `HttpClient`, `Path`, `Clock`, `DateTime`, `ChildProcess.make`
- `Effect.cached` for shared single-flight computation (not manual Fiber/Promise caching)
- `Instance.bind(fn)` for native addon callbacks needing ALS context (`@parcel/watcher`, `node-pty`)
