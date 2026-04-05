# HLD: Safe Parallel Tool Calls

## Tech Stack

| Category  | Technology         | Purpose                                                                       |
| --------- | ------------------ | ----------------------------------------------------------------------------- |
| Language  | TypeScript 5.8.2   | Existing codebase language                                                    |
| Runtime   | Bun 1.3.11         | Existing runtime                                                              |
| Framework | Effect 4.0-beta.43 | Service/layer patterns, `Semaphore` for concurrency guards                    |
| AI SDK    | Vercel AI SDK 6.x  | Provider-specific `providerOptions` carry `parallelToolCalls` where supported |
| Schema    | Zod                | Config schema extensions in `experimental.*`                                  |
| Test      | bun:test           | Unit and integration tests                                                    |

## Components

| Component              | Responsibility                                                                | Dependencies                                               |
| ---------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `Tool.Info` (extended) | Declares per-tool `parallelSafe` metadata flag                                | None (type-level addition)                                 |
| `parallelGate`         | Decides whether a given LLM step can use parallel tool calls                  | `Permission.evaluate`, `Tool.Info`, `Config`, `Agent.Info` |
| `LLM.stream` (patched) | Computes gate result and injects provider-specific parallel-call options      | `parallelGate`, `ProviderTransform`                        |
| `ProviderTransform`    | Maps parallel tool-call intent into provider-specific `providerOptions` shape | `Provider.Model`, provider config                          |
| `FileTime` (audited)   | Existing file-time state; already uses `Semaphore` per-file locks             | `InstanceState`, `AppFileSystem`                           |
| `Config` (extended)    | New `experimental.parallel_tool_calls` and `experimental.parallel_read` flags | Zod schema                                                 |

## Architecture

```
                    ┌──────────────────────────────────────────┐
                    │           Provider (LLM API)             │
                    └──────────────────┬───────────────────────┘
                                       │ provider-specific parallel_tool_calls
                                       │ (sent via providerOptions when supported)
                                       ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         LLM.stream()                                 │
│                                                                      │
│  ┌─────────────────────────────────┐                                 │
│  │ parallelGate(agent, tools, cfg) │──▶ boolean                      │
│  │                                 │                                 │
│  │  1. Check experimental config   │                                 │
│  │  2. Check agent mode            │                                 │
│  │  3. Check all tools are         │                                 │
│  │     parallelSafe                │                                 │
│  │  4. Check all tool permissions  │                                 │
│  │     resolve to "allow" (no ask) │                                 │
│  └─────────────────────────────────┘                                 │
│                                                                      │
│  streamText({                                                        │
│    ...existing options,                                              │
│    providerOptions: ProviderTransform.providerOptions(               │
│      model,                                                          │
│      { ...options, ...parallelToolCallOptions(...) }                 │
│    )  ◀── NEW                                                        │
│  })                                                                  │
└──────────────────────────────────────────────────────────────────────┘
                                       │
                    ┌──────────────────┼──────────────────┐
                    │                  │                  │
                    ▼                  ▼                  ▼
             ┌───────────┐    ┌───────────┐     ┌───────────┐
             │   grep     │    │   glob    │     │   read    │
             │ parallel:  │    │ parallel: │     │ parallel: │
             │   true     │    │   true    │     │   true    │
             │            │    │           │     │ (guarded) │
             └───────────┘    └───────────┘     └───────────┘
                                                      │
                                                      ▼
                                              ┌───────────────┐
                                              │  FileTime     │
                                              │  (Semaphore   │
                                              │   per-file)   │
                                              └───────────────┘

Serial-only tools (bash, edit, write, task, etc.):
  parallelSafe = false → parallelGate returns false when any is active
```

**Description**: The design adds a single decision point (`parallelGate`) evaluated before each `streamText` call. When the gate returns `true`, `ProviderTransform` injects provider-specific `parallelToolCalls` request options for providers that already support them, and the SDK executes concurrent tool calls when the provider emits them. When `false`, behavior is unchanged (serial, one tool at a time).

