# HLD: Deterministic Workflow Execution as Background Subagent

## Tech Stack

| Category  | Technology     | Purpose                                     |
| --------- | -------------- | ------------------------------------------- |
| Language  | TypeScript 5.8 | Existing codebase language                  |
| Framework | Effect-ts 4.0  | Service composition, BackgroundJob runtime  |
| Sandbox   | QuickJS (WASM) | Deterministic script execution              |
| Runtime   | Bun            | Native SQLite, fast async                   |
| Database  | SQLite/Drizzle | Session + message persistence via SyncEvent |
| TUI       | @opentui/solid | Background task rendering (unchanged)       |

## Components

| Component                  | Responsibility                                         | Dependencies                           |
| -------------------------- | ------------------------------------------------------ | -------------------------------------- |
| Workflow Tool (rewritten)  | Spawn background subagent, register job, return        | spawnSubagent, BackgroundJob, TuiEvent |
| WorkflowSessionWriter      | Write synthetic messages/parts into workflow session   | SyncEvent, MessageV2                   |
| WorkflowRuntime (modified) | Execute sandbox, write transcript, call LLM for agents | Sandbox, SessionPrompt, SessionWriter  |

**NOT modified:** Task tool, executor.ts, factory.ts, BackgroundExecutor.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Parent Session                                               │
│  ┌─────────────────────┐                                     │
│  │ Workflow Tool        │ ← /workflow command or LLM call     │
│  │  - resolve script   │                                     │
│  │  - spawnSubagent    │ ← creates child session             │
│  │  - BackgroundJob    │ ← registers fiber                   │
│  │  - return output    │ ← immediate (background)            │
│  └──────────┬──────────┘                                     │
└─────────────┼────────────────────────────────────────────────┘
              │ BackgroundJob fiber executes...
              ▼
┌──────────────────────────────────────────────────────────────┐
│  Workflow Session (child)                                      │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  WorkflowRuntime.executeInSession(sessionID, script)     │ │
│  │                                                          │ │
│  │  phase("lint") ──→ SessionWriter.writePhase()            │ │
│  │    ↓ synthetic assistant message: "## Phase: lint"       │ │
│  │                                                          │ │
│  │  log("info", "..") → SessionWriter.appendLog()           │ │
│  │    ↓ append text to current assistant message            │ │
│  │                                                          │ │
│  │  bash("cmd") ──→ spawn process, SessionWriter.writeTool()│ │
│  │    ↓ tool part: {tool:"bash", input:{cmd}, output:...}   │ │
│  │                                                          │ │
│  │  agent("build", {prompt}) ─→ SessionPrompt.prompt()      │ │
│  │    ↓ REAL user msg + REAL assistant response (with tools)│ │
│  │    ↓ LLM runs inline, full tool loop in same session     │ │
│  │                                                          │ │
│  │  ✓ Complete → SessionWriter.writeStatus("completed")     │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
              │
              ▼ BackgroundJob completes
┌──────────────────────────────────────────────────────────────┐
│  TUI                                                          │
│  - BackgroundTaskUpdate event → counter + toast               │
│  - User navigates to workflow session → full transcript       │
│  - Phases = assistant text, tools = tool parts, agent = LLM  │
└──────────────────────────────────────────────────────────────┘
```

## Interfaces

### Workflow Tool (rewritten — standalone, mirrors Task tool background path)

```typescript
// src/tool/workflow.ts
// Uses Tool.defineEffect for Effect runtime context (InstanceState, Bus)
export const WorkflowTool = Tool.defineEffect(
  "workflow",
  Effect.gen(function* () {
    return {
      parameters: z.object({
        script: z.string(),
        args: z.record(z.string(), z.unknown()).optional(),
        max_concurrent_agents: z.number().int().positive().optional(),
      }),
      async execute(args, ctx) {
        // 1. Check WorkflowRuntimeRef initialized
        // 2. spawnSubagent({ parentSessionID: ctx.sessionID, agent, description })
        // 3. ctx.metadata({ sessionId, background: true })  ← triggers <Task> component
        // 4. Instance.bind + BackgroundJob.start({ run: makeRun() })
        // 5. Bus.publish(TuiEvent.BackgroundTaskUpdate, { state: "running" })
        // 6. Release spawn slot
        // 7. Return backgroundOutput(sessionID)
      },
    }
  }),
)
```

Key: the metadata shape `{ sessionId: string, background: true }` is what makes the
TUI `<Task>` component render this as a navigable background subagent. Same shape as
Task tool uses.

### WorkflowSessionWriter (new)

```typescript
// src/workflow/session-writer.ts
import type { SessionID, MessageID } from "../session/schema"

