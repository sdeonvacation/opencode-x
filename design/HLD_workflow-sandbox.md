# HLD: QuickJS Sandboxed Workflows

## Summary

Deterministic QuickJS-emscripten sandbox that executes user-authored workflow scripts in complete isolation. Scripts call host-injected hooks (`agent()`, file I/O) via a sync-promise bridge, enabling multi-agent orchestration pipelines with resume-safe journaling. Enforces memory caps, wall-clock deadlines, and seeded PRNG for replay determinism.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Tool Layer                                    │
│  src/tool/workflow.ts  ←─── ToolRegistry (gated on flag)            │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │ start/status/wait/cancel
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    WorkflowRuntime Service                            │
│  src/workflow/runtime.ts                                             │
│  ┌──────────┐  ┌──────────────┐  ┌────────────┐  ┌──────────────┐ │
│  │ Semaphore │  │ Journal Replay│  │ Phase Track │  │ Agent Hook   │ │
│  └──────────┘  └──────────────┘  └────────────┘  └──────┬───────┘ │
└──────────────────────────────────────────────────────────┼──────────┘
                                   │                       │
            ┌──────────────────────┼───────────────────────┘
            │                      │
            ▼                      ▼
┌───────────────────┐  ┌─────────────────────────────────────────────┐
│  Sandbox Core     │  │  Orchestration (existing)                    │
│  src/workflow/    │  │  task-spawn.ts / concurrency.ts              │
│   sandbox.ts     │  └─────────────────────────────────────────────┘
│   ┌───────────┐  │
│   │ QuickJS   │  │     ┌──────────────────────────────┐
│   │ WASM VM   │◄─┼─────│ Workspace (file hooks)       │
│   │           │  │     │ src/workflow/workspace.ts     │
│   │ PRELUDE   │  │     └──────────────────────────────┘
│   │ + hooks   │  │
│   └───────────┘  │     ┌──────────────────────────────┐
└───────────────────┘     │ Persistence                  │
                          │ src/workflow/persistence.ts   │
            ┌─────────────│ + workflow.sql.ts             │
            │             └──────────────────────────────┘
            ▼
