# HLD: Goal Judge Independence

## Summary

An independent judge model that validates goal completion before accepting it. When the agent calls `goal_complete`, the judge reads the transcript cold and issues a structured verdict (`ok`, `impossible`, `reason`). Rejections re-enter the agent with feedback; impossible verdicts pause the goal. All gated behind `goal_judge` experimental flag.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        Session Loop                              │
│                                                                  │
│  Agent ──► goal_complete tool ──┐                               │
│                                 │                                │
│                    ┌────────────▼────────────────┐              │
│                    │     JudgeGate (flag check)   │              │
│                    └────────────┬────────────────┘              │
│                                 │                                │
│              flag off?          │         flag on?               │
│           ┌─────────────────────┼───────────────────┐           │
│           │                     │                   │           │
│           ▼                     ▼                   │           │
│   Goal.complete()        GoalJudge.evaluate()       │           │
│                                 │                   │           │
│                    ┌────────────┴────────────┐      │           │
│                    │                         │      │           │
│              ok: true              ok: false / impossible        │
│                    │                         │                   │
│                    ▼                         ▼                   │
│           Goal.complete()         reject → agent continues      │
│                                   OR Goal.pause() if impossible  │
│                                                                  │
│  Bus Events: goal.judge.verdict, goal.judge.error               │
└─────────────────────────────────────────────────────────────────┘

External:
┌──────────────┐       ┌──────────────────┐
│ Provider.Svc │◄──────│  GoalJudge.eval  │──► generateObject(Verdict)
└──────────────┘       └──────────────────┘
                              │
                              ▼
                       ┌─────────────┐
                       │ Verdict.ts  │ { ok, impossible?, reason }
                       └─────────────┘
