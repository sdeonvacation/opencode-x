# HLD: Orchestration Quick Wins

## Tech Stack

| Category  | Technology            | Purpose                                                |
| --------- | --------------------- | ------------------------------------------------------ |
| Language  | TypeScript 5.8.2      | Existing codebase language                             |
| Runtime   | Bun 1.3.11            | Existing runtime, provides `Bun.hash` for sigs         |
| Framework | Effect 4.0-beta.43    | Service/layer patterns, `Effect.fn` composition        |
| Schema    | Zod                   | Config schema extensions in `experimental.*`           |
| Pub/Sub   | Bus (BusEvent.define) | Typed orchestration lifecycle events                   |
| Hooks     | Plugin.trigger        | Existing hook system (available for future extensions) |
| Test      | bun:test              | Unit tests for each new module                         |

## Components

| Component          | Responsibility                                                     | Dependencies                        |
| ------------------ | ------------------------------------------------------------------ | ----------------------------------- |
| `loop-detector`    | Track per-session tool call signatures; detect consecutive repeats | None (pure, stateless factory)      |
| `events`           | Define Bus event types for orchestration lifecycle                 | `Bus`, `BusEvent`, `Zod`            |
| `tool-guard`       | Wrap tool execution with loop detection pre/post checks            | `loop-detector`, `events`, `Config` |
| `spawn-limits`     | Track subagent depth + descendant count; enforce limits            | `Session`, `events`, `Config`       |
| `concurrency`      | Keyed semaphore (provider+model) with acquire/release/cancel       | `events`, `Config`                  |
| `category-routing` | Resolve `{providerID, modelID}` from category name + config map    | `Config`                            |
| `ultrawork`        | Detect `ulw`/`ultrawork` keyword in prompt text; return override   | None (pure function)                |
| `ultrawork-hook`   | Resolve ultrawork model override from prompt text + config         | `ultrawork`, `Config`               |

## Architecture

```
                          ┌──────────────────────────────────────────────────────┐
                          │                  User / Parent Agent                 │
                          └──────────────────────┬───────────────────────────────┘
                                                 │ prompt
                                                 ▼
                          ┌──────────────────────────────────────────────────────┐
                          │               SessionPrompt.prompt()                 │
                          └──────────────────────┬───────────────────────────────┘
                                                 │ tool calls
                                                 ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                            SessionProcessor (existing, unchanged)                    │
│                                                                                     │
│  ┌──────────────┐                                                                   │
│  │ doom-loop    │ ← existing: threshold 3, permission escalation                    │
│  │ (unchanged)  │                                                                   │
│  └──────────────┘                                                                   │
└──────────────────────────────────────────────────────────────────────────────────────┘
                               │ task tool call
                               ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                          TaskTool.execute() (existing, ~35 lines added)              │
│                                                                                     │
│  ┌──────────────┐  ┌──────────────────┐  ┌──────────────────┐                       │
│  │ tool-guard   │  │  spawn-limits    │  │  concurrency     │                       │
│  │ .before()    │  │  .assertCanSpawn │  │  .acquire(key)   │                       │
│  │ (loop check) │  │  .registerSpawn  │  │  .release(key)   │                       │
│  └──────┬───────┘  └────────┬─────────┘  └────────┬─────────┘                       │
│         │                   │                      │                                │
│  ┌──────────────────────────┴──────────────────────┘                                │
│  │                                                                                  │
│  │  ┌──────────────────────────┐  ┌──────────────────┐                              │
│  │  │  category-routing        │  │  ultrawork-hook   │                              │
│  │  │  .resolve(category,cfg)  │  │  .resolveModel()  │                              │
│  │  └────────────┬─────────────┘  └────────┬─────────┘                              │
│  │               │                          │                                       │
│  │               ▼                          ▼                                       │
│  │       model override (category)   model override (ulw keyword)                   │
│  │               └──────────┬───────────────┘                                       │
│  │                          ▼                                                       │
│  └──▶ Session.create() → SessionPrompt.prompt()                                     │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                          BatchTool.execute() (existing, ~10 lines added)             │
│                                                                                     │
│  ┌──────────────────┐                                                               │
│  │  concurrency     │ ← optional batch-level concurrency gate                       │
│  │  .acquire/release│                                                               │
│  └──────────────────┘                                                               │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                          events.ts (Bus events)                                      │
│                                                                                     │
│  orchestration.spawn          orchestration.spawn-rejected                           │
│  orchestration.complete       orchestration.abort                                    │
│  orchestration.loop-detected  orchestration.concurrency-queued                       │
│  orchestration.concurrency-released                                                  │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

**Description**: All new orchestration logic lives in `src/orchestration/`. The existing `task.ts` gets a guard layer (~35 lines) that delegates to the new modules. The existing `batch.ts` gets optional concurrency wrapping (~10 lines). Ultrawork detection is called directly from `task.ts` as a pure function — no plugin registration needed. Each module is independently config-gated via `experimental.*` fields. The Bus events provide observability without modifying core event flow.

## Interfaces

### loop-detector.ts

| Method                   | Input                                  | Output         | Behavior                                              | Errors |
| ------------------------ | -------------------------------------- | -------------- | ----------------------------------------------------- | ------ |
| `create(opts?)`          | `{ threshold?: number }`               | `LoopDetector` | Factory: creates a new per-session detector instance  | None   |
| `detector.record(entry)` | `{ toolName: string, input: unknown }` | `void`         | Records tool call signature into ring buffer          | None   |
| `detector.detect(entry)` | `{ toolName: string, input: unknown }` | `boolean`      | Returns true if last N calls all match this signature | None   |
| `detector.reset()`       | `void`                                 | `void`         | Clears ring buffer and counter                        | None   |

```typescript
// src/orchestration/loop-detector.ts
type Entry = { toolName: string; input: unknown }