┌───────────────────┐     ┌──────────────────────────────┐
│  Meta Parser      │     │ Script Resolution             │
│  src/workflow/    │     │ src/workflow/resolve.ts       │
│   meta.ts        │     │ .opencode/workflows/<name>.js │
└───────────────────┘     └──────────────────────────────┘
```

## Components

### Component 1: Sandbox Core

- **File**: `src/workflow/sandbox.ts`
- **Type**: Pure Module
- **Exports**: `evalScript`, `injectHooks`, `marshalIn`, `marshalOut`, `createArena`
- **Dependencies**: `quickjs-emscripten`
- **Interface**:

  ```typescript
  export namespace Sandbox {
    type Hook = {
      name: string
      fn: (...args: unknown[]) => Promise<unknown>
    }

    type Options = {
      memory: number // bytes, default 64MB
      deadline: number // ms, default 300_000
      seed: string // PRNG seed (runID hash)
      hooks: Hook[]
    }

    type Result = {
      value: unknown
      duration: number
      memory: number
    }

    function eval(script: string, opts: Options): Promise<Result>
    function dispose(arena: Arena): void
  }
  ```

### Component 2: Meta Parser

- **File**: `src/workflow/meta.ts`
- **Type**: Pure Module
- **Exports**: `parseMeta`
- **Dependencies**: none
- **Interface**:

  ```typescript
  export namespace WorkflowMeta {
    type Meta = {
      name?: string
      description?: string
      args?: Record<string, { type: string; required?: boolean; default?: unknown }>
      timeout?: number
      max_agents?: number
    }

    type Parsed = { meta: Meta; body: string }
    type ParseError = { line: number; message: string }

    function parse(source: string): Parsed | ParseError
  }
  ```

### Component 3: Script Resolution

- **File**: `src/workflow/resolve.ts`
- **Type**: Pure Module
- **Exports**: `resolve`, `safeName`
- **Dependencies**: `fs`, `path`, `Instance`
- **Interface**:

  ```typescript
  export namespace WorkflowResolve {
    type Resolved = {
      path: string
      source: string
      sha: string
    }

    function resolve(name: string, dir: string): Resolved | undefined
    function safeName(name: string): boolean
  }
  ```

### Component 4: Builtin Registry

- **File**: `src/workflow/builtin.ts`
- **Type**: Pure Module
- **Exports**: `list`, `get`
- **Dependencies**: none (scripts bundled as string constants)
- **Interface**:

  ```typescript
  export namespace WorkflowBuiltin {
    type Script = { name: string; source: string; description: string }

    function list(): Script[]
    function get(name: string): Script | undefined
  }
  ```

### Component 5: Persistence

- **File**: `src/workflow/persistence.ts`
- **Type**: Pure Module (namespace with DB operations)
- **Exports**: `recordStart`, `recordPhase`, `flushCounters`, `recordTerminal`, `list`, `load`, `writeScript`, `readScript`, `appendJournal`, `loadJournal`, `clearJournal`
- **Dependencies**: `Database`, `WorkflowRunTable`, `Global.Path`
- **Interface**:

  ```typescript
  export namespace WorkflowPersistence {
    type RunStatus = "running" | "completed" | "failed" | "cancelled"

    function recordStart(input: {
      id: WorkflowRunID
      session: SessionID
      name: string
      script: string
      args: unknown
      timeout: number
      parent?: string
    }): void

    function recordPhase(id: WorkflowRunID, phase: string): void
    function flushCounters(id: WorkflowRunID, counts: { running: number; succeeded: number; failed: number }): void
    function recordTerminal(id: WorkflowRunID, status: RunStatus, error?: string): void

    function list(session?: SessionID): WorkflowRun[]
    function load(id: WorkflowRunID): WorkflowRun | undefined

    function writeScript(sha: string, source: string): void
    function readScript(sha: string): string | undefined

    function appendJournal(id: WorkflowRunID, entry: JournalEntry): void
    function loadJournal(id: WorkflowRunID): JournalEntry[]
    function clearJournal(id: WorkflowRunID): void
  }
  ```

### Component 6: Workspace (File Hooks)

- **File**: `src/workflow/workspace.ts`
- **Type**: Pure Module
- **Exports**: `resolveInWorkspace`, `makeFileHooks`
- **Dependencies**: `fs`, `path`, `Glob`
- **Interface**:

  ```typescript
  export namespace WorkflowWorkspace {
    type FileHooks = {
      readFile: (path: string) => string
      writeFile: (path: string, content: string) => void
      exists: (path: string) => boolean
      glob: (pattern: string) => string[]
    }

    function resolveInWorkspace(root: string, target: string): string | undefined
    function makeFileHooks(root: string): FileHooks
  }
  ```

### Component 7: Events

- **File**: `src/workflow/events.ts`
- **Type**: Pure Module (BusEvent definitions)
- **Exports**: `WorkflowEvent`
- **Dependencies**: `BusEvent`, `zod`
- **Interface**:
  ```typescript
  export namespace WorkflowEvent {
    const Started: BusEvent.Definition // { runID, name, sessionID }
    const Finished: BusEvent.Definition // { runID, name, status, error? }
    const Phase: BusEvent.Definition // { runID, phase }
    const Log: BusEvent.Definition // { runID, level, message }
    const AgentFailed: BusEvent.Definition // { runID, agent, error }
    const ChildFailed: BusEvent.Definition // { runID, child, error }
  }
  ```

### Component 8: Workflow Runtime Service

- **File**: `src/workflow/runtime.ts`
- **Type**: Effect Service (ServiceMap pattern)
- **Exports**: `WorkflowRuntime.Service`, `WorkflowRuntime.layer`, `WorkflowRuntime.defaultLayer`
- **Dependencies**: `Bus.Service`, `Config.Service`, `Session.Service`, `Sandbox`, `WorkflowPersistence`, `WorkflowResolve`, `WorkflowWorkspace`
- **Interface**:

  ```typescript
  export namespace WorkflowRuntime {
    interface Interface {
      readonly start: (input: {
        name: string
        args?: Record<string, unknown>
        session: SessionID
        parent?: string
        concurrent?: number
        timeout?: number
      }) => Effect.Effect<WorkflowRunID>

      readonly status: (id: WorkflowRunID) => Effect.Effect<WorkflowRun | undefined>
      readonly wait: (id: WorkflowRunID, signal?: AbortSignal) => Effect.Effect<WorkflowRun>
      readonly cancel: (id: WorkflowRunID) => Effect.Effect<void>
      readonly list: (session?: SessionID) => Effect.Effect<WorkflowRun[]>
      readonly resume: (id: WorkflowRunID) => Effect.Effect<WorkflowRunID>
    }

    class Service extends ServiceMap.Service<Service, Interface>()("@opencode/WorkflowRuntime") {}
  }
  ```

### Component 9: Runtime Ref (late binding)

- **File**: `src/workflow/runtime-ref.ts`
- **Type**: Pure Module
- **Exports**: `WorkflowRuntimeRef`
- **Dependencies**: none (lazy reference holder)
- **Interface**:

  ```typescript
  export namespace WorkflowRuntimeRef {
    type Ref = {
      start: WorkflowRuntime.Interface["start"]
      status: WorkflowRuntime.Interface["status"]
      cancel: WorkflowRuntime.Interface["cancel"]
    }

    let current: Ref | undefined
    function set(ref: Ref): void
    function get(): Ref | undefined
  }
  ```

### Component 10: Workflow Tool

- **File**: `src/tool/workflow.ts`
- **Type**: Tool (Tool.define pattern)
- **Exports**: `WorkflowTool`
- **Dependencies**: `Tool`, `WorkflowRuntimeRef`, `WorkflowResolve`, `WorkflowMeta`
- **Interface**:
  ```typescript
  export const WorkflowTool = Tool.define("workflow", {
    description: string, // from src/tool/workflow.txt
    parameters: z.object({
      script: z.string().describe("Workflow script name or inline JS"),
      args: z.record(z.string(), z.unknown()).optional(),
      wait: z.boolean().optional().default(true),
      max_concurrent_agents: z.number().int().positive().optional(),
    }),
    execute: (args, ctx) => Promise<{ title: string; metadata: {}; output: string }>,
  })
  ```

### Component 11: Schema & ID

- **File**: `src/workflow/schema.ts`
- **Type**: Schema
- **Exports**: `WorkflowRunID`
- **Dependencies**: `zod`
- **Interface**:
  ```typescript
  export type WorkflowRunID = string & { readonly __tag: "WorkflowRunID" }
  export const WorkflowRunID = {
    generate: (): WorkflowRunID => `wfrun_${crypto.randomUUID()}` as WorkflowRunID,
    make: (id: string): WorkflowRunID => id as WorkflowRunID,
    zod: z
      .string()
      .startsWith("wfrun_")
      .transform((s) => s as WorkflowRunID),
  }
  ```

## Data Flow

### Start Workflow (main path)

| Step | Component              | Action                                           | Next                |
| ---- | ---------------------- | ------------------------------------------------ | ------------------- |
| 1    | WorkflowTool           | Parse args, validate script name                 | WorkflowRuntimeRef  |
| 2    | WorkflowRuntime.start  | Acquire semaphore slot, resolve script           | WorkflowResolve     |
| 3    | WorkflowResolve        | Walk up dirs for `.opencode/workflows/<name>.js` | WorkflowMeta        |
| 4    | WorkflowMeta           | Parse header meta + body from script             | WorkflowPersistence |
| 5    | WorkflowPersistence    | recordStart, writeScript (content-keyed dedup)   | Sandbox             |
| 6    | Sandbox.eval           | Inject hooks, run PRELUDE + body in QuickJS WASM | Hooks               |
| 7    | Agent hook (in-script) | spawnSubagent via task-spawn, await result       | Journal             |
| 8    | WorkflowPersistence    | appendJournal entry per completed agent          | Bus                 |
| 9    | WorkflowEvent.Finished | Publish terminal event, release semaphore        | Tool output         |

### Resume Workflow

| Step | Component              | Action                                                   | Next     |
| ---- | ---------------------- | -------------------------------------------------------- | -------- |
| 1    | WorkflowRuntime.resume | Load run, verify sha match                               | Journal  |
| 2    | WorkflowPersistence    | loadJournal → replay entries                             | Sandbox  |
| 3    | Sandbox.eval           | Re-run script; journal entries short-circuit agent hooks | Continue |
| 4    | Agent hook             | Skip if journal has result, else execute fresh           | Finish   |

**Error Flows**:

- Memory OOM in QuickJS → Sandbox returns error, runtime records `failed` status
- Deadline exceeded → Sandbox kills VM, runtime records `failed`, publishes AgentFailed
- Agent hook failure → Configurable: fail-fast (default) or continue; recorded in journal
- Journal sha mismatch on resume → Clear journal, start fresh run
- Semaphore full → Queued with backpressure, respects abort signal

## Database Schema

```typescript
// src/workflow/workflow.sql.ts
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/session.sql"
import { Timestamps } from "../storage/schema.sql"
import type { WorkflowRunID } from "./schema"
import type { SessionID } from "../session/schema"