```

## Components

### Component 1: Verdict Schema

- **File**: `src/goal/verdict.ts`
- **Type**: Pure Module (Zod schema + type)
- **Exports**: `Verdict` (zod schema), `Verdict.Type` (TS type)
- **Dependencies**: `zod`
- **Interface**:

  ```typescript
  import z from "zod"

  export const Verdict = z.object({
    ok: z.boolean().describe("Whether the goal has been achieved"),
    impossible: z.boolean().optional().describe("Whether the goal is impossible to achieve"),
    reason: z.string().describe("Evidence or explanation for the verdict"),
  })

  export type Verdict = z.infer<typeof Verdict>
  ```

### Component 2: GoalJudge Service

- **File**: `src/goal/judge.ts`
- **Type**: Effect Service (ServiceMap pattern, like SessionCompaction)
- **Exports**: `GoalJudge` namespace with `Interface`, `Service`, `layer`, `defaultLayer`, `evaluate()`
- **Dependencies**: `Provider.Service`, `Config.Service`, `Bus.Service`, `MessageV2`, `ai` (generateObject)
- **Interface**:

  ```typescript
  export namespace GoalJudge {
    export interface Input {
      sessionID: SessionID
      condition: string
      messages: MessageV2.WithParts[]
      model: { providerID: ProviderID; modelID: ModelID }
    }

    export interface Interface {
      readonly evaluate: (input: Input) => Effect.Effect<Verdict>
    }

    export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/GoalJudge") {}

    // Bus events
    export const Event = {
      Verdict: BusEvent.define(
        "goal.judge.verdict",
        z.object({
          sessionID: SessionID.zod,
          verdict: Verdict,
          attempt: z.number(),
          messageID: z.string().optional(),
        }),
      ),
      Error: BusEvent.define(
        "goal.judge.error",
        z.object({
          sessionID: SessionID.zod,
          error: z.string(),
        }),
      ),
    }
  }
  ```

### Component 3: JudgeGate

- **File**: `src/goal/judge-gate.ts`
- **Type**: Pure Module (wraps Goal.complete with judge check)
- **Exports**: `JudgeGate.attempt()`
- **Dependencies**: `Goal`, `GoalJudge`, `Config`, `Flag`
- **Interface**:

  ```typescript
  export namespace JudgeGate {
    export type Result =
      | { status: "completed"; goal: Goal.Info }
      | { status: "rejected"; reason: string; attempt: number }
      | { status: "impossible"; reason: string }
      | { status: "capped"; goal: Goal.Info }

    export function attempt(input: {
      sessionID: SessionID
      evidence: string
      messages: MessageV2.WithParts[]
      model: { providerID: ProviderID; modelID: ModelID }
    }): Promise<Result>
  }
  ```

### Component 4: Goal Table Migration

- **File**: `src/goal/goal.sql.ts` (column addition)
- **Migration**: `migration/<timestamp>_goal_react_count/migration.sql`
- **Type**: Schema (Drizzle column addition)
- **Exports**: existing `GoalTable` with new `react_count` column
- **Dependencies**: `drizzle-orm/sqlite-core`
- **Interface**:
  ```typescript
  // Addition to GoalTable:
  react_count: integer().notNull().default(0)
  ```

### Component 5: Config Additions

- **File**: `src/config/config.ts` (experimental section)
- **Type**: Schema addition (append-only)
- **Exports**: via existing `Config.Info` type (inferred)
- **Dependencies**: `zod`
- **Interface**:
  ```typescript
  // Added to experimental z.object:
  goal_judge: z.boolean().optional().describe("Enable independent judge for goal completion validation"),
  goal_judge_model: z
    .object({
      providerID: z.string(),
      modelID: z.string(),
    })
    .optional()
    .describe("Model override for goal judge (defaults to session model)"),
  goal_judge_max_rejects: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max judge rejections before auto-complete (default: 5)"),
  ```

### Component 6: Flag Addition

- **File**: `src/flag/flag.ts`
- **Type**: Static flag constant
- **Exports**: `Flag.OPENCODE_EXPERIMENTAL_GOAL_JUDGE`
- **Dependencies**: none (process.env read)
- **Interface**:
  ```typescript
  export const OPENCODE_EXPERIMENTAL_GOAL_JUDGE = truthy("OPENCODE_EXPERIMENTAL_GOAL_JUDGE")
  ```

## Data Flow

### Main Flow: Agent calls goal_complete

| Step | Component              | Action                                                                           | Next                                      |
| ---- | ---------------------- | -------------------------------------------------------------------------------- | ----------------------------------------- |
| 1    | `goal-complete.ts`     | Agent calls tool with `evidence`                                                 | Check flag                                |
| 2    | `goal-complete.ts`     | Read `cfg.experimental?.goal_judge`                                              | If disabled → step 7, if enabled → step 3 |
| 3    | `JudgeGate.attempt()`  | Load goal, check `react_count` vs max                                            | If capped → step 8, else → step 4         |
| 4    | `GoalJudge.evaluate()` | Resolve judge model, build transcript, call `generateObject` with Verdict schema | Parse result → step 5                     |
| 5    | `GoalJudge`            | Publish `goal.judge.verdict` bus event                                           | Route by verdict → step 6a/6b/6c          |
| 6a   | `JudgeGate`            | Verdict `ok: true` → call `Goal.complete()`                                      | Return completed                          |
| 6b   | `JudgeGate`            | Verdict `ok: false` → increment `react_count`, return rejection                  | Agent re-enters loop                      |
| 6c   | `JudgeGate`            | Verdict `impossible: true` → call `Goal.pause()`                                 | Return impossible                         |
| 7    | `goal-complete.ts`     | Flag disabled: direct `Goal.complete()`                                          | Return success                            |
| 8    | `JudgeGate`            | react_count >= max → auto-complete with "max attempts" evidence                  | Return capped                             |

### Error Flow: Judge model failure

| Step | Component              | Action                                                                | Next                |
| ---- | ---------------------- | --------------------------------------------------------------------- | ------------------- |
| 1    | `GoalJudge.evaluate()` | generateObject throws                                                 | Catch error         |
| 2    | `GoalJudge`            | Publish `goal.judge.error` event, log warning                         | Fallback            |
| 3    | `GoalJudge`            | Return `{ ok: true, impossible: false, reason: "judge unavailable" }` | Proceed to complete |

## Database Schema

```typescript
// src/goal/goal.sql.ts — addition to existing GoalTable
export const GoalTable = sqliteTable(
  "goal",
  {
    // ... existing columns ...
    react_count: integer().notNull().default(0), // NEW: judge rejection counter
  },
  // ... existing indexes ...
)
```

Migration SQL:

```sql
ALTER TABLE goal ADD COLUMN react_count INTEGER NOT NULL DEFAULT 0;
```

## Configuration

```typescript
// Added to experimental section in config schema:
experimental: z.object({
  // ... existing fields ...
  goal_judge: z.boolean().optional().describe("Enable independent judge for goal completion validation"),
  goal_judge_model: z
    .object({
      providerID: z.string(),
      modelID: z.string(),
    })
    .optional()
    .describe("Model override for goal judge (defaults to session model)"),
  goal_judge_max_rejects: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max judge rejections before auto-complete (default: 5)"),
})
```

Example config:

```json
{
  "experimental": {
    "goal_judge": true,
    "goal_judge_model": { "providerID": "openai", "modelID": "gpt-4o-mini" },
    "goal_judge_max_rejects": 3
  }
}
```

## Feature Flag

| Property     | Value                                                                                 |
| ------------ | ------------------------------------------------------------------------------------- |
| Flag name    | `OPENCODE_EXPERIMENTAL_GOAL_JUDGE`                                                    |
| Config key   | `experimental.goal_judge`                                                             |
| Default      | `false` (disabled)                                                                    |
| Gating       | Tool execution in `goal-complete.ts` checks config; if falsy, bypasses judge entirely |
| Env override | `OPENCODE_EXPERIMENTAL_GOAL_JUDGE=true` enables without config file                   |

Resolution order:

1. Config `experimental.goal_judge` (if set)
2. Env `OPENCODE_EXPERIMENTAL_GOAL_JUDGE` (fallback)
3. Default: disabled

## Integration Points

| Where          | File                           | How                                                                                                     |
| -------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Tool execution | `src/tool/goal-complete.ts`    | Add conditional branch: if flag enabled, call `JudgeGate.attempt()` instead of direct `Goal.complete()` |
| Goal namespace | `src/goal/goal.ts`             | Add `Goal.reject()` helper to increment `react_count`                                                   |
| Goal SQL       | `src/goal/goal.sql.ts`         | Add `react_count` column                                                                                |
| Config schema  | `src/config/config.ts`         | Append 3 fields to experimental object                                                                  |
| Flags          | `src/flag/flag.ts`             | Add env flag constant                                                                                   |
| Bus            | Existing `Bus.publish` pattern | New events registered via `BusEvent.define`                                                             |

**No existing function signatures modified.** The only behavioral change is a conditional branch in `goal-complete.ts` execute function, guarded by flag check.

## Error Handling

| Scenario                              | Handling                                                 | Fallback                                |
| ------------------------------------- | -------------------------------------------------------- | --------------------------------------- |
| Judge model call fails (network/auth) | Catch, log warning, publish `goal.judge.error`           | Treat as `ok: true` — never block agent |
| Verdict schema parse fails            | Catch ZodError                                           | Treat as `ok: true`                     |
| No active goal when judge called      | Return early with error message (existing behavior)      | N/A                                     |
| react_count exceeds max               | Auto-complete with evidence "max judge attempts reached" | Goal marked complete                    |
| Judge model not configured            | Use session's current model                              | Always has fallback                     |

## Constraints

- **Upstream-rebase safe**: All new files (`verdict.ts`, `judge.ts`, `judge-gate.ts`). Only `goal-complete.ts` gets additive conditional. Config/flag additions are append-only. Migration is additive (new column with default).
- **Provider cache**: No impact. Judge uses separate `generateObject` call (not `streamText`); does not touch the session's streaming or caching middleware.
- **Performance**: Judge adds one model call per `goal_complete` invocation. Mitigated by: (a) `goal_complete` is called rarely (once per goal), (b) configurable to use cheaper model, (c) no streaming needed (structured output only), (d) on error, fallback is instant.
- **Token budget**: Judge sees full transcript via `MessageV2.toModelMessagesEffect` — same token handling as compaction model. For very long sessions, provider's context limit naturally caps input.

## Test Plan

### Unit Tests

**`test/goal/verdict.test.ts`**:

- Valid verdict parses: `{ ok: true, reason: "done" }`
- Invalid verdict rejects: missing `ok`, missing `reason`
- Optional `impossible` defaults to undefined
- Edge: empty reason string still parses

**`test/goal/judge.test.ts`**:

- `evaluate()` returns parsed Verdict from generateObject mock
- System prompt contains goal condition
- Messages correctly converted via toModelMessagesEffect
- Model resolution: uses config override when set, falls back to session model
- Error handling: model failure returns `{ ok: true, reason: "judge unavailable" }`
- Bus event published after evaluation

**`test/goal/judge-gate.test.ts`**:

- Flag disabled → direct complete, no judge call
- Verdict ok → Goal.complete called
- Verdict rejected → react_count incremented, rejection returned
- Verdict impossible → Goal.pause called
- react_count at max → auto-complete regardless of verdict
- No active goal → error result

### Integration Tests

**`test/goal/judge-integration.test.ts`**:

- Full flow: tool call → judge evaluate → complete/reject
- Re-entry: rejection result contains reason text for agent
- Counter persistence: react_count survives across calls
- Bus events: verify verdict events published with correct payload

### End-to-End Tests

- Agent loop with goal_judge enabled: agent calls goal_complete, gets rejected, continues working, calls again, gets accepted
- Impossible detection: judge marks impossible, goal pauses, agent receives pause notification

### Non-Functional Tests

- **Latency**: Judge call should complete within provider timeout (no separate timeout needed)
- **Resilience**: Judge failure must never block the agent loop (verify fallback)
- **Isolation**: Judge evaluation must not mutate session messages or affect provider caching state