The gate is conservative: it requires **all** active tools in the step to be marked `parallelSafe` **and** all their permissions to already resolve to `"allow"` (no interactive `ctx.ask` prompt needed). This eliminates permission race conditions entirely — if any tool might prompt the user, the entire step falls back to serial.

The `ProcessorContext.toolcalls` map in `processor.ts` already keys by `toolCallId`, so concurrent tool results are correctly associated regardless of completion order. No changes needed to the processor.

## Interfaces

### Tool.Info (extended type)

| Field          | Type                 | Default | Behavior                                   |
| -------------- | -------------------- | ------- | ------------------------------------------ |
| `parallelSafe` | `boolean` (optional) | `false` | When `true`, tool may execute concurrently |

### parallelGate (new function in `session/llm.ts`)

| Method         | Input                                                                                                                    | Output    | Behavior                                                                                                                                                                                                                                                                                                     | Errors |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| `parallelGate` | `toolMeta: Map<string, { parallelSafe: boolean }>`, `agent: Agent.Info`, `permission: Permission.Ruleset`, `cfg: Config` | `boolean` | Returns `true` only when: (1) `agent.parallelToolCalls ?? cfg.experimental.parallel_tool_calls ?? (agent.mode === "subagent")` resolves to `true`, (2) every active tool has `parallelSafe === true`, (3) every tool's permission evaluates to `"allow"` against the merged ruleset (no `"ask"` or `"deny"`) | None   |

### Config (extended schema)

| Field                              | Type                 | Default                                   | Behavior                                                                                       |
| ---------------------------------- | -------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `experimental.parallel_tool_calls` | `boolean` (optional) | `true` for subagents, `false` for primary | Master switch for parallel tool call support                                                   |
| `experimental.parallel_read`       | `boolean` (optional) | `false`                                   | Enables read tool to be marked `parallelSafe`                                                  |
| `provider.<id>.parallelToolCalls`  | `boolean` (optional) | `undefined`                               | Enables explicit provider opt-out/override for provider-specific parallel-call request options |
| `agent.<name>.parallelToolCalls`   | `boolean` (optional) | `undefined`                               | Enables explicit per-agent opt-in/opt-out ahead of mode/default behavior                       |

### LLM.StreamInput (extended type)

| Field      | Type                                     | Default     | Behavior                                             |
| ---------- | ---------------------------------------- | ----------- | ---------------------------------------------------- |
| `toolMeta` | `Map<string, { parallelSafe: boolean }>` | `undefined` | Per-tool metadata passed from tool resolution to LLM |

## Data Flow

### Happy Path: Parallel grep + glob in subagent

| Step | Component            | Action                                                                                        | Next                |
| ---- | -------------------- | --------------------------------------------------------------------------------------------- | ------------------- |
| 1    | `SessionPrompt.loop` | Resolves tools for the current agent step                                                     | `resolveTools`      |
| 2    | `resolveTools`       | Builds AI SDK tool map + collects `toolMeta` from `Tool.Info.parallelSafe` flags              | `LLM.stream`        |
| 3    | `LLM.stream`         | Calls `parallelGate(toolMeta, agent, permission, cfg)` → returns `true`                       | `ProviderTransform` |
| 4    | `ProviderTransform`  | Adds provider-specific `parallelToolCalls` request options unless provider config disables it | `streamText`        |
| 5    | `streamText`         | Sends request with provider-specific parallel-call options                                    | Provider            |
| 6    | Provider             | Returns response with 2+ tool calls in single assistant message                               | AI SDK              |
| 7    | AI SDK               | Executes `grep.execute()` and `glob.execute()` concurrently (Promise.all internally)          | `processor`         |
| 8    | `processor`          | Receives `tool-call`, `tool-result` events keyed by `toolCallId`; updates parts correctly     | `finish-step`       |
| 9    | `finish-step`        | Step completes, loop continues with tool results in context                                   | Next iteration      |

### Fallback: Mixed grep + bash in same step