export const WorkflowRunTable = sqliteTable(
  "workflow_run",
  {
    id: text().$type<WorkflowRunID>().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    status: text().notNull().default("running"),
    running: integer().notNull().default(0),
    succeeded: integer().notNull().default(0),
    failed: integer().notNull().default(0),
    current_phase: text(),
    parent_actor_id: text(),
    args: text(), // JSON-serialized
    script_sha: text().notNull(),
    agent_timeout_ms: integer().notNull().default(300000),
    error: text(),
    ...Timestamps,
  },
  (table) => [
    index("workflow_run_session_idx").on(table.session_id),
    index("workflow_run_status_idx").on(table.status),
  ],
)
```

Journal stored as JSONL files (not DB) at:
`~/.local/share/opencode/workflow/<runID>/journal.jsonl`

Script content stored content-addressed:
`~/.local/share/opencode/workflow/scripts/<sha>.js`

## Configuration

```typescript
// Addition to experimental schema in src/config/config.ts
workflow: z.boolean().optional().describe("Enable QuickJS sandboxed workflow engine"),
workflow_max_concurrent_agents: z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Max concurrent agent hooks per workflow (default: 5)"),
workflow_agent_timeout_ms: z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Per-agent timeout in ms within workflow (default: 300000)"),
workflow_max_depth: z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Max nested workflow depth (default: 3)"),
```

## Feature Flag

- **Flag name**: `OPENCODE_EXPERIMENTAL_WORKFLOWS`
- **Env var**: `OPENCODE_EXPERIMENTAL_WORKFLOWS`
- **Pattern**: `enabledByExperimental` (inherits from `OPENCODE_EXPERIMENTAL`)
- **Gating behavior**:
  - Runtime layer initializes as no-op when disabled (WASM not loaded)
  - Tool excluded from registry when flag is false
  - Config keys still parseable but ignored

```typescript
// Addition to src/flag/flag.ts
export const OPENCODE_EXPERIMENTAL_WORKFLOWS = enabledByExperimental("OPENCODE_EXPERIMENTAL_WORKFLOWS")
```

## Integration Points

| File                               | Function/Location                            | Integration                                                                                              |
| ---------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/flag/flag.ts`                 | After line 86                                | Add `OPENCODE_EXPERIMENTAL_WORKFLOWS` const                                                              |
| `src/config/config.ts`             | Experimental schema (~line 1660)             | Add `workflow`, `workflow_max_concurrent_agents`, `workflow_agent_timeout_ms`, `workflow_max_depth` keys |
| `src/tool/registry.ts`             | Tool list (~line 197)                        | Add `...(Flag.OPENCODE_EXPERIMENTAL_WORKFLOWS ? [WorkflowTool] : [])`                                    |
| `src/storage/db.ts`                | Schema imports                               | Import `WorkflowRunTable` for migration                                                                  |
| `drizzle.config.ts`                | Schema glob already covers `src/**/*.sql.ts` | Auto-discovered                                                                                          |
| `src/orchestration/task-spawn.ts`  | Used by agent hook                           | Spawn subagents for workflow script `agent()` calls                                                      |
| `src/orchestration/concurrency.ts` | Used by runtime                              | Global semaphore for concurrent workflow runs                                                            |
| `src/bus/`                         | Subscriptions                                | TUI subscribes to WorkflowEvent for toasts                                                               |

