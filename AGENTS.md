# AGENTS.md

Repository: `opencode` monorepo (default branch: `dev`)

## 1) Commands (CRITICAL)

Use Bun (workspace uses `bun@1.3.11`).

### Install dependencies

- `bun install`

### Run dev server

- Core CLI/runtime dev: `bun run dev`
- Web app dev: `bun run dev:web`
- Desktop dev (Tauri): `bun run dev:desktop`
- Console app dev: `bun run dev:console`

### Build project

- Core build (main package): `bun --cwd packages/opencode run build`

### Run ALL tests

- Core package: `bun --cwd packages/opencode test`
- Root `bun test` is intentionally blocked by `bunfig.toml` (`do-not-run-tests-from-root`).

### Run SINGLE test file

- Exact syntax: `bun --cwd packages/opencode test test/session/retry.test.ts`

### Lint (auto-fix if available)

- Current package lint script: `bun --cwd packages/opencode run lint`
- There is no dedicated auto-fix lint command.
- Note: current `lint` script is coverage-based (`bun test --coverage`), not a standalone linter.

### Type check

- Monorepo: `bun run typecheck`
- Core package only: `bun --cwd packages/opencode typecheck`

### Format code

- Repo-wide: `bunx prettier --write .`
- Core package script: `bun --cwd packages/opencode run format`

### Project-specific utility commands

- Regenerate JavaScript SDK: `./packages/sdk/js/script/build.ts`
- Generate DB migration (core): `bun --cwd packages/opencode run db generate --name <slug>`

## 2) Project Structure

- `packages/opencode/`: primary CLI/runtime package
  - `src/session/`: prompt loop, processor, retries, compaction, snapshots
  - `src/tool/`: built-in tools (`bash`, `read`, `edit`, `task`, `question`, etc.)
  - `src/provider/`: model/provider adapters
  - `src/cli/cmd/tui/`: terminal UI routes, panes, dialogs, components
  - `src/mcp/`: MCP server/client integrations
  - `src/permission/`, `src/question/`: approval and question flows
  - `src/project/`: project/worktree state
  - `src/effect/`: Effect runtime helpers and instance state
  - `src/storage/`: DB adapters and Drizzle schema/migrations glue
  - `script/`: build and maintenance scripts
  - `test/`: Bun test suites (`*.test.ts`)
- `packages/app/`: SolidJS web app
- `packages/desktop/`: Tauri desktop app
- `packages/desktop-electron/`: Electron desktop app
- `packages/ui/`, `packages/web/`, `packages/util/`, `packages/plugin/`: shared packages
- `packages/sdk/js/`: JavaScript SDK build target
- `packages/console/`: console-specific apps/packages
- `packages/slack/`: Slack integration package
- `specs/`: technical notes, including Effect migration guidance
- `migration/` under `packages/opencode/`: generated Drizzle migrations
- Important root files: `package.json`, `bunfig.toml`, `turbo.json`, `AGENTS.md`, `README.md`
- Important package files: `packages/opencode/package.json`, `packages/opencode/tsconfig.json`, `packages/opencode/drizzle.config.ts`, `packages/opencode/test/AGENTS.md`

## 3) Code Style

### Import order / grouping

- Follow existing file-local ordering; typical pattern is:
  1. external deps
  2. `@/` alias imports
  3. relative imports
- In TUI code, `@tui/*` aliases follow the internal alias group.
- Avoid noisy reordering unless the touched file already needs import cleanup.

### Naming conventions

- Prefer single-word names for locals/params/helpers when clear.
- Multi-word names are allowed only when single-word names are ambiguous.
- Prefer concise names (`cfg`, `err`, `opts`, `dir`, `state`, `timeout`).
- Constants use `SCREAMING_SNAKE_CASE`; Drizzle columns use snake_case.

### TypeScript usage

- Avoid `any`.
- Prefer inference over verbose annotations.
- Use `type` by default; use `interface` where extension/merging is needed.
- Path aliases: `@/*` → `packages/opencode/src/*`, `@tui/*` → `packages/opencode/src/cli/cmd/tui/*`.
- JSX is preserved with `jsxImportSource: @opentui/solid` in `packages/opencode`.
- In Drizzle schemas, use snake_case fields (avoid remapping names explicitly).

### Error handling patterns

- Prefer early returns over nested branching.
- Avoid unnecessary `try/catch`; use typed/domain errors.
- In Effect code, use `Schema.TaggedErrorClass` and explicit failure branches.
- Prefer `Effect.gen(function* () { ... })` for composition in Effect-heavy modules.

### Testing patterns

- Use Bun test runner from package dirs (not root).
- Prefer testing real behavior over duplicated logic/mocks.
- Tests live under `packages/opencode/test/**` and use `bun:test`.
- Use the `tmpdir` fixture from `packages/opencode/test/fixture/fixture.ts` for temp repos/configs.
- Single-file test runs should use repo-relative paths from `packages/opencode`.

## 4) Tech Stack

- Language/runtime: TypeScript `5.8.2` + Bun `1.3.11`
- Monorepo tooling: Turborepo `2.8.13`
- Core architecture: Effect `4.0.0-beta.43` service/layer pattern
- CLI/TUI: `@opentui/core` / `@opentui/solid` `0.1.96`
- Web app: SolidJS `1.9.10` + Vite `7.1.4`
- API/schema libs: Hono `4.10.7`, `hono-openapi` `1.1.2`, Zod `4.1.8`
- AI stack: Vercel AI SDK `6.0.138` plus many provider adapters (`@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/azure`, `@ai-sdk/amazon-bedrock`, etc.)
- Protocol/integration: MCP via `@modelcontextprotocol/sdk`, GitHub via Octokit
- Database: Drizzle ORM / Drizzle Kit `1.0.0-beta.19-d95b7a4` with schema files in `packages/opencode/src/**/*.sql.ts`

## Agent-specific notes

- Use parallel tool calls when tasks are independent.
- Prefer automation; ask only when blocked or unsafe.
- For diffs/comparisons, use `dev`/`origin/dev` (local `main` may not exist).
- Root-level `test` script intentionally fails; do not rely on it for validation.