export namespace WorkflowSessionWriter {
  export type Context = {
    sessionID: SessionID
    agent: string // "build" — for assistant message metadata
  }

  /** Write a phase header as a new synthetic assistant message */
  export function writePhase(ctx: Context, phase: string): void

  /** Append log text to the current assistant message */
  export function appendLog(ctx: Context, level: string, message: string): void

  /** Write a completed tool part (bash/read/write) to current assistant message */
  export function writeTool(
    ctx: Context,
    input: {
      tool: string
      args: Record<string, unknown>
      output: string
      title: string
      duration: number
    },
  ): void

  /** Write final status message (completed/failed) */
  export function writeStatus(ctx: Context, status: "completed" | "failed", error?: string): void
}
```

### Workflow Tool (rewritten interface)

```typescript
// src/tool/workflow.ts — execute signature unchanged, internals rewritten
// Parameters stay the same: { script, args, max_concurrent_agents }
// execute() now:
//   1. Resolves Task tool from registry
//   2. Calls task.execute with runner: "deterministic" + background: true
//   3. Returns backgroundOutput immediately
```

### WorkflowRuntime.executeInSession (new method)

```typescript
// Added to src/workflow/runtime.ts
export namespace WorkflowRuntime {
  /** Execute workflow script writing all output into the given session */
  export async function executeInSession(input: {
    sessionID: SessionID
    name: string
    args?: Record<string, unknown>
    timeout: number
    signal: AbortSignal
  }): Promise<string>
}
```

## Data Flow

| Step | Component             | Action                                              | Next          |
| ---- | --------------------- | --------------------------------------------------- | ------------- |
| 1    | /workflow command     | User selects script, invokes workflow tool          | Workflow Tool |
| 2    | Workflow Tool         | Resolves script, gets Task tool from registry       | Task Tool     |
| 3    | Task Tool             | Calls `spawnSubagent` → creates child session       | Executor      |
| 4    | Task Tool             | Detects `extra.runner === "deterministic"`          | Factory       |
| 5    | createExecutor        | Returns `DeterministicExecutor` (background mode)   | Executor      |
| 6    | DeterministicExecutor | Registers BackgroundJob, publishes running event    | Runner fn     |
| 7    | Runner fn (closure)   | Calls `WorkflowRuntime.executeInSession(sessionID)` | Runtime       |
| 8    | Runtime: phase()      | `SessionWriter.writePhase()` → SyncEvent.run        | Sandbox       |
| 9    | Runtime: log()        | `SessionWriter.appendLog()` → SyncEvent.run         | Sandbox       |
| 10   | Runtime: bash()       | Spawns process, `SessionWriter.writeTool()`         | Sandbox       |
| 11   | Runtime: agent()      | `SessionPrompt.prompt({sessionID, parts})` inline   | LLM           |
| 12   | LLM response          | Real assistant message written to session (normal)  | Sandbox       |
| 13   | Runtime: complete     | `SessionWriter.writeStatus("completed")`            | Executor      |
| 14   | DeterministicExecutor | BackgroundJob completes, publishes toast + update   | TUI           |
| 15   | TUI                   | Toast notification, background counter decrements   | User          |

**Error Flows**:

- Step 7-13 throws → Step 14 publishes "error" state + error toast
- agent() timeout → SessionPrompt.cancel(sessionID), error propagates to step 14
- AbortSignal fires → sandbox deadline hit, error propagates
- Script parse error → thrown at step 7 before sandbox eval, caught by executor

## Data Model

No new tables. Uses existing:

| Entity      | Usage                                           |
| ----------- | ----------------------------------------------- |
| Session     | Workflow session = child of parent session      |
| Message     | Synthetic + real messages in workflow session   |
| Part        | Tool parts (bash/read/write) + text parts       |
| WorkflowRun | Existing persistence (unchanged for journaling) |

Synthetic messages written via `SyncEvent.run(MessageV2.Event.Updated, ...)` — same pattern as `Session.updateMessage`.

## Changes to Existing Code

| File                             | Change                                                                                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/tool/workflow.ts`           | **REWRITE**: Standalone tool using `Tool.defineEffect`. spawnSubagent + BackgroundJob.start + TuiEvent. Same patterns as BackgroundExecutor but inline. ~120 lines.                     |
| `src/workflow/session-writer.ts` | **NEW**: `writePhase`, `appendLog`, `writeTool`, `writeStatus`. Uses `SyncEvent.run`. ~60 lines.                                                                                        |
| `src/workflow/runtime.ts`        | Modify `executeInSession()` to use SessionWriter. Agent hook calls `SessionPrompt.prompt` inline (same session, not child). Remove `spawnSubagent` from agent steps. ~40 lines changed. |