## Error Handling

| Error                  | Source          | Handling                                                          |
| ---------------------- | --------------- | ----------------------------------------------------------------- |
| Script not found       | WorkflowResolve | Return tool error "Workflow script not found: {name}"             |
| Invalid meta           | WorkflowMeta    | Return tool error with line/column                                |
| OOM (memory limit)     | Sandbox         | Kill VM, status=failed, error="Memory limit exceeded ({limit}MB)" |
| Deadline exceeded      | Sandbox         | Kill VM, status=failed, error="Deadline exceeded ({ms}ms)"        |
| Agent hook timeout     | Runtime         | Record in journal as failed, optionally continue or fail-fast     |
| Journal corruption     | Persistence     | Skip malformed JSONL lines, log warning, continue                 |
| SHA mismatch on resume | Runtime         | Clear journal, restart fresh (log info)                           |
| Semaphore timeout      | Runtime         | Tool returns "Workflow queue full, try later"                     |
| Nested depth exceeded  | Runtime         | Reject start, error="Max workflow depth ({n}) exceeded"           |

## Constraints

- **Upstream-rebase safe**: All new files live in `src/workflow/`. Only additive single-line touches to `flag.ts` (one const), `config.ts` (optional schema keys), `registry.ts` (one gated array spread). No existing function signatures modified.
- **Provider cache**: Zero impact. Workflow execution is entirely host-side; no changes to message serialization, system prompts, or model call paths.
- **Performance**: WASM loaded lazily on first workflow eval (not at startup). QuickJS-emscripten is ~2MB; zero cost when flag disabled. Global semaphore prevents runaway parallelism. Memory cap per VM prevents host OOM.

