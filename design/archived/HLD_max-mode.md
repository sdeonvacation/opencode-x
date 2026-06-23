# HLD: Max Mode (Best-of-N Reasoning)

## Summary

Max Mode generates N parallel propose-only LLM candidates for each primary agent step, uses a judge LLM call to select the best candidate, then replays the winner through the normal processor pipeline for tool execution. This yields higher-quality reasoning at ~Nx cost by selecting the best draw from multiple independent completions, gated behind an experimental flag.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         prompt.ts run-loop                           │
│                                                                     │
│  ┌──────────┐    ┌─────────────────────────────────────────────┐    │
│  │ lastUser │───▶│  max_mode enabled? && primary agent?        │    │
│  └──────────┘    │  && format != json_schema?                  │    │
│                  └───────────┬──────────────────────┬──────────┘    │
│                     YES      │                      │ NO            │
│                              ▼                      ▼               │
│               ┌──────────────────────┐    ┌────────────────┐       │
│               │ MaxMode.runMaxStep() │    │ handle.process │       │
│               └──────────┬───────────┘    └────────────────┘       │
│                          │                                          │
└──────────────────────────┼──────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│                     max-mode.ts orchestrator                          │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────┐         │
│  │ 1. toSchemaOnlyTools(tools) — strip execute callbacks   │         │
│  └─────────────────────────────────────────────────────────┘         │
│                          │                                           │
│                          ▼                                           │
│  ┌─────────────────────────────────────────────────────────┐         │
│  │ 2. Effect.all([runCandidate(0)..runCandidate(N-1)],     │         │
│  │                { concurrency: N })                       │         │
│  └─────────────────────────────────────────────────────────┘         │
│        │         │         │       ...       │                       │
│        ▼         ▼         ▼                 ▼                       │
│  ┌──────┐  ┌──────┐  ┌──────┐         ┌──────┐                     │
│  │ C[0] │  │ C[1] │  │ C[2] │   ...   │C[N-1]│  (propose-only)     │
│  └──────┘  └──────┘  └──────┘         └──────┘                     │
│        │         │         │       ...       │                       │
│        └─────────┴─────────┴────────┬────────┘                      │
│                                     ▼                                │
│  ┌─────────────────────────────────────────────────────────┐         │
│  │ 3. Filter nulls (failed candidates)                     │         │
│  │    If 0 survivors → fallback to handle.process          │         │
│  └─────────────────────────────────────────────────────────┘         │
│                                     │                                │
│                                     ▼                                │
│  ┌─────────────────────────────────────────────────────────┐         │
│  │ 4. judge(input, survivors) — pick best candidate        │         │
│  │    (toolChoice: "none", single LLM call)                │         │
│  └─────────────────────────────────────────────────────────┘         │
│                                     │                                │
│                                     ▼                                │
│  ┌─────────────────────────────────────────────────────────┐         │
│  │ 5. Compute overhead { cost, tokensIn, tokensOut }       │         │
│  │    Return winner data for replay                        │         │
│  └─────────────────────────────────────────────────────────┘         │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│                  processor.ts replay()                                │
│                                                                      │
│  Synthesize LLM events from winner → feed through handleEvent        │
│  pipeline → execute tool calls via real tools → return Result        │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

## Components

### Component 1: Config Schema Extension

- **File**: `src/config/config.ts`
- **Type**: Schema (additive field additions)
- **Exports**: None new (extends existing `experimental` object)
- **Dependencies**: `zod`
- **Interface**:
  ```typescript
  // Added to existing experimental z.object({...})
  max_mode: z.boolean().optional().describe("Enable best-of-N reasoning for primary agent steps")
  max_mode_candidates: z.number().int().min(2).max(10).optional().describe("Number of parallel candidates (default: 5)")
  ```

### Component 2: Feature Flag