**NOT modified:** `src/tool/task.ts`, `src/orchestration/*`, `src/session/prompt.ts`.

## Message Writing Strategy

### Synthetic Assistant Messages (phases, logs, status)

```typescript
// Create a new assistant message for each phase
const msg: MessageV2.Assistant = {
  id: MessageID.ascending(),
  sessionID,
  role: "assistant",
  time: { created: Date.now() },
  parentID: MessageID.make("00000000000000000000000000"), // no real parent
  modelID: ModelID.make("workflow"),
  providerID: ProviderID.make("workflow"),
  mode: "workflow",
  agent: "build",
  path: { cwd: Instance.directory, root: Instance.directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
}

SyncEvent.run(MessageV2.Event.Updated, { sessionID, info: msg })

// Then add text part
const part: MessageV2.TextPart = {
  id: PartID.ascending(),
  sessionID,
  messageID: msg.id,
  type: "text",
  text: `## Phase: ${phase}`,
  synthetic: true,
}

SyncEvent.run(MessageV2.Event.PartUpdated, { sessionID, part, time: Date.now() })
```

### Tool Parts (bash, read, write)

```typescript
const part: MessageV2.ToolPart = {
  id: PartID.ascending(),
  sessionID,
  messageID: currentMessageID,
  type: "tool",
  callID: ulid(),
  tool: "bash",
  state: {
    status: "completed",
    input: { command: "npm test" },
    output: stdout,
    title: "npm test",
    metadata: {},
    time: { start: t0, end: t1 },
  },
}