## Decisions

| Decision        | Choice                      | Reason                                                                  | Alternatives                   | Tradeoffs                                                        |
| --------------- | --------------------------- | ----------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------- |
| Sandbox engine  | quickjs-emscripten (WASM)   | Zero native compilation, works on all platforms, deterministic          | V8 isolates, Deno subprocesses | Slower than V8 but safer isolation, no build deps                |
| Journal format  | JSONL files on disk         | Simple append, crash-resilient (skip bad lines), human-readable         | SQLite blob, DB table          | File I/O overhead vs atomicity; acceptable for sequential append |
| Script storage  | Content-addressed (SHA)     | Dedup identical scripts, detect changes on resume                       | Path-based, DB blob            | Extra SHA computation; negligible cost                           |
| Service pattern | ServiceMap (Effect)         | Matches SessionCompaction, Config patterns; testable layers             | Plain namespace (like Goal)    | More boilerplate; worth it for testability and DI                |
| Hook bridge     | Sync-promise via arena pump | QuickJS is synchronous; must park guest while async host work completes | Worker threads, subprocess     | Complexity of pump loop; proven pattern from MiMo                |
| Semaphore       | Global concurrency limiter  | Prevent host resource exhaustion from parallel workflows                | Per-session limits             | Simple; can refine later                                         |
| Lazy WASM load  | Load on first eval          | Zero startup cost when workflows unused                                 | Eager load behind flag         | First workflow has ~100ms load penalty                           |