| Step | Component            | Action                                                                  | Next           |
| ---- | -------------------- | ----------------------------------------------------------------------- | -------------- |
| 1    | `SessionPrompt.loop` | Resolves tools including bash (`parallelSafe: false`)                   | `resolveTools` |
| 2    | `resolveTools`       | Builds tool map; `toolMeta` includes bash with `parallelSafe: false`    | `LLM.stream`   |
| 3    | `LLM.stream`         | `parallelGate` → `false` (bash is not parallel-safe)                    | `streamText`   |
| 4    | `streamText`         | Omits provider-specific parallel-call options (default serial behavior) | Provider       |
| 5    | Provider             | Returns tool calls one at a time                                        | AI SDK         |
| 6    | AI SDK               | Executes each tool serially                                             | `processor`    |

### Fallback: Permission requires ask

| Step | Component    | Action                                                                        | Next         |
| ---- | ------------ | ----------------------------------------------------------------------------- | ------------ |
| 1    | `LLM.stream` | `parallelGate` checks permission for `read` on `*.env` → evaluates to `"ask"` | `streamText` |
| 2    | `streamText` | No provider-specific parallel-call option — serial execution                  | Provider     |

**Error Flows**:

- If a parallel tool call fails (e.g., file not found in grep), the AI SDK handles it per-tool — the error is returned as a tool-result error for that specific `toolCallId`. Other concurrent tools are unaffected.
- If a permission is rejected during a parallel step (should not happen due to gate, but defensively): `Permission.RejectedError` propagates through the tool's promise, sets `ctx.blocked`, and the processor handles it in `tool-error` event as it does today.
- If the abort signal fires during parallel execution, all concurrent tool promises receive the abort signal (they share `ctx.abort`), matching existing behavior.

## Data Model

No new database entities. Changes are type-level only.

| Entity      | Fields                                        | Relationships | Constraints                                 |
| ----------- | --------------------------------------------- | ------------- | ------------------------------------------- |
| `Tool.Info` | `+parallelSafe?: boolean`                     | None          | Optional, defaults to `false` if omitted    |
| `Config`    | `+experimental.parallel_tool_calls?: boolean` | None          | Optional, no migration needed (JSON config) |
| `Config`    | `+experimental.parallel_read?: boolean`       | None          | Optional, no migration needed (JSON config) |

## Decisions

| Decision                        | Choice                                                                            | Reason                                                                                                      | Alternatives                                                      | Tradeoffs                                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Gate location                   | Inside `LLM.stream()`, evaluated per-request                                      | Single point of control; `streamText` already receives all options here; no changes to processor needed     | Per-step in processor; per-tool in registry                       | Per-request is coarser (all-or-nothing per step), but simpler and safer                                  |
| Tool metadata approach          | `parallelSafe` flag on `Tool.Info`                                                | Explicit opt-in per tool; easy to audit; follows existing `Tool.Info` pattern                               | Allowlist in config; dynamic detection based on tool name         | Requires touching each tool definition, but only 3 tools (grep, glob, read) need it in Phase 1-3         |
| Permission pre-check            | Evaluate all tool permissions statically before stream                            | Eliminates race conditions entirely; no concurrent `ctx.ask` prompts                                        | Lock-based concurrent ask; queue-based serial ask during parallel | Slightly conservative (falls back to serial if any tool needs ask), but correctness over performance     |
| `parallelToolCalls` resolution  | Computed dynamically per `streamText` call                                        | Different steps may have different tool sets; agent may switch between primary/subagent                     | Static per-session; static per-agent                              | Small overhead per call (permission evaluation), but negligible vs LLM latency                           |
| Read tool concurrency           | Behind `experimental.parallel_read` flag; FileTime already has per-file Semaphore | Read has side effects (LSP warm, file-time writes, instruction overlay); Semaphore already guards file-time | Always parallel; never parallel                                   | Conservative default (off) protects against undiscovered races; can enable once audited                  |
| Default for primary vs subagent | `true` for subagents, `false` for primary                                         | Subagents have pre-approved permissions (no interactive prompts); primary agents may need user interaction  | Same default for both; config-only                                | Subagents benefit most from parallelism; primary agents rarely have multiple read-only calls in one step |
| No processor changes            | `ProcessorContext.toolcalls` already keyed by `toolCallId`                        | AI SDK associates results by ID, not position; processor handles events correctly regardless of order       | Add ordering guarantees in processor                              | Relies on AI SDK's existing contract; verified by reading processor code                                 |