SyncEvent.run(MessageV2.Event.PartUpdated, { sessionID, part, time: Date.now() })
```

### Agent Steps (real LLM)

```typescript
// agent() hook simply calls SessionPrompt.prompt on the SAME workflow session
const result = await SessionPrompt.prompt({
  messageID: MessageID.ascending(),
  sessionID: workflowSessionID, // NOT a child session
  parts: [{ type: "text", text: prompt }],
})
// SessionPrompt handles writing user msg + assistant response + tool parts
// Result is a real assistant message with full tool loop
```

Key insight: `SessionPrompt.prompt` writes its own messages (user + assistant) via SyncEvent internally. We just call it on the workflow session directly. The LLM sees all previous synthetic messages + previous agent responses as context.

## Decisions

| Decision                           | Choice                          | Reason                                                             | Alternatives                                 | Tradeoffs                                      |
| ---------------------------------- | ------------------------------- | ------------------------------------------------------------------ | -------------------------------------------- | ---------------------------------------------- |
| Executor vs inline check           | New DeterministicExecutor class | Clean separation, testable, follows existing pattern               | if/else in BackgroundExecutor                | Slightly more code but much cleaner            |
| Agent steps: same session vs child | Same session                    | LLM sees full context (phases, previous agents). Plan requirement. | Spawn child per agent() call (current impl)  | Context grows with steps; may need compaction  |
| Synthetic message providerID       | `"workflow"` literal            | Clearly marks non-LLM messages                                     | Reuse parent's providerID                    | Would confuse cost tracking                    |
| parentID for synthetic msgs        | Zero ULID sentinel              | No real parent user message exists                                 | Create fake user messages                    | Simpler; TUI renders assistant msgs standalone |
| runner param location              | `ctx.extra.runner` not schema   | Must NOT be exposed to LLM                                         | Add to params schema with internal-only flag | Extra strips from LLM view cleanly             |

## Risks

| Risk                                       | Impact                                | Likelihood         | Mitigation                                                                                        |
| ------------------------------------------ | ------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------- |
| Context overflow from agent steps          | LLM fails on 3rd+ agent call          | Medium             | Add optional compaction between agent steps (configurable)                                        |
| Synthetic messages break `toModelMessages` | LLM sees garbage in history           | Medium             | Use `synthetic: true` flag; verify toModelMessages handles synthetic assistant messages correctly |
| Concurrent sandbox access                  | Second workflow blocks first          | Low (mutex exists) | WorkflowRuntime already has global sandbox mutex; documented limitation                           |
| BackgroundJob ID collision                 | Two workflows same session ID         | Very Low           | Sessions have unique ULIDs; backgroundJob keyed by sessionID                                      |
| TUI rendering of synthetic messages        | Phase headers render wrong            | Low                | Synthetic messages use standard TextPart; TUI already renders these                               |
| SessionPrompt.prompt requires model        | Agent step fails without model config | Medium             | Let prompt() resolve model from session agent config (existing behavior when model param omitted) |

## Test Plan

### Unit Tests

**DeterministicExecutor** (`test/orchestration/executor/deterministic.test.ts`):

- Calls `run(sessionID)` and resolves with result text
- Publishes `TuiEvent.BackgroundTaskUpdate` with "running" on start
- Publishes "completed" + toast on success
- Publishes "error" + toast on failure
- Respects timeout (wraps with `withTimeout`)

**WorkflowSessionWriter** (`test/workflow/session-writer.test.ts`):

- `writePhase` creates assistant message + text part via SyncEvent
- `appendLog` adds text to existing message
- `writeTool` creates tool part with completed state
- `writeStatus` creates final status message
- All messages readable via `MessageV2.page({ sessionID })`

**Task Tool deterministic path** (`test/tool/task-deterministic.test.ts`):

- When `extra.runner === "deterministic"`: skips model resolution, skips prompt parts
- Passes `extra.run` to executor
- Returns `backgroundOutput(sessionID)` immediately

### Integration Tests

**Full workflow execution** (`test/workflow/workflow-subagent.test.ts`):

- Trigger workflow tool with simple script (phase + log + bash)
- Verify child session created with correct parentID
- Verify synthetic messages appear in session (phases, tool parts)
- Verify BackgroundJob completes with "completed" status
- Verify `WorkflowPersistence` records terminal state

**Agent step inline** (`test/workflow/workflow-agent-inline.test.ts`):

- Script calls `agent("build", { prompt: "..." })`
- Verify `SessionPrompt.prompt` called with workflow sessionID
- Verify assistant response written to same session
- Verify subsequent agent() call sees previous context

### End-to-End Tests

- /workflow command → background task appears → navigate to session → see phases + tools + agent responses
- Workflow failure mid-execution → session shows partial transcript + error status message
- Cancel workflow → AbortSignal fires → session shows cancellation

### Non-Functional Tests

- Timeout: workflow with 5s timeout + agent that takes 10s → fails with timeout error
- Memory: QuickJS 64MB cap still enforced
- Concurrency: two workflows queue (sandbox mutex), both complete sequentially

## Constraints

1. **No parallel agent() calls** — QuickJS asyncify supports one suspended call at a time. `agent()` calls serialize within a single workflow.
2. **No streaming for synthetic messages** — Phase/log messages write atomically (no delta events). Only real agent() steps stream via normal SessionPrompt behavior.
3. **Model resolution deferred to agent step** — Synthetic messages use `providerID: "workflow"`. Actual model selection happens inside `SessionPrompt.prompt()` using session config (model param is optional).
4. **Journal replay unchanged** — Existing `WorkflowPersistence` journal still tracks agent_complete for resume. The session transcript is a secondary view, not the replay source.
5. **No isolation support** — Deterministic executor doesn't support `worktree_isolation` (workflows manage their own workspace via `WorkflowWorkspace`).
6. **Always background** — Deterministic runner only supports background mode. No foreground deterministic path.
7. **No executor.ts/factory.ts changes** — DeterministicExecutor is standalone, bypasses the factory. ExecutionMode union and ExecuteInput type unchanged.

## Synthetic Messages and toModelMessages

When `agent()` steps call `SessionPrompt.prompt()`, the prompt system calls `toModelMessages` to build
the LLM context from session history. Synthetic messages written by the workflow runtime will be included.

**How this works correctly:**

- Synthetic assistant messages have `providerID: "workflow"`, `modelID: "workflow"`, `cost: 0`
- `toModelMessages` reads ALL messages in the session (it doesn't filter by providerID)
- Synthetic TextParts with `synthetic: true` are standard text parts — LLM sees them as previous assistant responses
- This is the DESIRED behavior: agent() steps see phase context and previous agent responses

**Edge case — context overflow:**

- After many phases + agent steps, context may overflow
- Mitigation: SessionPrompt already handles compaction. If context is too large, it compacts older messages automatically.
- Synthetic messages participate in compaction like any other message.