- **File**: `src/flag/flag.ts`
- **Type**: Pure Module (constant export)
- **Exports**: `Flag.OPENCODE_EXPERIMENTAL_MAX_MODE`
- **Dependencies**: `enabledByExperimental` helper (internal)
- **Interface**:
  ```typescript
  // Added inside Flag namespace
  export const OPENCODE_EXPERIMENTAL_MAX_MODE = enabledByExperimental("OPENCODE_EXPERIMENTAL_MAX_MODE")
  ```

### Component 3: Max Mode Core

- **File**: `src/session/max-mode.ts`
- **Type**: Pure Module (namespace with functions)
- **Exports**: `MaxMode.runMaxStep`, `MaxMode.toSchemaOnlyTools`, `MaxMode.parseJudgeIndex`, `MaxMode.Candidate`, `MaxMode.ProposedToolCall`, `MaxMode.MaxStepInput`, `MaxMode.MaxStepResult`
- **Dependencies**: `LLM`, `SessionRetry`, `SessionStatus`, `Provider`, `Effect`, `ai` (streamText types)
- **Interface**:

  ```typescript
  export namespace MaxMode {
    export type ProposedToolCall = {
      toolCallId: string
      toolName: string
      input: unknown
      providerMetadata?: Record<string, unknown>
    }

    export type Candidate = {
      index: number
      reasoning: string
      reasoningMetadata?: Record<string, unknown>
      text: string
      textMetadata?: Record<string, unknown>
      toolCalls: ProposedToolCall[]
      finishReason: string
      usage?: { promptTokens: number; completionTokens: number }
      providerMetadata?: Record<string, unknown>
    }

    export type Overhead = {
      cost: number
      tokensIn: number
      tokensOut: number
    }

    export type MaxStepInput = {
      sessionID: string
      parentSessionID?: string
      model: Provider.Model
      agent: Agent.Info
      permission?: Permission.Ruleset
      system: string[]
      messages: ModelMessage[]
      tools: Record<string, Tool>
      candidates: number
      setStatus: (msg: string) => void
    }

    export type MaxStepResult = {
      winner: Candidate
      selection: { winner: number; total: number }
      thinkingMs: number
      overhead: Overhead
    }

    /** Strip execute from tools — forces propose-only behavior */
    export function toSchemaOnlyTools(tools: Record<string, Tool>): Record<string, Tool>

    /** Extract integer index from judge response text */
    export function parseJudgeIndex(output: string, count: number): number

    /** Orchestrate N candidates + judge, return winner */
    export function runMaxStep(input: MaxStepInput): Effect.Effect<MaxStepResult | null, never, LLM.Service>
  }
  ```

### Component 4: Processor Replay Extension

- **File**: `src/session/processor.ts`
- **Type**: Effect Service (extends existing `Handle` interface)
- **Exports**: Extends `SessionProcessor.Handle` with `replay` method
- **Dependencies**: Existing processor internals, `MessageV2`, `Session`
- **Interface**:

  ```typescript
  // Added to SessionProcessor.Handle interface
  export type ReplayInput = {
    reasoning: string
    reasoningMetadata?: Record<string, unknown>
    text: string
    textMetadata?: Record<string, unknown>
    toolCalls: MaxMode.ProposedToolCall[]
    finishReason: string
    usage?: { promptTokens: number; completionTokens: number }
    providerMetadata?: Record<string, unknown>
    tools: Record<string, Tool>
    messages: ModelMessage[]
    selection: { winner: number; total: number }
    thinkingMs: number
    overhead: MaxMode.Overhead
  }

  export interface Handle {
    // existing...
    readonly replay: (input: ReplayInput) => Effect.Effect<Result>
  }
  ```

### Component 5: Prompt Integration

- **File**: `src/session/prompt.ts`
- **Type**: Integration (conditional branch at call site)
- **Exports**: None new
- **Dependencies**: `MaxMode`, `Config`, `Flag`, `SessionProcessor.Handle`
- **Interface**: No new exports. Adds conditional before `handle.process(...)` at ~line 2075.

### Component 6: Overhead Metadata Extension