export type LoopDetector = {
  readonly record: (entry: Entry) => void
  readonly detect: (entry: Entry) => boolean
  readonly reset: () => void
}

export function create(opts?: { threshold?: number }): LoopDetector
```

**Design note**: This is structurally identical to the existing `src/session/doom-loop.ts` but with `reset()` added and a higher default threshold (5 vs 3). The existing doom-loop detector handles the processor-level "same tool same input" case with permission escalation. This new loop detector is intended for a broader orchestration-level guard (tool-guard.ts) that can abort/escalate across the full session scope, not just within a single processor step. They are complementary — doom-loop triggers a permission ask, loop-detector triggers a hard abort via tool-guard.

### events.ts

| Method                      | Input               | Output                | Behavior                                        | Errors |
| --------------------------- | ------------------- | --------------------- | ----------------------------------------------- | ------ |
| `Event.Spawn`               | BusEvent definition | `BusEvent.Definition` | Published when subagent is spawned              | N/A    |
| `Event.SpawnRejected`       | BusEvent definition | `BusEvent.Definition` | Published when spawn is rejected by limits      | N/A    |
| `Event.Complete`            | BusEvent definition | `BusEvent.Definition` | Published when subagent completes               | N/A    |
| `Event.Abort`               | BusEvent definition | `BusEvent.Definition` | Published when subagent is aborted              | N/A    |
| `Event.LoopDetected`        | BusEvent definition | `BusEvent.Definition` | Published when loop detector triggers           | N/A    |
| `Event.ConcurrencyQueued`   | BusEvent definition | `BusEvent.Definition` | Published when request enters concurrency queue | N/A    |
| `Event.ConcurrencyReleased` | BusEvent definition | `BusEvent.Definition` | Published when concurrency slot is released     | N/A    |

```typescript
// src/orchestration/events.ts
import z from "zod"
import { BusEvent } from "../bus/bus-event"

export namespace OrchestrationEvent {
  export const Spawn = BusEvent.define(
    "orchestration.spawn",
    z.object({
      sessionID: z.string(),
      parentSessionID: z.string(),
      agent: z.string(),
      depth: z.number(),
    }),
  )

  export const SpawnRejected = BusEvent.define(
    "orchestration.spawn-rejected",
    z.object({
      sessionID: z.string(),
      agent: z.string(),
      reason: z.enum(["max_depth", "max_descendants"]),
      limit: z.number(),
      current: z.number(),
    }),
  )

  export const Complete = BusEvent.define(
    "orchestration.complete",
    z.object({
      sessionID: z.string(),
      parentSessionID: z.string(),
      agent: z.string(),
      durationMs: z.number(),
    }),
  )

  export const Abort = BusEvent.define(
    "orchestration.abort",
    z.object({
      sessionID: z.string(),
      reason: z.string(),
    }),
  )

  export const LoopDetected = BusEvent.define(
    "orchestration.loop-detected",
    z.object({
      sessionID: z.string(),
      toolName: z.string(),
      count: z.number(),
    }),
  )

  export const ConcurrencyQueued = BusEvent.define(
    "orchestration.concurrency-queued",
    z.object({
      key: z.string(),
      queueLength: z.number(),
    }),
  )