## Risks

| Risk                                    | Impact                                                                            | Likelihood | Mitigation                                                                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Provider doesn't support parallel calls | Provider ignores provider option or errors                                        | Low        | Only inject provider-specific options for currently supported mappings; per-provider override can explicitly disable in Phase 4 |
| Read tool state corruption              | File-time tracking produces incorrect mtime/size, causing false edit conflicts    | Med        | Phase 3 audit; `FileTime` already uses per-file `Semaphore`; `experimental.parallel_read` default off                           |
| LSP warm concurrent calls               | Multiple `lsp.touchFile` calls for same file send duplicate `didOpen`             | Low        | Fire-and-forget with `Effect.ignore`; optional guard: `if (files[path] !== undefined) return` in `lsp/client.ts:notify.open`    |
| Instruction overlay resolution race     | Shared `claims` Map race causes duplicate instruction overlays for same messageID | Med        | **Required guard:** eagerly create Set for messageID in `instruction.resolve` before async work; prevents orphaned Sets         |
| Permission state changes mid-step       | User approves/denies while parallel tools execute                                 | Low        | Gate pre-checks all permissions before stream starts; tools with `"ask"` force serial fallback                                  |
| Model returns unexpected parallel calls | Model sends parallel calls for non-parallel-safe tools                            | Low        | Gate is set per-request; if `parallelToolCalls: false`, provider cannot return parallel calls                                   |
| Batch tool interaction                  | Batch tool already does `Promise.all`; nesting parallel in parallel               | Low        | Batch tool has `parallelSafe: false` (it manages its own concurrency); no double-parallelism                                    |

## Test Plan

### Unit Tests

#### `parallelGate` function (`test/session/parallel-gate.test.ts`)

- **Happy path**: All tools are `parallelSafe: true`, all permissions evaluate to `"allow"`, agent mode is `"subagent"`, config enabled → returns `true`
- **Mixed tools**: One tool has `parallelSafe: false` → returns `false`
- **Permission ask**: All tools parallel-safe but one permission evaluates to `"ask"` → returns `false`
- **Permission deny**: Tool permission evaluates to `"deny"` → returns `false`
- **Config disabled**: `experimental.parallel_tool_calls` is `false` → returns `false`
- **Primary agent default**: Agent mode is `"primary"`, no explicit config → returns `false`
- **Primary agent override**: Agent mode is `"primary"`, config explicitly `true` → returns `true`
- **Empty tools**: No active tools → returns `false` (no benefit to parallel with no tools)
- **Read behind flag**: Read tool with `parallelSafe: true` but `experimental.parallel_read` is `false` → read treated as `parallelSafe: false`

#### Tool metadata (`test/tool/parallel-safe.test.ts`)

- Verify `grep.parallelSafe === true`
- Verify `glob.parallelSafe === true`
- Verify `read.parallelSafe === true` (gated by config at runtime)
- Verify `bash.parallelSafe` is `undefined` or `false`
- Verify `edit.parallelSafe` is `undefined` or `false`
- Verify `write.parallelSafe` is `undefined` or `false`
- Verify `task.parallelSafe` is `undefined` or `false`
- Verify `batch.parallelSafe` is `undefined` or `false`

#### Config schema (`test/config/parallel-config.test.ts`)

- `experimental.parallel_tool_calls` accepts `true`, `false`, `undefined`
- `experimental.parallel_read` accepts `true`, `false`, `undefined`
- Invalid values rejected by Zod schema

### Integration Tests