- **File**: `src/session/message-v2.ts`
- **Type**: Schema (additive field on `Assistant`)
- **Exports**: Extends `MessageV2.Assistant` type
- **Dependencies**: `zod`
- **Interface**:
  ```typescript
  // Added as optional field on Assistant schema
  max_mode: z.object({
    winner: z.number(),
    total: z.number(),
    thinkingMs: z.number(),
    overhead: z.object({
      cost: z.number(),
      tokensIn: z.number(),
      tokensOut: z.number(),
    }),
  }).optional()
  ```

## Data Flow

### Happy Path: Max Mode Active

| Step | Component      | Action                                                                               | Next          |
| ---- | -------------- | ------------------------------------------------------------------------------------ | ------------- |
| 1    | `prompt.ts`    | Check `cfg.experimental?.max_mode` + flag + agent is primary + format != json_schema | → MaxMode     |
| 2    | `max-mode.ts`  | `toSchemaOnlyTools(tools)` — clone tools with `execute` removed                      | → spawn       |
| 3    | `max-mode.ts`  | `Effect.all(candidates.map(i => runCandidate(input, i)), { concurrency: N })`        | → filter      |
| 4    | `max-mode.ts`  | Filter null candidates (failures). If 0 survivors → return null (fallback)           | → judge       |
| 5    | `max-mode.ts`  | `judge(input, survivors)` — single LLM call, `toolChoice: "none"`                    | → parse       |
| 6    | `max-mode.ts`  | `parseJudgeIndex(judgeReply, survivors.length)` → pick index                         | → aggregate   |
| 7    | `max-mode.ts`  | Compute overhead (sum all candidate + judge usage minus winner)                      | → return      |
| 8    | `prompt.ts`    | Receive `MaxStepResult`, call `handle.replay(replayInput)`                           | → replay      |
| 9    | `processor.ts` | `replay()` synthesizes LLM events from winner data                                   | → handleEvent |
| 10   | `processor.ts` | Existing `handleEvent` pipeline executes tool calls via real tools                   | → result      |
| 11   | `processor.ts` | Write `max_mode` metadata on assistant message                                       | → done        |

### Fallback Path: All Candidates Fail

| Step | Component     | Action                                                             | Next          |
| ---- | ------------- | ------------------------------------------------------------------ | ------------- |
| 1-3  | Same as above | Spawn N candidates                                                 | → filter      |
| 4    | `max-mode.ts` | 0 survivors → return `null`                                        | → prompt.ts   |
| 5    | `prompt.ts`   | `runMaxStep` returned null → fall through to `handle.process(...)` | → normal path |

### Error Flows

- **Single candidate failure**: `runCandidate` catches all errors → returns `null`. Other candidates continue.
- **Judge returns garbage**: `parseJudgeIndex` defaults to index 0 (first survivor). Safe degradation.
- **Rate limit on candidates**: `SessionRetry` policy handles backoff per-candidate independently via exponential delay.
- **Replay tool execution failure**: Same error/retry path as normal processor. No new failure modes.
- **Flag disabled**: Conditional in `prompt.ts` short-circuits; zero overhead on normal path.

## Database Schema

No new tables. Overhead tracked in existing `MessageTable` JSON metadata column via the `max_mode` optional field on `Assistant` info.

## Configuration

```typescript
// In src/config/config.ts experimental z.object:
max_mode: z
  .boolean()
  .optional()
  .describe("Enable best-of-N reasoning for primary agent steps"),
max_mode_candidates: z
  .number()
  .int()
  .min(2)
  .max(10)
  .optional()
  .describe("Number of parallel candidates (default: 5)"),
```

**Defaults**:

- `max_mode`: `undefined` (disabled)
- `max_mode_candidates`: `5` when max_mode enabled and no explicit value

**Config file example**:

```jsonc
{
  "experimental": {
    "max_mode": true,
    "max_mode_candidates": 5,
  },
}
```

## Feature Flag