  export const ConcurrencyReleased = BusEvent.define(
    "orchestration.concurrency-released",
    z.object({
      key: z.string(),
      queueLength: z.number(),
    }),
  )
}
```

### tool-guard.ts

| Method                | Input                                      | Output      | Behavior                                                             | Errors              |
| --------------------- | ------------------------------------------ | ----------- | -------------------------------------------------------------------- | ------------------- |
| `create(opts)`        | `{ sessionID: string, threshold: number }` | `ToolGuard` | Factory: creates guard instance for a session                        | None                |
| `guard.before(entry)` | `{ toolName: string, input: unknown }`     | `void`      | Records call, checks loop, publishes event + throws if loop detected | `LoopDetectedError` |
| `guard.reset()`       | `void`                                     | `void`      | Resets underlying loop detector                                      | None                |

```typescript
// src/orchestration/tool-guard.ts
import { LoopDetector, create as createDetector } from "./loop-detector"
import { OrchestrationEvent } from "./events"
import { Bus } from "../bus"

export class LoopDetectedError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly threshold: number,
  ) {
    super(
      `Loop detected: tool "${toolName}" called ${threshold} consecutive times with identical input. Aborting to prevent infinite loop.`,
    )
    this.name = "LoopDetectedError"
  }
}

export type ToolGuard = {
  readonly before: (entry: { toolName: string; input: unknown }) => Promise<void>
  readonly reset: () => void
}

export function create(opts: { sessionID: string; threshold: number }): ToolGuard
```

### spawn-limits.ts

| Method                         | Input                                               | Output                       | Behavior                                                                                    | Errors            |
| ------------------------------ | --------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------- | ----------------- |
| `assertCanSpawn(opts)`         | `{ sessionID, parentID, maxDepth, maxDescendants }` | `Promise<{ depth: number }>` | Walks parentID chain to compute depth; checks global descendant count; throws if over limit | `SpawnLimitError` |
| `registerSpawn(rootSessionID)` | `string`                                            | `void`                       | Increments descendant counter for root session                                              | None              |
| `releaseSpawn(rootSessionID)`  | `string`                                            | `void`                       | Decrements descendant counter for root session                                              | None              |
| `getDepth(sessionID)`          | `string`                                            | `Promise<number>`            | Walks parentID chain to compute current depth                                               | None              |

```typescript
// src/orchestration/spawn-limits.ts
import type { SessionID } from "../session/schema"

export class SpawnLimitError extends Error {
  constructor(
    public readonly reason: "max_depth" | "max_descendants",
    public readonly limit: number,
    public readonly current: number,
  ) {
    super(
      reason === "max_depth"
        ? `Subagent depth limit reached: current depth ${current} >= max ${limit}`
        : `Subagent descendant limit reached: current count ${current} >= max ${limit}`,
    )
    this.name = "SpawnLimitError"
  }
}

// In-memory descendant counters keyed by root session ID
const descendants: Map<string, number> = new Map()

export async function getDepth(sessionID: SessionID): Promise<number>
export async function assertCanSpawn(opts: {
  sessionID: SessionID
  parentID?: SessionID
  maxDepth: number
  maxDescendants: number
}): Promise<{ depth: number; rootSessionID: string }>
export function registerSpawn(rootSessionID: string): void
export function releaseSpawn(rootSessionID: string): void
```

### concurrency.ts

| Method                | Input            | Output                               | Behavior                                                            | Errors               |
| --------------------- | ---------------- | ------------------------------------ | ------------------------------------------------------------------- | -------------------- |
| `acquire(key, limit)` | `string, number` | `Promise<void>`                      | Acquires semaphore slot; queues if at limit; publishes queued event | Rejects if cancelled |
| `release(key)`        | `string`         | `void`                               | Releases slot; dequeues next waiter; publishes released event       | None                 |
| `cancelWaiters(key)`  | `string`         | `void`                               | Rejects all queued waiters for key                                  | None                 |
| `stats(key)`          | `string`         | `{ active: number, queued: number }` | Returns current stats for observability                             | None                 |

```typescript
// src/orchestration/concurrency.ts

type Waiter = {
  resolve: () => void
  reject: (err: Error) => void
  settled: boolean
}

type Slot = {
  active: number
  limit: number
  queue: Waiter[]
}

export class ConcurrencyCancelledError extends Error {
  constructor(public readonly key: string) {
    super(`Concurrency wait cancelled for key: ${key}`)
    this.name = "ConcurrencyCancelledError"
  }
}

// Module-level state: keyed semaphore slots
const slots: Map<string, Slot> = new Map()

export async function acquire(key: string, limit: number): Promise<void>
export function release(key: string): void
export function cancelWaiters(key: string): void
export function stats(key: string): { active: number; queued: number }
```

### category-routing.ts

| Method          | Input                                                                             | Output     | Behavior                                                   | Errors |
| --------------- | --------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------- | ------ |
| `resolve(opts)` | `{ category?: string, categories: Record<string, ModelRef>, fallback: ModelRef }` | `ModelRef` | Looks up category in config map; returns match or fallback | None   |

```typescript
// src/orchestration/category-routing.ts

