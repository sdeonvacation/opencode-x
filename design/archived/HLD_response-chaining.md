# HLD: OpenAI Response Chaining (`previousResponseId`)

## Tech Stack

| Category  | Technology               | Purpose                                         |
| --------- | ------------------------ | ----------------------------------------------- |
| Language  | TypeScript 5.8           | Existing codebase language                      |
| Framework | Effect-ts 4.0            | Service composition, stream processing          |
| AI SDK    | `@ai-sdk/openai` 3.0.71+ | Responses API with `previousResponseId` support |
| Database  | SQLite (Drizzle)         | Persist response_id in step-finish parts        |
| Runtime   | Bun 1.3.11               | Execution environment                           |

## Components

| Component       | Responsibility                                                                           | Dependencies                      |
| --------------- | ---------------------------------------------------------------------------------------- | --------------------------------- |
| `transform.ts`  | Build provider options; set `store: true` for native OpenAI; inject `previousResponseId` | Provider model metadata           |
| `processor.ts`  | Extract `responseId` from stream metadata; persist in step-finish part                   | MessageV2, Session                |
| `llm.ts`        | Accept `lastResponseId` in StreamInput; pass to option builder                           | transform.ts, StreamInput callers |
| `message-v2.ts` | Schema definition for `response_id` field on StepFinishPart                              | Zod                               |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Session Turn N                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────┐    ┌─────────┐    ┌─────────────┐    ┌────────┐ │
│  │ Caller   │───▶│ llm.ts  │───▶│ transform.ts│───▶│ OpenAI │ │
│  │(process) │    │ stream()│    │ options()   │    │  API   │ │
│  └──────────┘    └─────────┘    └─────────────┘    └───┬────┘ │
│       │                                                 │      │
│       │          ┌─────────────┐                        │      │
│       │          │processor.ts │◀───── stream events ───┘      │
│       │          │handleEvent()│                                │
│       │          └──────┬──────┘                                │
│       │                 │ finish-step                            │
│       │                 ▼                                       │
│       │          ┌─────────────┐                                │
│       │          │   SQLite    │                                │
│       │          │ (parts tbl) │                                │
│       │          └──────┬──────┘                                │
│       │                 │                                       │
│       │                 │ response_id persisted                  │
│       ▼                 ▼                                       │
├─────────────────────────────────────────────────────────────────┤
│                        Session Turn N+1                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────┐  read last step-finish                           │
│  │ Caller   │──────────────────────┐                           │
│  │(process) │                      ▼                           │
│  │          │  ┌────────────────────────┐                      │
│  │          │  │ response_id = "resp_x" │                      │
│  │          │  │ compaction? → null     │                      │
│  │          │  └────────────┬───────────┘                      │
│  │          │               │                                  │
│  │          │──▶ llm.ts ───▶ transform.ts                      │
│  │          │    lastResponseId="resp_x"                       │
│  │          │                    │                              │
│  │          │                    ▼                              │
│  │          │    providerOptions: { previousResponseId: "resp_x" }
│  └──────────┘                                                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

Description: Response chaining creates a server-side conversation thread on OpenAI. Each response returns a `responseId`; subsequent requests include `previousResponseId` so OpenAI can skip re-processing historical context. The chain breaks on compaction (context window management), provider switch, or stale ID error.

## Interfaces

### `message-v2.ts` — StepFinishPart Extension

| Field         | Type                    | Description                               |
| ------------- | ----------------------- | ----------------------------------------- |
| `response_id` | `z.string().optional()` | OpenAI response ID from provider metadata |

### `llm.ts` — StreamInput Extension

| Field            | Type                | Description                        |
| ---------------- | ------------------- | ---------------------------------- |
| `lastResponseId` | `string` (optional) | Previous response ID to chain from |

### `transform.ts` — options()

| Method      | Input                                                    | Output                | Behavior                                                                             | Errors                 |
| ----------- | -------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------ | ---------------------- |
| `options()` | `{ model, sessionID, providerOptions, lastResponseId? }` | `Record<string, any>` | Sets `store: true` for native openai; injects `previousResponseId` when guard passes | None (options builder) |

### `processor.ts` — finish-step Handler

| Method                       | Input                    | Output                  | Behavior                                                               | Errors                           |
| ---------------------------- | ------------------------ | ----------------------- | ---------------------------------------------------------------------- | -------------------------------- |
| `handleEvent("finish-step")` | `value.providerMetadata` | Part with `response_id` | Extracts `openai.responseId` from metadata; includes in `updatePart()` | Missing metadata → field omitted |

## Data Flow