- **Name**: `OPENCODE_EXPERIMENTAL_MAX_MODE`
- **Env var**: `OPENCODE_EXPERIMENTAL_MAX_MODE=true`
- **Pattern**: `enabledByExperimental` — inherits from `OPENCODE_EXPERIMENTAL=true` or standalone
- **Gating**: Config field `experimental.max_mode` takes precedence if set; env flag used as fallback when config is undefined

**Activation logic** (in `prompt.ts`):

```typescript
const maxMode = cfg.experimental?.max_mode ?? Flag.OPENCODE_EXPERIMENTAL_MAX_MODE
```

## Integration Points

| Location          | File                                        | How                                                                                                                                   |
| ----------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Run-loop decision | `src/session/prompt.ts` ~L2075              | Conditional before `handle.process(...)`: if maxMode enabled + primary agent + text format → `MaxMode.runMaxStep(...)`                |
| Processor replay  | `src/session/processor.ts` Handle interface | New `replay` method on `Handle` interface. Synthesizes events from winner, routes through existing `handleEvent`                      |
| Status updates    | `src/session/status.ts`                     | `setStatus` callback publishes `SessionStatus.Event.Status` with messages like "Generating candidate 3/5...", "Judging candidates..." |
| Usage aggregation | Where `Session.getUsage` sums cost          | Include `max_mode.overhead.cost` in total cost, exclude from context token counts                                                     |
| Message metadata  | `src/session/message-v2.ts`                 | Optional `max_mode` field on `Assistant` schema                                                                                       |

## Error Handling

| Scenario                          | Handler                             | Behavior                                                                        |
| --------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------- |
| Individual candidate stream fails | `runCandidate` catch-all            | Returns `null`, other candidates unaffected                                     |
| All N candidates fail             | `runMaxStep` returns `null`         | Caller falls through to `handle.process()`                                      |
| Judge call fails                  | `judge` catch → default pick 0      | First survivor selected, still proceeds                                         |
| Judge returns non-integer         | `parseJudgeIndex` regex + fallback  | Returns 0 (first survivor)                                                      |
| Replay tool execution fails       | Existing processor error handling   | Same as normal process path — retries, doom-loop detection                      |
| Rate limiting                     | `SessionRetry` policy per candidate | Independent backoff; some candidates may timeout → null                         |
| Provider 413/overflow             | Not applicable to candidates        | Candidates use same messages snapshot; if overflow hits, candidate returns null |

## Constraints

- **Upstream-rebase safe**: All changes additive. New file `max-mode.ts`, new optional fields on existing schemas/interfaces, conditional branch guarded by flag. No existing function signatures modified.
- **Provider cache**: No impact. Candidates are independent streams — they don't share provider cache state. Winner replay synthesizes events locally without an LLM call (tools execute against real FS, but LLM response is pre-determined).
- **Performance**: When disabled (default), zero overhead — single boolean check in prompt.ts. When enabled, ~Nx LLM cost + 1 judge call. Memory: N candidate buffers held concurrently (each ~few KB of text/toolCalls). Candidates are stateless — no FS mutations until replay.
- **Compaction safety**: Messages array captured before candidates spawn. Candidates are propose-only (no side effects). If compaction fires mid-ensemble, it operates on stale message set — safe because candidates don't write to session.
- **Concurrency**: N parallel streams may hit provider rate limits. Mitigated by per-candidate `SessionRetry` backoff. Worst case: fewer survivors, still functional.

## Test Plan

### Unit Tests (`test/session/max-mode.test.ts`)

| Scenario                                   | Input                           | Expected                                     |
| ------------------------------------------ | ------------------------------- | -------------------------------------------- |
| `parseJudgeIndex` — valid integer          | `"I pick candidate 2"`, count=5 | 2                                            |
| `parseJudgeIndex` — out of range           | `"candidate 99"`, count=3       | 0 (fallback)                                 |
| `parseJudgeIndex` — no number              | `"I can't decide"`, count=3     | 0 (fallback)                                 |
| `parseJudgeIndex` — negative               | `"-1"`, count=3                 | 0 (fallback)                                 |
| `toSchemaOnlyTools` — strips execute       | tools with execute functions    | Same tools without execute, schema preserved |
| `toSchemaOnlyTools` — preserves parameters | tools with complex zod schemas  | Parameters identical, only execute removed   |
| Overhead aggregation                       | 3 candidates + judge usage      | Sum all usage minus winner = overhead        |