export type ModelRef = {
  providerID: string
  modelID: string
}

export function resolve(opts: { category?: string; categories: Record<string, ModelRef>; fallback: ModelRef }): ModelRef
```

### ultrawork.ts

| Method         | Input    | Output             | Behavior                                                                                  | Errors |
| -------------- | -------- | ------------------ | ----------------------------------------------------------------------------------------- | ------ |
| `detect(text)` | `string` | `ModelRef \| null` | Strips code blocks, tests for `ulw`/`ultrawork` keyword, returns configured model or null | None   |

````typescript
// src/orchestration/ultrawork.ts
import type { ModelRef } from "./category-routing"

// Strips fenced code blocks (```...```) and inline code (`...`) before testing
const KEYWORD_RE = /\b(ulw|ultrawork)\b/i

export function detect(text: string, model?: ModelRef): ModelRef | null
````

### ultrawork-hook.ts

**Design note**: The `experimental.chat.messages.transform` hook can only mutate messages, NOT override model selection. Therefore, ultrawork detection is wired directly into `task.ts` alongside category routing — both resolve a `ModelRef` before `SessionPrompt.prompt()` is called. The ultrawork-hook is NOT a plugin hook; it is a thin adapter called from task.ts.

| Method           | Input                                                | Output             | Behavior                                                                             | Errors |
| ---------------- | ---------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------ | ------ |
| `resolveModel()` | `{ text: string, model?: ModelRef, config: Config }` | `ModelRef \| null` | Calls `detect(text, config.experimental?.ultrawork_model)`, returns override or null | None   |

```typescript
// src/orchestration/ultrawork-hook.ts
import type { ModelRef } from "./category-routing"
import { detect } from "./ultrawork"