#### Parallel execution (`test/session/parallel-execution.test.ts`)

- **3 concurrent grep/glob calls**: Mock LLM returns 3 tool calls in one step; verify all 3 execute and return results with correct `toolCallId` mapping
- **Mixed parallel + serial fallback**: Mock LLM with grep + bash tools active; verify `parallelToolCalls` is `false` in the `streamText` call
- **Subagent via task**: Spawn a subagent with explore agent (grep/glob allowed); verify parallel execution propagates through `task.ts` → `SessionPrompt.prompt` → `LLM.stream`
- **Permission transition**: Start with `"ask"` permission (serial), then approve "always" → next step should evaluate to parallel

#### Read concurrency (`test/session/parallel-read.test.ts`)

- **3 concurrent reads**: With `experimental.parallel_read: true`; verify all 3 return correct file contents; verify `FileTime` state is consistent (no corruption)
- **Mixed read + grep**: Both parallel-safe; verify concurrent execution
- **FileTime integrity**: Concurrent reads of same file; verify `FileTime.read()` records correct mtime for each

### End-to-End Tests

#### Critical user journeys

- **Explore subagent**: User sends prompt that triggers explore agent with multiple grep/glob calls → all execute in parallel → results returned correctly → no regression in output quality
- **Primary agent serial**: User in primary agent mode → tools execute serially as before → no behavior change
- **Config opt-out**: User sets `experimental.parallel_tool_calls: false` → all execution is serial regardless of tool/agent

#### Success criteria

- No regression in existing test suites (`bun --cwd packages/opencode test`)
- Parallel execution measurably faster than serial for 3+ concurrent grep/glob calls
- Serial fallback works correctly when any non-parallel-safe tool is in the active set

### Non-Functional Tests

#### Performance

- Parallel 3x grep should complete in ~1x single grep time (wall clock), not 3x
- Gate evaluation overhead < 1ms (negligible vs LLM latency)

#### Security

- Permission pre-check must never allow a tool to execute without proper authorization
- `ctx.ask` must never be called concurrently (gate prevents this by design)

## Implementation Notes

### Phase 1: Permission-Aware Parallel Gate

**Files changed**:

- `packages/opencode/src/tool/tool.ts`: Add optional `parallelSafe?: boolean` to `Tool.Info` interface
- `packages/opencode/src/session/llm.ts`: Add `parallelGate()` function; add `toolMeta` to `StreamInput`; pass provider-specific parallel-call options into `providerOptions`
- `packages/opencode/src/config/config.ts`: Add `parallel_tool_calls` and `parallel_read` to `experimental` schema
- `test/session/parallel-gate.test.ts`: Unit tests for gate logic

**`parallelGate` implementation sketch**:

```typescript
function parallelGate(input: {
  toolMeta: Map<string, { parallelSafe: boolean }>
  agent: Agent.Info
  permission: Permission.Ruleset
  cfg: Config
}): boolean {
  const enabled =
    input.agent.parallelToolCalls ?? input.cfg.experimental?.parallel_tool_calls ?? input.agent.mode === "subagent"
  if (enabled !== true) return false

  // All active tools must be parallel-safe
  for (const [toolName, meta] of input.toolMeta) {
    if (toolName === "invalid") continue
    if (!meta.parallelSafe) return false
    // Check permission resolves to "allow" (no "ask" needed)
    const rule = Permission.evaluate(toolName, "*", input.permission)
    if (rule.action !== "allow") return false
  }

  return input.toolMeta.size > 0
}
```

### Phase 2: Grep + Glob Parallel Execution

**Files changed**:

- `packages/opencode/src/tool/grep.ts`: Set `parallelSafe: true` on `GrepTool`
- `packages/opencode/src/tool/glob.ts`: Set `parallelSafe: true` on `GlobTool`
- `packages/opencode/src/session/prompt.ts`: Pass `toolMeta` from resolved tools into `StreamInput`
- `test/session/parallel-execution.test.ts`: Integration tests