| Step | Component                | Action                                                          | Next |
| ---- | ------------------------ | --------------------------------------------------------------- | ---- |
| 1    | Caller (processor)       | Read last assistant step-finish part for `response_id`          | 2    |
| 2    | Caller (processor)       | Check if compaction occurred after that part                    | 3    |
| 3    | Caller (processor)       | If valid, pass `lastResponseId` in StreamInput                  | 4    |
| 4    | `llm.ts` stream()        | Receive `lastResponseId`, pass to `ProviderTransform.options()` | 5    |
| 5    | `transform.ts` options() | Guard: native openai + ID present → set `previousResponseId`    | 6    |
| 6    | `streamText()`           | Send request with `previousResponseId` in providerOptions       | 7    |
| 7    | OpenAI API               | Return response with `responseId` in metadata                   | 8    |
| 8    | `processor.ts`           | Extract `value.providerMetadata.openai.responseId`              | 9    |
| 9    | `processor.ts`           | Persist `response_id` in step-finish part via `updatePart()`    | 10   |
| 10   | SQLite                   | Store part with `response_id` field                             | Done |

**Error Flows**:

- **Stale response ID**: OpenAI rejects with error → `streamText` `onError` fires → retry policy catches → clear `lastResponseId` → retry without chaining
- **Missing metadata**: `providerMetadata?.openai?.responseId` is undefined → `response_id` field omitted from part (no-op)
- **Provider switch mid-session**: Guard in `options()` rejects non-openai provider → `previousResponseId` not injected
- **Compaction**: CompactionPart timestamp > last step-finish timestamp → caller passes no `lastResponseId`

## Data Model

| Entity         | Fields                                                                                                                | Relationships                | Constraints                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------- |
| StepFinishPart | `type: "step-finish"`, `reason: string`, `snapshot?: string`, `cost: number`, `tokens: {...}`, `response_id?: string` | Belongs to assistant message | Optional field; only populated for native OpenAI responses |

No new tables or migrations required. The `response_id` field is stored as part of the JSON part data in the existing parts table.

## Decisions

| Decision            | Choice                                                            | Reason                                                                                | Alternatives                        | Tradeoffs                                     |
| ------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------- |
| Storage location    | `response_id` on StepFinishPart                                   | Already persisted per-step; last step-finish of assistant msg is natural lookup point | Separate table; message-level field | Minimal schema change; no migration needed    |
| Guard scope         | Only `providerID === "openai"` AND `api.npm === "@ai-sdk/openai"` | Copilot and openai-compatible don't support Responses API chaining                    | Broader condition                   | False positive for copilot/compatible averted |
| Chain invalidation  | Check CompactionPart existence after last response_id             | Compaction rewrites context; server-side chain is stale                               | Timestamp comparison; explicit flag | Simple; leverages existing part ordering      |
| `store: true` scope | Native openai only; copilot keeps `store: false`                  | Copilot uses different billing/storage; store must stay off                           | All openai-family                   | Respects copilot constraints                  |
| No feature flag     | Always-on for native OpenAI                                       | Low risk; graceful fallback on error; reduces latency/cost immediately                | Config toggle                       | Simpler; can't be accidentally disabled       |
| Retry on stale ID   | Clear ID and retry without chaining                               | OpenAI may purge stored responses (unknown TTL)                                       | Fail hard; exponential backoff      | Transparent degradation; one extra request    |

## Risks

| Risk                                                | Impact                                               | Likelihood          | Mitigation                                           |
| --------------------------------------------------- | ---------------------------------------------------- | ------------------- | ---------------------------------------------------- |
| Stale response purged by OpenAI                     | Single request fails, then succeeds without chaining | Low                 | Retry without `previousResponseId` on relevant error |
| `store: true` cost visibility                       | User sees stored responses in OpenAI dashboard       | Low (informational) | Document behavior; not a bug                         |
| Multi-step tool loops produce multiple response IDs | Could chain from wrong step                          | Med                 | Always use LAST step-finish part's response_id       |
| Provider metadata shape changes                     | `openai.responseId` path invalid                     | Low                 | Optional chaining; field simply omitted              |
| Concurrent sessions on same OpenAI account          | No conflict — response IDs are per-request           | None                | N/A                                                  |

## Test Plan

### Unit Tests

#### `transform.test.ts`

- **`store: true` for native openai**: Model with `providerID: "openai"` + `api.npm: "@ai-sdk/openai"` → `result.store === true`
- **`store: false` for copilot**: Model with `api.npm: "@ai-sdk/github-copilot"` → `result.store === false`
- **`previousResponseId` injected**: When `lastResponseId` present AND native openai guard passes → `result.previousResponseId === "resp_xxx"`
- **`previousResponseId` NOT injected**: When provider is copilot/openai-compatible → field absent
- **`previousResponseId` NOT injected**: When `lastResponseId` is undefined/null → field absent

#### `processor.ts` (step-finish handler)

- **Response ID extracted**: Mock `value.providerMetadata` with `{ openai: { responseId: "resp_abc" } }` → part includes `response_id: "resp_abc"`
- **Missing metadata**: `providerMetadata` is undefined → part has no `response_id` field
- **Non-openai provider**: `providerMetadata` has no `openai` key → `response_id` omitted

#### `message-v2.ts` (schema)