// Called from task.ts before SessionPrompt.prompt()
// Returns override model if ultrawork keyword detected, null otherwise
export function resolveModel(opts: { text: string; ultraworkModel?: ModelRef }): ModelRef | null {
  if (!opts.ultraworkModel) return null
  return detect(opts.text, opts.ultraworkModel)
}
```

## Data Flow

### Flow 1: Loop Detection (Phase 1)

| Step | Component    | Action                                                               | Next                                        |
| ---- | ------------ | -------------------------------------------------------------------- | ------------------------------------------- |
| 1    | `task.ts`    | Before `SessionPrompt.prompt()`, calls `tool-guard.before(entry)`    | `tool-guard`                                |
| 2    | `tool-guard` | Calls `loopDetector.record(entry)` then `loopDetector.detect(entry)` | If loop: step 3. If not: return             |
| 3    | `tool-guard` | Publishes `OrchestrationEvent.LoopDetected` via Bus                  | Step 4                                      |
| 4    | `tool-guard` | Throws `LoopDetectedError`                                           | `task.ts` catches and returns as tool error |

**Error Flow**: `LoopDetectedError` propagates as a tool execution error. The LLM sees the error and can adjust. The loop detector is NOT reset automatically — the LLM must change its approach.

**Wiring**: The tool-guard is wired into `task.ts` only. For non-task tools, the existing `doom-loop.ts` in the processor already handles repetition detection with permission escalation (threshold 3). The new loop-detector provides a complementary, configurable guard for subagent orchestration (threshold 5) that triggers a hard abort rather than a permission ask.

### Flow 2: Subagent Spawn Guardrails (Phase 2)

| Step | Component      | Action                                                                               | Next                           |
| ---- | -------------- | ------------------------------------------------------------------------------------ | ------------------------------ |
| 1    | `task.ts`      | Before `Session.create()`, calls `spawn-limits.assertCanSpawn()`                     | Step 2                         |
| 2    | `spawn-limits` | Walks `parentID` chain via `Session.get()` to compute depth; checks descendant count | If OK: step 3. If over: step 5 |
| 3    | `spawn-limits` | Calls `registerSpawn(rootSessionID)`                                                 | Step 4                         |
| 4    | `task.ts`      | Publishes `OrchestrationEvent.Spawn`, proceeds with `Session.create()`               | Normal task flow               |
| 5    | `spawn-limits` | Throws `SpawnLimitError`                                                             | Step 6                         |
| 6    | `task.ts`      | Publishes `OrchestrationEvent.SpawnRejected`, re-throws error as tool error          | LLM sees error message         |
| 7    | `task.ts`      | On task completion, calls `releaseSpawn(rootSessionID)` in `finally` block           | Decrements counter             |

**Error Flow**: `SpawnLimitError` is caught in `task.ts` and converted to a descriptive tool error message. The LLM receives the error and can choose an alternative approach. The `releaseSpawn` call is in a `finally` block to ensure cleanup even on abort.

### Flow 3: Concurrency Limiter (Phase 3)

| Step | Component     | Action                                                                                     | Next                 |
| ---- | ------------- | ------------------------------------------------------------------------------------------ | -------------------- |
| 1    | `task.ts`     | Before `SessionPrompt.prompt()`, computes key as `${providerID}:${modelID}`                | Step 2               |
| 2    | `concurrency` | `acquire(key, limit)` — if slot available, returns immediately                             | Step 4               |
| 3    | `concurrency` | If at limit, creates Promise-based waiter, publishes `ConcurrencyQueued`                   | Waits for release    |
| 4    | `task.ts`     | Executes `SessionPrompt.prompt()`                                                          | Step 5               |
| 5    | `task.ts`     | In `finally` block, calls `concurrency.release(key)`                                       | Step 6               |
| 6    | `concurrency` | Decrements active count; if waiters queued, resolves next; publishes `ConcurrencyReleased` | Next waiter proceeds |

**Error Flow**: On session abort, `cancelWaiters(key)` is called via the abort signal handler. Queued waiters receive `ConcurrencyCancelledError`. The `release()` in the `finally` block ensures slots are always freed. The `settled` flag on waiters prevents double-resolve/reject.

### Flow 4: Category Routing (Phase 4)

| Step | Component          | Action                                                            | Next               |
| ---- | ------------------ | ----------------------------------------------------------------- | ------------------ |
| 1    | `task.ts`          | Reads `config.experimental?.task_categories`                      | Step 2             |
| 2    | `category-routing` | `resolve({ category, categories, fallback })`                     | Returns `ModelRef` |
| 3    | `task.ts`          | Uses returned `ModelRef` for `SessionPrompt.prompt()` model param | Normal prompt flow |

**Error Flow**: If category not found in config, falls back to parent model. No error thrown.

### Flow 5: Ultrawork Override (Phase 4)

| Step | Component        | Action                                                                          | Next                       |
| ---- | ---------------- | ------------------------------------------------------------------------------- | -------------------------- |
| 1    | `task.ts`        | Reads user prompt text from `params.prompt`                                     | Step 2                     |
| 2    | `ultrawork-hook` | `resolveModel({ text, ultraworkModel: config.experimental?.ultrawork_model })`  | Returns `ModelRef` or null |
| 3    | `task.ts`        | If model returned, overrides the resolved model before `SessionPrompt.prompt()` | Normal prompt flow         |

**Error Flow**: If `ultrawork_model` not configured, `resolveModel()` returns null. No-op. If keyword appears only inside code blocks, stripped text won't match. No false positives.

**Wiring**: Called directly in `task.ts` after category routing, before concurrency acquire. ~2 lines added to task.ts. No plugin registration needed.

## Data Model

No database schema changes. All state is in-memory:

| Entity                             | Fields                                               | Relationships                 | Constraints                                           |
| ---------------------------------- | ---------------------------------------------------- | ----------------------------- | ----------------------------------------------------- |
| LoopDetector (in-memory)           | `ring: hash[]`, `total: number`, `threshold: number` | Per-session instance          | Ring buffer size = threshold                          |
| SpawnLimits (module-level Map)     | `descendants: Map<string, number>`                   | Keyed by root session ID      | Counter >= 0, decremented in finally                  |
| ConcurrencySlot (module-level Map) | `active: number`, `limit: number`, `queue: Waiter[]` | Keyed by `providerID:modelID` | active <= limit; settled flag prevents double-resolve |

## Config Schema Additions

Exact fields added to the existing `experimental` Zod object in `src/config/config.ts`:

```typescript
experimental: z.object({
  // ... existing fields ...

  // Phase 1: Loop Detector
  loop_detector_threshold: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Consecutive identical tool calls before loop detection triggers (default: 5)"),

  // Phase 2: Spawn Limits
  max_subagent_depth: z.number().int().positive().optional().describe("Maximum subagent nesting depth (default: 3)"),
  max_subagent_descendants: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum total subagent descendants per root session (default: 50)"),

  // Phase 3: Concurrency
  model_concurrency: z
    .record(z.string(), z.number().int().positive())
    .optional()
    .describe("Per-model concurrency limits keyed by 'providerID:modelID' (default: 5 for all)"),

  // Phase 4: Category Routing + Ultrawork
  task_categories: z
    .record(
      z.string(),
      z.object({
        providerID: z.string(),
        modelID: z.string(),
      }),
    )
    .optional()
    .describe("Map task category names to specific provider/model combos"),
  ultrawork_model: z
    .object({
      providerID: z.string(),
      modelID: z.string(),
    })
    .optional()
    .describe("Model override when 'ulw' or 'ultrawork' keyword detected in prompt"),
}).optional()
```

## Wiring Points

Exact edits to existing files:

### 1. `src/config/config.ts` — Add 6 fields to `experimental` object

**Location**: Inside the `experimental: z.object({...})` block (lines ~1019-1057).

**Edit**: Append 6 new optional fields after the existing `question_ask_timeout` field. This is a pure append — no existing lines modified.

**Lines changed**: ~30 lines added (field definitions with descriptions).

### 2. `src/tool/task.ts` — Add orchestration guards (~35 lines including imports)

**Location**: Inside `execute()` function, between config read and `Session.create()`.

**Edit 1** — Import + spawn guard before `Session.create()` (~line 51-78):

```typescript
// After: const config = await Config.get()
// Before: const session = await iife(async () => { ... Session.create() ... })