**How `parallelSafe` is set**: The `Tool.Info` type gains an optional `parallelSafe` field. For `Tool.define`:

```typescript
export const GrepTool = Tool.define("grep", {
  parallelSafe: true,
  // ...existing definition
})
```

**How `toolMeta` flows**: In `SessionPrompt.resolveTools`, after building the AI SDK tool map, also build a `Map<string, { parallelSafe: boolean }>` from the registry's `Tool.Info` entries. Pass this map in `StreamInput.toolMeta`.

### Phase 3: Read Parallel (Guarded)

**Files changed**:

- `packages/opencode/src/tool/read.ts`: Set `parallelSafe: true`
- `packages/opencode/src/session/instruction.ts`: Fix claims Map race — eagerly create `Set` for messageID before async work in `resolve()`
- `packages/opencode/src/lsp/client.ts`: Optional guard to prevent duplicate `didOpen` for same file
- `packages/opencode/src/session/llm.ts`: In `parallelGate`, check `cfg.experimental.parallel_read` for read tool specifically
- `test/session/parallel-read.test.ts`: Concurrency tests
- `test/session/instruction.test.ts`: Test for duplicate instruction overlay prevention under concurrent resolve

**Concurrency audit of read tool side effects**:

1. **LSP warm** (`lsp.touchFile`): Fire-and-forget via `Effect.forkIn(scope)` with `Effect.ignore`. For **different files**, safe — `files` object keys don't collide. For the **same file** read in parallel, both calls may send duplicate `textDocument/didOpen` to the LSP server (cosmetic protocol violation — most servers handle gracefully). **Optional guard:** add `if (files[path] !== undefined) return` at top of `notify.open` in `lsp/client.ts` to prevent duplicate opens.

2. **FileTime.read**: Writes to `Map<SessionID, Map<string, Stamp>>` keyed by `(sessionID, filepath)`. Concurrent reads of **different files** write to different keys — safe. Concurrent reads of the **same file** overwrite the same key with the latest stamp — last-write-wins is acceptable since both stamps are from the same moment. `FileTime` already has per-file `Semaphore` locks (used by `withLock` for edit operations), but `read` does not use `withLock` — this is fine because `read` only sets the stamp, it doesn't need atomicity with a subsequent assert. ✅ No guard needed.

3. **Instruction.resolve**: Has a shared `claims: Map<MessageID, Set<string>>` in InstanceState that deduplicates instruction overlays across resolve calls. When two parallel reads share a `messageID` (which happens when the AI SDK dispatches multiple read tool calls in one assistant turn), both may see `claims.get(messageID) === undefined`, both create a new `Set`, and the second write orphans the first — causing **duplicate instruction overlays**. **Required guard:** eagerly create the Set for the messageID before any async work in `resolve()`, so concurrent callers share the same Set instance. This eliminates the race because subsequent `set.has(found)` / `set.add(found)` checks operate on a single shared Set and run synchronously between `yield*` points.

**Conclusion**: Read tool is safe for parallel execution **with one required guard** (Instruction.resolve claims deduplication) and one optional guard (LSP duplicate-open prevention). The `experimental.parallel_read` flag provides an opt-in gate for cautious rollout.

### Phase 4: Configuration and Opt-Out

**Files changed**:

- `packages/opencode/src/config/config.ts`: Schema additions (already done in Phase 1)
- `packages/opencode/src/session/llm.ts`: Per-provider check (some providers may not support `parallelToolCalls`)
- `packages/opencode/src/agent/agent.ts`: Optional per-agent `parallelToolCalls` override in agent config

**Per-provider handling**: Parallel tool-call intent is routed through `ProviderTransform.parallelToolCallOptions()` and then wrapped by `ProviderTransform.providerOptions()`. This keeps support limited to providers already wired for provider-specific options (currently OpenAI/Copilot-compatible paths) without introducing a new top-level `streamText` parameter. `config.provider.<id>.parallelToolCalls: false` must explicitly disable the provider option even when the gate allows parallel calls.