## Risks

| Risk                                | Impact                              | Likelihood | Mitigation                                                              |
| ----------------------------------- | ----------------------------------- | ---------- | ----------------------------------------------------------------------- |
| quickjs-emscripten WASM size (~2MB) | Binary size increase                | Certain    | Lazy-load; tree-shake when flag disabled; acceptable for experimental   |
| Host promise starvation             | VM idle-spins pump timer            | Medium     | Adaptive pump cadence (fast→slow backoff)                               |
| Journal corruption on crash         | Lost replay state                   | Low        | JSONL format + skip malformed lines; fresh run on corruption            |
| Symlink jail escape                 | File access outside workspace       | Low        | Lexical path check only; document limitation; harden post-graduation    |
| Resume determinism failure          | Stale journal replays wrong results | Low        | SHA mismatch triggers fresh journal; seeded PRNG keyed on runID         |
| Memory leak in QuickJS handles      | Host memory growth                  | Medium     | Arena + deferred tracking; unit test asserts no alive handles post-eval |
| WASM compatibility (older Node/Bun) | Runtime crash                       | Low        | quickjs-emscripten supports all modern runtimes; Bun 1.x has full WASM  |

## Test Plan

### Unit Tests

**Sandbox** (`test/workflow/sandbox.test.ts`):

- Basic eval returns value
- Hook injection (sync + async) called correctly
- Marshal round-trip (primitives, objects, arrays, null, undefined)
- Memory limit triggers OOM error
- Deadline timeout kills execution
- PRNG produces same sequence with same seed
- PRNG differs with different seed
- Determinism: no Date, no Math.random, no WeakRef
- Arena cleanup: no alive handles after dispose

**Meta Parser** (`test/workflow/meta.test.ts`):

- Valid script with all fields parses correctly
- Missing optional fields default cleanly
- Malformed header returns ParseError with line number
- Empty script (no meta) returns empty meta + full body
- Edge case: meta-like content inside function body ignored

**Persistence** (`test/workflow/persistence.test.ts`):

- recordStart + load round-trip
- recordPhase updates current_phase
- flushCounters increments correctly
- recordTerminal sets status + error
- list filters by session
- writeScript deduplicates by SHA
- Journal append/load/clear cycle
- Journal skip malformed lines on load

**Resolve** (`test/workflow/resolve.test.ts`):

- Finds script in `.opencode/workflows/`
- Walk-up stops at filesystem root
- safeName rejects `../` and absolute paths
- Returns undefined for nonexistent script

**Workspace** (`test/workflow/workspace.test.ts`):

- resolveInWorkspace blocks jail escape (`../`)
- makeFileHooks.readFile reads within workspace
- makeFileHooks.writeFile writes within workspace
- makeFileHooks.glob returns only workspace-relative paths

### Integration Tests

**Runtime** (`test/workflow/runtime.test.ts`):

- Full lifecycle: start → agent hooks (mocked) → journal → completion
- Resume replays journal entries, skips completed agents
- Cancel mid-execution terminates sandbox
- Nested workflow (workflow calls workflow) respects depth limit
- Concurrent agents limited by semaphore
- SHA mismatch triggers fresh run

**Tool** (`test/workflow/tool.test.ts`):

- Tool invocation with named script
- Tool invocation with wait=false returns immediately
- Script not found returns error
- Flag disabled → tool not in registry

### End-to-End Tests

- User runs `/workflow start pipeline` → toast shows started → agents execute → toast shows complete
- Resume after simulated crash replays journal correctly
- Workflow with 3 parallel agents completes with correct counters

### Non-Functional Tests

- **Performance**: First eval < 200ms (WASM cold load); subsequent < 50ms
- **Memory**: Single VM stays under configured cap (default 64MB)
- **Security**: Guest cannot access host filesystem without explicit hooks
- **Determinism**: Same script + same seed + same inputs = identical PRNG sequence across runs