import { assertCanSpawn, registerSpawn, releaseSpawn } from "../orchestration/spawn-limits"
import { acquire, release } from "../orchestration/concurrency"
import { resolve as resolveCategory } from "../orchestration/category-routing"
import { OrchestrationEvent } from "../orchestration/events"
import { Bus } from "../bus"

// Spawn guard (~5 lines)
const maxDepth = config.experimental?.max_subagent_depth ?? 3
const maxDesc = config.experimental?.max_subagent_descendants ?? 50
const spawnInfo = await assertCanSpawn({
  sessionID: ctx.sessionID,
  parentID: ctx.sessionID,
  maxDepth,
  maxDescendants: maxDesc,
})
```

**Edit 2** — Register spawn + publish event after `Session.create()`:

```typescript
registerSpawn(spawnInfo.rootSessionID)
await Bus.publish(OrchestrationEvent.Spawn, {
  sessionID: session.id,
  parentSessionID: ctx.sessionID,
  agent: agent.name,
  depth: spawnInfo.depth,
})
```

**Edit 3** — Concurrency acquire/release wrapping `SessionPrompt.prompt()` (~4 lines):

```typescript
// Category routing (~2 lines)
const categoryModel = resolveCategory({
  category: params.subagent_type,
  categories: config.experimental?.task_categories ?? {},
  fallback: model,
})

// Concurrency (~4 lines wrapping prompt call)
const concurrencyKey = `${categoryModel.providerID}:${categoryModel.modelID}`
const concurrencyLimit = config.experimental?.model_concurrency?.[concurrencyKey] ?? 5
await acquire(concurrencyKey, concurrencyLimit)
try {
  const result = await withTimeout(SessionPrompt.prompt({...}), timeout)
  // ... existing result handling ...
} finally {
  release(concurrencyKey)
  releaseSpawn(spawnInfo.rootSessionID)
}
```

**Edit 4** — Publish complete/abort events:

```typescript
await Bus.publish(OrchestrationEvent.Complete, {
  sessionID: session.id,
  parentSessionID: ctx.sessionID,
  agent: agent.name,
  durationMs: Date.now() - startTime,
})
```

**Total lines changed in task.ts**: ~35 lines (imports + spawn guard + register + concurrency + category routing + ultrawork + event publishing + try/finally). All complex logic delegated to new files.

### 3. `src/tool/batch.ts` — Add concurrency limiter (~10 lines)

**Location**: Inside `execute()`, wrapping the `Promise.all()` call (line ~134).

**Edit** — Wrap parallel execution with per-tool concurrency:

```typescript
import { acquire, release } from "../orchestration/concurrency"
import { Config } from "../config/config"

// Inside executeCall(), wrap tool.execute() with concurrency guard
// Only applies when tool makes external API calls (e.g., nested LLM calls)
// For batch, the concurrency key is "batch:${toolName}" to prevent
// 25 simultaneous bash/read calls from overwhelming the system
const config = await Config.get()
const batchConcurrency = config.experimental?.model_concurrency?.["batch"] ?? 25 // default: no limit change

// Wrap Promise.all with optional batch-level concurrency:
const executeWithConcurrency = async (call) => {
  await acquire("batch", batchConcurrency)
  try {
    return await executeCall(call)
  } finally {
    release("batch")
  }
}
await Promise.all(toolCalls.map(executeWithConcurrency))
```

**Lines changed**: ~10 lines (import + wrapper function + config read). Existing `Promise.all` call replaced with concurrency-wrapped version. Only active when `experimental.model_concurrency.batch` is set; otherwise defaults to 25 (existing limit, effectively no change).

### 4. `src/orchestration/ultrawork-hook.ts` — New file, called from task.ts

**No edit to existing plugin files**. The ultrawork hook is a pure function called directly from `task.ts` alongside category routing. No plugin registration needed.

**Wiring in task.ts** (already included in Edit 3 area):

```typescript
import { resolveModel as resolveUltrawork } from "../orchestration/ultrawork-hook"