### Integration Tests

| Scenario                     | Setup                                                           | Expected                                                  |
| ---------------------------- | --------------------------------------------------------------- | --------------------------------------------------------- |
| Full max-step with mock LLM  | Mock stream returning 3 known candidates, mock judge picking #1 | Winner #1 replayed, tools executed, overhead computed     |
| All candidates fail          | Mock stream throwing for all N                                  | `runMaxStep` returns null, caller uses `handle.process`   |
| Feature flag off             | `cfg.experimental.max_mode = false`                             | Normal `handle.process` path taken, no MaxMode invocation |
| Judge failure with survivors | Mock judge throwing error                                       | Falls back to candidate 0, replay proceeds                |
| Single survivor              | 4/5 candidates fail, 1 survives                                 | Survivor picked without judge call (optimization)         |

### Non-Functional

- **Cost tracking**: Verify `max_mode.overhead` sums correctly and appears in session usage totals
- **No side effects from candidates**: Verify propose-only tools never invoke execute
- **Concurrency**: Verify N candidates spawn in parallel (not sequential)
- **Status updates**: Verify SessionStatus events fire during candidate/judge phases

## Decisions

| Decision                          | Choice                                                   | Reason                                                                                                     | Alternatives                                          | Tradeoffs                                                   |
| --------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------- |
| Propose-only via stripped execute | Clone tools without execute function                     | Simplest way to prevent tool execution during candidate phase. AI SDK still proposes tool calls via schema | Separate `propose` mode in LLM, custom model wrapper  | Cloning tools is cheap; alternative requires AI SDK changes |
| Judge as separate LLM call        | Single streamText with `toolChoice: "none"`              | Clean separation, easy to debug, uses same model. Judge prompt is simple (pick an index)                   | Embed scoring in candidates, use embedding similarity | Separate judge is transparent and auditable                 |
| Replay via synthesized events     | Feed winner data through existing `handleEvent` pipeline | Reuses all existing tool execution, part creation, doom-loop detection. No code duplication                | Direct tool execution bypassing processor             | Replay through processor ensures identical behavior         |
| Overhead on message metadata      | Optional `max_mode` field in Assistant JSON              | No DB schema changes, purely additive, survives compaction                                                 | Separate overhead table, separate tracking service    | JSON field is simpler; no migration needed                  |
| Fallback on total failure         | Return null → fall through to `handle.process`           | Never blocks the user. Graceful degradation                                                                | Retry the whole ensemble, error out                   | Fallback ensures UX stability                               |
| N=5 default                       | Balance quality improvement vs cost                      | Research shows diminishing returns past 5-7 for code tasks                                                 | 3 (cheaper), 10 (more thorough)                       | 5x cost is acceptable for "max quality" mode                |

## Risks

| Risk                         | Impact                                | Likelihood       | Mitigation                                                                                 |
| ---------------------------- | ------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------ |
| Token cost explosion         | 5x+ per step with judge overhead      | High (by design) | Clearly documented as "max quality" mode; overhead tracked separately; user sees true cost |
| Rate limiting with N streams | Some candidates timeout/fail          | Medium           | Per-candidate retry; works with fewer survivors; single-survivor optimization              |
| Judge picks wrong candidate  | Suboptimal but valid response         | Low              | Conservative judge prompt; fallback to 0 on parse failure; user can reduce N               |
| Replay divergence            | Tool execution differs from proposal  | Low              | Replay uses exact tool call inputs from winner; same tools, same parameters                |
| Memory pressure              | N candidate buffers in memory         | Low              | Candidates are small (~KB each); buffer lifetime is short (ensemble phase only)            |
| Interaction with compaction  | Stale message array during candidates | Low              | Candidates are stateless (propose-only); messages captured before spawn; safe              |