- **Parse with response_id**: StepFinishPart.parse succeeds with `response_id: "resp_xxx"`
- **Parse without response_id**: StepFinishPart.parse succeeds without field (backward compat)

### Integration Tests

#### `llm.test.ts`

- **Full cycle**: Response → store `response_id` → next request includes `previousResponseId`
- **Compaction breaks chain**: After compaction part written, next request has no `previousResponseId`
- **Provider switch**: Switch from openai to anthropic mid-session → no `previousResponseId` on anthropic request

### End-to-End Tests

- **Multi-turn conversation**: Send 3 turns with native OpenAI; verify each request after first includes `previousResponseId` from prior response
- **Compaction recovery**: Trigger compaction mid-conversation; verify next turn has no stale `previousResponseId`; subsequent turns resume chaining with new IDs

### Non-Functional Tests

- **Latency improvement**: Verify response time decreases on chained requests (OpenAI skips re-processing history)
- **Token savings**: Verify input token count decreases when chaining is active (server-side context)

## Implementation: Exact Changes Per File

### 1. `src/session/message-v2.ts`

Add `response_id` to StepFinishPart schema:

```typescript
export const StepFinishPart = PartBase.extend({
  type: z.literal("step-finish"),
  reason: z.string(),
  snapshot: z.string().optional(),
  cost: z.number(),
  response_id: z.string().optional(),
  tokens: z.object({
    total: z.number().optional(),
    input: z.number(),
    output: z.number(),
    reasoning: z.number(),
    cache: z.object({
      read: z.number(),
      write: z.number(),
    }),
  }),
}).meta({
  ref: "StepFinishPart",
})
```

### 2. `src/provider/transform.ts`

Split the openai/copilot condition in `options()`:

```typescript
// Native openai: store: true (enables response chaining)
if (input.model.providerID === "openai" && input.model.api.npm === "@ai-sdk/openai") {
  result["store"] = true
  result["truncation"] = "auto"
  if (input.lastResponseId) {
    result["previousResponseId"] = input.lastResponseId
  }
}

// Copilot: store: false (no chaining)
if (input.model.api.npm === "@ai-sdk/github-copilot") {
  result["store"] = false
  result["truncation"] = "auto"
}
```

Update function signature:

```typescript
export function options(input: {
  model: Provider.Model
  sessionID: string
  providerOptions?: Record<string, any>
  lastResponseId?: string
}): Record<string, any> {
```

### 3. `src/session/llm.ts`

Add `lastResponseId` to `StreamInput`:

```typescript
export type StreamInput = {
  user: MessageV2.User
  sessionID: string
  parentSessionID?: string
  model: Provider.Model
  agent: Agent.Info
  permission?: Permission.Ruleset
  system: string[]
  messages: ModelMessage[]
  small?: boolean
  tools: Record<string, Tool>
  toolMeta?: Map<string, ToolMeta>
  retries?: number
  toolChoice?: "auto" | "required" | "none"
  maxSteps?: number
  onModelResolved?: (model: Provider.Model) => void
  lastResponseId?: string
}
```

Pass to `ProviderTransform.options()`:

```typescript
const base = input.small
  ? ProviderTransform.smallOptions(model)
  : ProviderTransform.options({
      model,
      sessionID: input.sessionID,
      providerOptions: provider.options,
      lastResponseId: input.lastResponseId,
    })
```

### 4. `src/session/processor.ts`

Extract response ID in finish-step handler (line 642):

```typescript
case "finish-step": {
  const usage = Session.getUsage({
    model: ctx.model,
    usage: value.usage,
    metadata: value.providerMetadata,
  })
  ctx.assistantMessage.finish = value.finishReason
  ctx.assistantMessage.cost += usage.cost
  ctx.assistantMessage.tokens = usage.tokens
  const rid = value.providerMetadata?.openai?.responseId as string | undefined
  yield* session.updatePart({
    id: PartID.ascending(),
    reason: value.finishReason,
    snapshot: yield* SnapshotGate.track(ctx, snapshot, cfg.experimental?.skip_snapshot_no_fs !== false),
    messageID: ctx.assistantMessage.id,
    sessionID: ctx.assistantMessage.sessionID,
    type: "step-finish",
    tokens: usage.tokens,
    cost: usage.cost,
    ...(rid ? { response_id: rid } : {}),
  })
  // ...rest unchanged
}
```

### 5. Caller site (processor `process()` or caller of `process()`)

Before calling `process(streamInput)`, read last response ID:

```typescript
// Read last assistant step-finish with response_id
// Skip if compaction occurred after it
const rid = (() => {
  // Find last step-finish part with response_id from assistant messages
  // Check no compaction part exists after it
  // Return response_id or undefined
})()

// Pass to streamInput
process({
  ...streamInput,
  lastResponseId: rid,
})
```

The exact lookup logic: iterate message parts in reverse, find last `step-finish` with `response_id`. Then check if any `compaction` part has a later ID (parts are ordered by ascending ID). If compaction is later, return undefined.