// After category routing, before concurrency acquire (~2 lines)
const ultraworkModel = resolveUltrawork({
  text: params.prompt,
  ultraworkModel: config.experimental?.ultrawork_model,
})
const finalModel = ultraworkModel ?? categoryModel
```

**Total additional lines in task.ts for ultrawork**: ~3 (import + resolve + fallback).

## Decisions

| Decision                                       | Choice                              | Reason                                                                                                                             | Alternatives                       | Tradeoffs                                                                                             |
| ---------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Separate loop-detector from existing doom-loop | New module in `orchestration/`      | Doom-loop triggers permission ask (soft). Loop-detector triggers hard abort. Different thresholds (3 vs 5). Different scopes.      | Extend existing doom-loop          | Slight code duplication of hash logic, but keeps concerns separated and existing behavior untouched   |
| In-memory spawn tracking                       | Module-level `Map<string, number>`  | No DB changes required. Spawn counts are transient — if process restarts, counts reset (acceptable for guardrails)                 | DB column on session table         | Simpler, no migration, acceptable loss on restart                                                     |
| Promise-queue concurrency                      | Custom `Waiter[]` with settled flag | Lightweight, no external deps. Settled flag prevents double-resolve race.                                                          | Effect Semaphore, p-limit          | Effect Semaphore would require threading through layers; p-limit is external dep. Custom is ~30 lines |
| Ultrawork via task.ts callsite                 | Direct call in `task.ts`            | The `experimental.chat.messages.transform` hook can only mutate messages, not model selection. Direct call is simpler and correct. | Plugin hook (can't override model) | Adds ~3 lines to task.ts, but avoids incorrect hook usage                                             |
| Category routing as pure function              | Stateless `resolve()`               | No side effects, trivially testable, no service layer needed                                                                       | Effect service                     | Over-engineering for a simple map lookup                                                              |
| Config fields appended to `experimental`       | Optional Zod fields                 | Merge-safe: appending fields to an object is trivially rebased even if upstream adds others                                        | New top-level config section       | `experimental` is the established pattern for feature flags                                           |
| Depth computed by walking parentID chain       | `Session.get()` loop                | Accurate, uses existing data. Max 3 hops (at default depth limit)                                                                  | Store depth in session table       | No DB change; 3 async calls is negligible                                                             |

## Risks

| Risk                               | Impact                                                         | Likelihood | Mitigation                                                                                                                                                      |
| ---------------------------------- | -------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loop detector false positives      | Legitimate repeated tool calls (e.g., polling) get aborted     | Low        | Configurable threshold (default 5 is generous); only exact signature match (tool + JSON input)                                                                  |
| Spawn counter leak on crash        | Descendant count never decremented if process crashes mid-task | Low        | Counters are in-memory; process restart resets to 0. Worst case: slightly lower effective limit until restart                                                   |
| Concurrency deadlock               | All slots held by tasks waiting on each other                  | Low        | Tasks don't wait on each other (they wait on LLM). `cancelWaiters()` on abort prevents permanent blocking. Settled flag prevents double-resolve                 |
| `task.ts` merge conflict on rebase | Upstream changes to task.ts conflict with our ~35 lines        | Medium     | All logic in new files; task.ts changes are localized and clearly delimited with comments. batch.ts gets ~10 lines.                                             |
| Ultrawork keyword in code blocks   | False positive model override                                  | Low        | Strip fenced code blocks (` ``` `) and inline code (`` ` ``) before regex test                                                                                  |
| Config schema field name collision | Upstream adds field with same name                             | Very Low   | Field names are specific (`loop_detector_threshold`, `max_subagent_depth`, etc.) and under `experimental`                                                       |
| Race in concurrent assertCanSpawn  | Two tasks pass depth check simultaneously, both spawn          | Low        | Descendant counter is synchronous (single-threaded JS). Depth walk is async but depth is structural (parentID chain), not a counter — concurrent reads are safe |

## Test Plan

### Unit Tests

#### `test/orchestration/loop-detector.test.ts`

- **Happy path**: Record N-1 identical calls → `detect()` returns false
- **Trigger**: Record N identical calls → `detect()` returns true
- **Mixed calls**: Interleaved different calls → no false positive
- **Reset**: After `reset()`, detector starts fresh
- **Custom threshold**: Threshold of 1, 5, 10 all work correctly
- **Edge case**: Empty input object, null input, large input
- **Ring buffer wrap**: Record > threshold calls, verify only last N matter
- **Mock deps**: None (pure module)
- **Coverage target**: 100%

#### `test/orchestration/spawn-limits.test.ts`

- **Happy path**: Depth 0, spawn allowed at maxDepth=3
- **Depth limit**: Walk chain of 3 parents → reject at depth 3
- **Descendant limit**: Register 50 spawns → reject 51st
- **Release**: After `releaseSpawn()`, counter decrements; next spawn allowed
- **Root session tracking**: Different root sessions have independent counters
- **Edge case**: `parentID` is undefined (root session, depth=0)
- **Mock deps**: Mock `Session.get()` to return fake sessions with parentID chains
- **Coverage target**: 95%+

#### `test/orchestration/concurrency.test.ts`

- **Happy path**: Acquire under limit → resolves immediately
- **Queue**: Acquire at limit → queues; release → dequeues
- **Cancel**: `cancelWaiters()` rejects all queued promises with `ConcurrencyCancelledError`
- **Settled flag**: Release after cancel doesn't double-resolve
- **Multiple keys**: Different keys have independent limits
- **Stats**: `stats()` returns correct active/queued counts
- **Concurrent acquire**: Multiple acquires at limit all queue correctly
- **Edge case**: Release when no active slots (no-op)
- **Mock deps**: None (pure module)
- **Coverage target**: 100%

#### `test/orchestration/category-routing.test.ts`

- **Happy path**: Category exists in map → returns mapped model
- **Fallback**: Category not in map → returns fallback model
- **Undefined category**: `category` is undefined → returns fallback
- **Empty map**: Empty categories → always fallback
- **Mock deps**: None (pure function)
- **Coverage target**: 100%

#### `test/orchestration/ultrawork.test.ts`

- **Happy path**: "ulw" in text → returns configured model
- **Keyword variants**: "ultrawork", "ULW", "Ultrawork" all match (case-insensitive)
- **Code block stripping**: Keyword inside ` ```code``` ` → returns null
- **Inline code stripping**: Keyword inside `` `code` `` → returns null
- **No config**: `model` is undefined → returns null
- **No keyword**: Normal text → returns null
- **Edge case**: Keyword at start/end of text, keyword as part of URL
- **Mock deps**: None (pure function)
- **Coverage target**: 100%

#### `test/orchestration/events.test.ts`

- **Schema validation**: Each event schema validates correct payloads
- **Schema rejection**: Each event schema rejects invalid payloads
- **Type string**: Each event has correct `type` string prefix
- **Mock deps**: None (schema validation only)
- **Coverage target**: 100%

#### `test/orchestration/tool-guard.test.ts`

- **Happy path**: Non-repeating calls → no error
- **Loop detected**: Repeating calls → throws `LoopDetectedError`
- **Bus event**: On loop detection, `OrchestrationEvent.LoopDetected` is published
- **Reset**: After `reset()`, guard allows previously-looping calls
- **Config threshold**: Respects configured threshold
- **Mock deps**: Mock `Bus.publish`
- **Coverage target**: 95%+

### Integration Tests

#### `test/orchestration/spawn-limits.test.ts` (integration section)

- **Task tool + spawn limits**: Create nested task calls up to depth limit; verify 4th level is rejected
- **Descendant counting**: Spawn many parallel tasks; verify count tracking across concurrent spawns
- **Cleanup on abort**: Abort a task mid-execution; verify `releaseSpawn` is called

#### `test/orchestration/concurrency.test.ts` (integration section)

- **Multiple concurrent acquires**: 10 concurrent acquires with limit 3; verify only 3 proceed at a time
- **Abort during queue**: Cancel waiters while tasks are queued; verify clean rejection

### End-to-End Tests

Not required for this feature set. All features are internal orchestration guards that don't change user-facing behavior (they only add guardrails). The unit + integration tests provide sufficient coverage.

### Non-Functional Tests

#### Performance

- **Loop detector**: `record()` and `detect()` must be < 1ms (hash computation). Verified by running 10,000 iterations in unit test.
- **Concurrency limiter**: `acquire()` when under limit must be < 0.1ms (no async wait). Verified by timing test.
- **Spawn depth walk**: Max 3 `Session.get()` calls at default depth. Acceptable latency (~3ms total).

#### Security

- **No new auth surfaces**: All features are internal guards, not exposed via API.
- **Config validation**: All new config fields have Zod validation with `.int().positive()` constraints.
- **Input sanitization**: Loop detector uses `JSON.stringify` + `Bun.hash` — no injection risk.

#### Scalability

- **In-memory maps**: Spawn counters and concurrency slots grow with active sessions. At 50 max descendants, memory is negligible.
- **Concurrency queue**: Queue length bounded by number of concurrent task calls. In practice, < 100 waiters.

```

```
