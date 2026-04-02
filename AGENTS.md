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

### Build project

- Core build (main package): `bun --cwd packages/opencode run build`

### Run ALL tests

- Core package: `bun --cwd packages/opencode test`
- Note: root tests are intentionally blocked by `bunfig.toml` (`do-not-run-tests-from-root`).

### Run SINGLE test file

- Exact syntax: `bun --cwd packages/opencode test test/session/retry.test.ts`

### Lint (auto-fix if available)

- Current package lint script: `bun --cwd packages/opencode run lint`
- No dedicated auto-fix lint command is defined in scripts.

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

- `packages/opencode/`: main CLI/runtime package (primary backend logic)
  - `src/session/`: prompt loop, processor, retries, snapshots
  - `src/tool/`: tool implementations (`bash`, `task`, etc.)
  - `src/provider/`: LLM provider integrations
  - `src/mcp/`: MCP integrations
  - `src/permission/`, `src/question/`: interactive approval/question flows
  - `src/storage/`: DB adapters and drizzle schema (`*.sql.ts`)
  - `test/`: Bun test suites (`*.test.ts`, `*.effect.test.ts`)
- `packages/app/`: SolidJS web app
- `packages/desktop/`, `packages/desktop-electron/`: desktop apps
- `packages/ui/`, `packages/web/`, `packages/util/`, `packages/plugin/`: shared packages
- `specs/`: technical notes (including Effect migration guidance)
- `turbo.json`: task graph for monorepo commands
- `bunfig.toml`: test root guardrail
- Important root files: `package.json`, `tsconfig.json`, `AGENTS.md`, `README.md`

## 3) Code Style

### Import order / grouping

- Follow existing file-local ordering; typical pattern is:
  1. external deps
  2. `@/` alias imports
  3. relative imports
- Avoid noisy import reordering unless needed.

### Naming conventions

- Prefer single-word names for locals/params/helpers when clear.
- Multi-word names are allowed only when single-word names are ambiguous.
- Prefer concise names (`cfg`, `err`, `opts`, `dir`, `state`, `timeout`).

### TypeScript usage

- Avoid `any`.
- Prefer inference over verbose annotations.
- Use `type` by default; use `interface` where extension/merging is needed.
- In Drizzle schemas, use snake_case fields (avoid remapping names explicitly).

### Error handling patterns

- Prefer early returns over nested branching.
- Avoid unnecessary `try/catch`; use typed/domain errors.
- In Effect code, use `Schema.TaggedErrorClass` and explicit failure branches.

### Testing patterns

- Use Bun test runner from package dirs (not root).
- Prefer testing real behavior over duplicated logic/mocks.
- Effect-heavy modules use `Effect.gen`/layer-based test patterns (`*.effect.test.ts`).

## 4) Tech Stack

- Language/runtime: TypeScript + Bun
- Monorepo tooling: Turborepo
- Core architecture: Effect (`effect`), service/layer pattern
- CLI/TUI: `@opentui/core`, `@opentui/solid`
- Web: SolidJS + Vite
- API/schema libs: `hono`, `hono-openapi`, `zod`
- AI stack: Vercel AI SDK (`ai`) + multiple provider adapters
- Database: Drizzle ORM + Drizzle Kit (schema in `packages/opencode/src/**/*.sql.ts`)

## Agent-specific notes

- Use parallel tool calls when tasks are independent.
- Prefer automation; ask only when blocked or unsafe.
- For diffs/comparisons, use `dev`/`origin/dev` (local `main` may not exist).
