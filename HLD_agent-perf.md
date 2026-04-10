# HLD: Agent Workflow Performance (P0+P1)

## Tech Stack

| Category  | Technology      | Purpose                                              |
| --------- | --------------- | ---------------------------------------------------- |
| Language  | TypeScript      | Existing codebase language                           |
| Runtime   | Bun             | JS runtime with built-in test runner                 |
| Framework | Effect          | Service/layer composition, Effect.fn, InstanceState  |
| ORM       | Drizzle         | SQLite persistence via SyncEvent projectors          |
| SSE       | Hono            | Server-sent events for real-time client updates      |
| Testing   | Bun test        | Unit + integration tests in packages/opencode/test/  |

## Components

| Component          | Responsibility                                               | Dependencies                                    |
| ------------------ | ------------------------------------------------------------ | ----------------------------------------------- |
| PartCoalescer      | Batch part metadata writes within a time window              | SyncEvent, MessageV2.Event.PartUpdated          |
| DoomLoopDetector   | In-memory ring buffer for repetitive tool-call detection     | ProcessorContext (processor.ts)                  |
| EventFilter        | Server-side SSE event filtering + bounded queue              | AsyncQueue, Bus, Hono SSE route                  |
| HistoryCache       | Per-session incremental model-message cache                  | MessageV2, filterCompacted, toModelMessagesEffect|
| ToolSchemaCache    | Cache resolved tool definitions across loop iterations       | ToolRegistry, Plugin, ProviderTransform          |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        SessionPrompt.runLoop                        │
│                                                                     │
│  ┌──────────────┐   ┌──────────────────┐   ┌─────────────────────┐ │
│  │ HistoryCache │──▶│ resolveTools     │──▶│ ToolSchemaCache     │ │
│  │ (Phase 4)    │   │ (Phase 5 inside) │   │ (Phase 5)           │ │
│  └──────┬───────┘   └──────────────────┘   └─────────────────────┘ │
│         │                                                           │
│         ▼                                                           │
│  ┌──────────────────────────────────────────┐                      │
│  │        SessionProcessor.handleEvent       │                      │
│  │  ┌────────────────┐  ┌─────────────────┐ │                      │
│  │  │ PartCoalescer  │  │ DoomLoopDetector│ │                      │
│  │  │ (Phase 1)      │  │ (Phase 2)       │ │                      │
│  │  └───────┬────────┘  └─────────────────┘ │                      │
│  │          │                                │                      │
│  │          ▼                                │                      │
│  │  SyncEvent.run(PartUpdated) ──▶ DB write  │                      │
│  └──────────────────────────────────────────┘                      │
│                        │                                            │
│                        ▼                                            │
│  ┌──────────────────────────────────────────┐                      │
│  │          Bus.publish (all events)         │                      │
│  │                    │                      │                      │
│  │                    ▼                      │                      │
│  │  ┌──────────────────────────────────┐    │                      │
│  │  │ EventFilter (Phase 3)            │    │                      │
│  │  │ SSE: ?sessionID=X&types=a,b      │    │                      │
│  │  │ BoundedQueue: drop-oldest        │    │                      │
│  │  └──────────────────────────────────┘    │                      │
│  └──────────────────────────────────────────┘                      │
└─────────────────────────────────────────────────────────────────────┘
```

**Description**: The prompt loop (`runLoop`) iterates: fetch history → resolve tools → stream LLM → process events. Each phase targets a specific bottleneck in this loop:

- **Phase 1** intercepts `Session.updatePart` calls to coalesce rapid-fire metadata writes (e.g., bash tool output streaming) into batched DB writes.
- **Phase 2** replaces the `MessageV2.parts()` DB query in the doom-loop check with an in-memory ring buffer maintained in `ProcessorContext`.
- **Phase 3** filters events server-side before SSE serialization and adds backpressure via a bounded queue.
- **Phase 4** caches the `filterCompacted → toModelMessages` pipeline across loop iterations, only recomputing the delta.
- **Phase 5** caches resolved tool definitions across loop iterations when the tool configuration hasn't changed.

## Interfaces

### PartCoalescer (Phase 1)

New module: `packages/opencode/src/session/part-coalescer.ts`

| Method | Input | Output | Behavior | Errors |
|--------|-------|--------|----------|--------|
| `create` | `{ flush: (part: MessageV2.Part) => Effect<void> }` | `PartCoalescer` | Creates a coalescer instance with configurable flush callback | None |
| `update` | `part: MessageV2.Part` | `Effect<void>` | Buffers the part; if terminal state (`completed`/`error` for tool, `end` time set for text/reasoning) or `step-start`/`step-finish`/`patch`/`snapshot`, flushes immediately. Otherwise schedules flush after `COALESCE_MS` (300ms). Emits `PartDelta`-style bus event for live UI. | None |
| `flush` | `void` | `Effect<void>` | Persists all buffered parts immediately | None |
| `dispose` | `void` | `Effect<void>` | Flushes remaining buffer and clears timers | None |

```typescript
// packages/opencode/src/session/part-coalescer.ts
interface PartCoalescer {
  readonly update: (part: MessageV2.Part) => Effect.Effect<void>
  readonly flush: () => Effect.Effect<void>
  readonly dispose: () => Effect.Effect<void>
}
```

**Integration point**: `SessionProcessor.create()` in `processor.ts` instantiates a `PartCoalescer`. All `session.updatePart(...)` calls within `handleEvent` go through `coalescer.update(...)` instead. The `cleanup()` function calls `coalescer.dispose()`.

**Terminal state detection logic**:
```typescript
function isTerminal(part: MessageV2.Part): boolean {
  if (part.type === "tool") return part.state.status === "completed" || part.state.status === "error"
  if (part.type === "text") return !!part.time?.end
  if (part.type === "reasoning") return !!part.time?.end
  // These part types are always written once — flush immediately
  if (["step-start", "step-finish", "patch", "snapshot", "compaction", "subtask", "retry"].includes(part.type)) return true
  return false
}
```

### DoomLoopDetector (Phase 2)

New module: `packages/opencode/src/session/doom-loop.ts`

| Method | Input | Output | Behavior | Errors |
|--------|-------|--------|----------|--------|
| `create` | `{ threshold?: number }` | `DoomLoopDetector` | Creates detector with configurable threshold (default: 3) | None |
| `record` | `{ toolName: string, input: unknown }` | `void` | Appends `hash(toolName, input)` to ring buffer | None |
| `detect` | `{ toolName: string, input: unknown }` | `boolean` | Returns `true` if last N entries (N = threshold) all match the given signature | None |

```typescript
// packages/opencode/src/session/doom-loop.ts
interface DoomLoopDetector {
  readonly record: (entry: { toolName: string; input: unknown }) => void
  readonly detect: (entry: { toolName: string; input: unknown }) => boolean
}
```

**Hashing strategy**: Use `Bun.hash(toolName + "\0" + JSON.stringify(input))` which returns a 64-bit number. This is deterministic and fast. The ring buffer stores the last `threshold` hashes as a fixed-size `BigInt64Array` (or `number[]`).

**Integration point**: In `processor.ts` at the `tool-call` event handler (lines 201-241):
- Replace `const parts = MessageV2.parts(ctx.assistantMessage.id)` and the subsequent filtering/comparison with `doomLoop.detect(...)`.
- Call `doomLoop.record(...)` after each `tool-call` event is processed.
- The `DoomLoopDetector` instance lives on `ProcessorContext`.

### EventFilter (Phase 3)

Modified files:
- `packages/opencode/src/server/routes/event.ts`
- `packages/opencode/src/util/queue.ts`

#### AsyncQueue changes

| Method | Input | Output | Behavior | Errors |
|--------|-------|--------|----------|--------|
| `constructor` | `{ maxSize?: number }` | `AsyncQueue<T>` | Creates queue with optional bounded size (default: unbounded) | None |
| `push` | `item: T` | `void` | If queue is at capacity, drops oldest non-terminal item. Terminal items (`null`) always enqueue. | None |

```typescript
// packages/opencode/src/util/queue.ts
export class AsyncQueue<T> implements AsyncIterable<T> {
  private maxSize: number
  constructor(opts?: { maxSize?: number })
  push(item: T): void  // drop-oldest when full
  async next(): Promise<T>
  async *[Symbol.asyncIterator](): AsyncIterableIterator<T>
}
```

#### SSE route changes

| Method | Input | Output | Behavior | Errors |
|--------|-------|--------|----------|--------|
| `GET /event` | `?sessionID=string&types=string` | SSE stream | Filters events before enqueue. `sessionID` filters events with a `sessionID` property. `types` is comma-separated event type prefixes (e.g., `message.part,session.status`). | None |

```typescript
// In event.ts route handler:
const sessionFilter = c.req.query("sessionID")
const typeFilter = c.req.query("types")?.split(",")

const unsub = Bus.subscribeAll((event) => {
  // Filter by sessionID if specified
  if (sessionFilter && event.properties?.sessionID && event.properties.sessionID !== sessionFilter) return
  // Filter by type prefix if specified
  if (typeFilter && !typeFilter.some(t => event.type.startsWith(t))) return
  // Always pass through control events
  if (event.type.startsWith("server.") || event.type === "session.status" || event.type === "permission.asked") {
    q.push(JSON.stringify(event))
    return
  }
  q.push(JSON.stringify(event))
})
```

**CLI integration**: In `run.ts`, the SDK's `event.subscribe()` call should pass `sessionID` as a query parameter. This requires checking the SDK client — if the SDK doesn't support query params on the SSE endpoint, the route accepts them as optional and the CLI can use them when available.

### HistoryCache (Phase 4)

New module: `packages/opencode/src/session/history-cache.ts`

| Method | Input | Output | Behavior | Errors |
|--------|-------|--------|----------|--------|
| `create` | `void` | `HistoryCache` | Creates empty cache | None |
| `get` | `{ sessionID, model }` | `Effect<ModelMessage[]>` | Returns cached model messages if valid; otherwise rebuilds from scratch | None |
| `invalidate` | `void` | `void` | Clears cache (e.g., on compaction) | None |

```typescript
// packages/opencode/src/session/history-cache.ts
interface HistoryCacheEntry {
  /** ID of the last message included in the cached result */
  lastMessageID: MessageID
  /** The compaction boundary message ID (first message after filterCompacted) */
  compactionBoundaryID: MessageID
  /** Cached WithParts[] after filterCompacted */
  filteredMessages: MessageV2.WithParts[]
  /** Cached ModelMessage[] output */
  modelMessages: ModelMessage[]
  /** Model used for conversion (affects media handling) */
  modelKey: string
}

interface HistoryCache {
  readonly get: (input: {
    sessionID: SessionID
    model: Provider.Model
  }) => Effect.Effect<{ messages: MessageV2.WithParts[]; modelMessages: ModelMessage[] }>
  readonly invalidate: () => void
}
```

**Cache invalidation strategy**:
1. The cache stores the `compactionBoundaryID` — the ID of the first message returned by `filterCompacted`.
2. On each loop iteration, run `filterCompacted` and compare the first message ID with the cached boundary.
3. If the boundary changed (compaction happened), invalidate and rebuild.
4. If the boundary is the same, find the last cached message ID in the new stream and only convert the tail (new messages) via `toModelMessagesEffect`.
5. Append the new `ModelMessage[]` to the cached array.

**Integration point**: In `prompt.ts` `runLoop`, replace:
```typescript
// BEFORE (lines 1449, 1606-1610)
let msgs = yield* MessageV2.filterCompactedEffect(sessionID)
// ... later ...
const modelMsgs = yield* Effect.promise(() => MessageV2.toModelMessages(msgs, model))
```
with:
```typescript
// AFTER
const { messages: msgs, modelMessages: modelMsgs } = yield* historyCache.get({ sessionID, model })
```

The `HistoryCache` instance is created once per `runLoop` invocation and lives for the duration of the while-loop. On `compaction.create(...)`, call `historyCache.invalidate()`.

### ToolSchemaCache (Phase 5)

Modified file: `packages/opencode/src/tool/registry.ts`

| Method | Input | Output | Behavior | Errors |
|--------|-------|--------|----------|--------|
| `tools` (modified) | `model, agent` | `Effect<(Tool.Def & { id: string })[]>` | Returns cached definitions if cache key matches; otherwise calls `tool.init()` + schema transform and caches result | None |

```typescript
// Cache key structure
type ToolCacheKey = {
  agentName: string
  providerID: ProviderID
  modelID: ModelID
  customToolCount: number  // proxy for toolset version
  pluginToolCount: number  // proxy for plugin version
}

// Cache entry
type ToolCacheEntry = {
  key: ToolCacheKey
  definitions: Omit<Tool.Def & { id: string }, "execute">[]
  executors: Map<string, Tool.Def["execute"]>
}
```

**Cache key rationale**: The tool list depends on `(agent, model, custom tools, plugin tools)`. We use counts as a lightweight version proxy. If a tool is registered/unregistered, the count changes and the cache invalidates. For MCP tools, they are resolved separately in `resolveTools` (not in `registry.tools`), so the registry cache doesn't need to track MCP changes.

**Integration point**: Inside `ToolRegistry.tools()` (registry.ts lines 157-195):
```typescript
// BEFORE
return yield* Effect.forEach(filtered, ...) // calls tool.init() for every tool every time

// AFTER
const key = { agentName: agent?.name ?? "", providerID: model.providerID, modelID: model.modelID, ... }
if (cached && keyMatches(cached.key, key)) {
  // Return cached definitions with fresh executors
  return cached.definitions.map(def => ({ ...def, execute: cached.executors.get(def.id)! }))
}
// Otherwise: init all tools, cache result, return
```

**Important**: The `execute` function closures are cached too since they don't depend on per-call state (the `context` is created per-call in `resolveTools`). The `description` and `parameters` (schema) are the expensive parts to recompute.

**Cache scope**: The cache lives on `InstanceState` within `ToolRegistry`, so it's per-project. It's invalidated when `register()` is called (custom tool added/removed).

## Data Flow

### Phase 1: Part Write Coalescing

| Step | Component | Action | Next |
|------|-----------|--------|------|
| 1 | `processor.handleEvent` | Receives stream event (e.g., `tool-input-delta`, `tool-result`) | PartCoalescer |
| 2 | `PartCoalescer.update` | Checks if part is terminal | Step 3 or 4 |
| 3 | (terminal) | Calls `SyncEvent.run(PartUpdated, ...)` immediately → DB write + Bus publish | Done |
| 4 | (non-terminal) | Stores part in buffer, resets/starts 300ms timer. Publishes lightweight `PartDelta` bus event for live UI. | Timer fires → Step 3 |
| 5 | `PartCoalescer.dispose` | Called from `cleanup()`. Flushes all buffered parts. | Done |

**Before/After**:
```
BEFORE (bash tool streaming output, ~50 chunks):
  chunk₁ → updatePart → SyncEvent.run → DB INSERT/UPDATE → Bus.publish
  chunk₂ → updatePart → SyncEvent.run → DB INSERT/UPDATE → Bus.publish
  ... (50 DB writes)

AFTER:
  chunk₁ → coalescer.update → buffer + Bus.publish(PartDelta)
  chunk₂ → coalescer.update → buffer (reset timer) + Bus.publish(PartDelta)
  ... (timer fires or terminal state)
  flush → SyncEvent.run → DB INSERT/UPDATE → Bus.publish(PartUpdated)
  ... (~5-10 DB writes instead of 50)
```

### Phase 2: Doom-Loop Detection

| Step | Component | Action | Next |
|------|-----------|--------|------|
| 1 | `processor.handleEvent("tool-call")` | Receives tool-call event | DoomLoopDetector |
| 2 | `DoomLoopDetector.detect` | Checks if last N hashes match current `hash(toolName, input)` | Step 3 or 4 |
| 3 | (no loop) | `DoomLoopDetector.record` → continues normal processing | Done |
| 4 | (loop detected) | Triggers `permission.ask({ permission: "doom_loop", ... })` | Done |

**Before/After**:
```
BEFORE:
  tool-call → MessageV2.parts(messageID) → DB SELECT all parts → filter last 3
            → JSON.stringify comparison for each

AFTER:
  tool-call → doomLoop.detect({ toolName, input })
            → compare 3 BigInt hashes in memory (O(1))
```

### Phase 3: Event Filtering

| Step | Component | Action | Next |
|------|-----------|--------|------|
| 1 | Client | Connects to `GET /event?sessionID=X&types=message.part,session.status,session.error,permission` | SSE route |
| 2 | `Bus.subscribeAll` | Receives every bus event | Filter |
| 3 | EventFilter | Checks `sessionID` match and `type` prefix match | Step 4 or skip |
| 4 | `AsyncQueue.push` | Enqueues JSON string; drops oldest if at capacity | SSE write |
| 5 | SSE stream | Writes event to client | Done |

**Before/After**:
```
BEFORE (CLI run with sessionID=X):
  All events for all sessions → JSON.stringify → enqueue → SSE write → client filters

AFTER:
  Event for session Y → filter check → SKIP (never serialized)
  Event for session X → filter check → JSON.stringify → enqueue → SSE write
```

### Phase 4: History Cache

| Step | Component | Action | Next |
|------|-----------|--------|------|
| 1 | `runLoop` iteration N | Calls `historyCache.get({ sessionID, model })` | HistoryCache |
| 2 | HistoryCache | Runs `filterCompacted(stream(sessionID))` | Step 3 |
| 3 | HistoryCache | Compares compaction boundary with cached boundary | Step 4 or 5 |
| 4 | (boundary same) | Finds new messages after `lastMessageID`, converts only tail via `toModelMessagesEffect` | Append to cache → return |
| 5 | (boundary changed / cold) | Full rebuild: convert all messages via `toModelMessagesEffect` | Store in cache → return |

**Before/After**:
```
BEFORE (loop iteration 5, 100 messages):
  filterCompacted → stream all 100 from DB → filter → toModelMessages(100) → full conversion

AFTER:
  filterCompacted → stream all 100 from DB → filter
  → cache hit: only 2 new messages since last iteration
  → toModelMessagesEffect(2 new) → append to cached 98 → return 100
```

### Phase 5: Tool Schema Cache

| Step | Component | Action | Next |
|------|-----------|--------|------|
| 1 | `resolveTools` | Calls `registry.tools(model, agent)` | ToolRegistry |
| 2 | ToolRegistry.tools | Computes cache key from `(agent, model, custom count)` | Step 3 or 4 |
| 3 | (cache hit) | Returns cached `(description, parameters, execute)[]` | resolveTools applies ProviderTransform |
| 4 | (cache miss) | Calls `tool.init()` for each tool, caches result | Return |

**Before/After**:
```
BEFORE (loop iteration 5, 15 tools):
  registry.tools → 15x tool.init() → 15x schema transform → return

AFTER:
  registry.tools → cache key match → return cached definitions (0 init calls)
```

## Data Model

No new database tables or schema changes. All caches and buffers are in-memory only.

| Entity | Fields | Relationships | Constraints |
|--------|--------|---------------|-------------|
| PartCoalescer (in-memory) | `buffer: Map<PartID, { part: Part, timer: Timer }>`, `flushFn` | One per ProcessorContext | Timer auto-clears on dispose |
| DoomLoopDetector (in-memory) | `ring: number[]`, `cursor: number`, `threshold: number` | One per ProcessorContext | Fixed size = threshold |
| HistoryCacheEntry (in-memory) | `lastMessageID`, `compactionBoundaryID`, `filteredMessages[]`, `modelMessages[]`, `modelKey` | One per runLoop invocation | Invalidated on compaction |
| ToolCacheEntry (in-memory) | `key: ToolCacheKey`, `definitions[]`, `executors: Map` | One per InstanceState (ToolRegistry) | Invalidated on register() |

## Decisions

| Decision | Choice | Reason | Alternatives | Tradeoffs |
|----------|--------|--------|--------------|-----------|
| Coalesce window | 300ms fixed | Balances responsiveness with write reduction. Bash tool metadata updates every ~100ms currently. | Adaptive window, exponential backoff | Fixed is simpler; 300ms is imperceptible for metadata |
| Doom-loop hash | `Bun.hash(name + "\0" + JSON.stringify(input))` | Fast (native), deterministic, no external deps. JSON.stringify is only on the single current input, not all parts. | xxhash, FNV, SHA-256 | Bun.hash is fastest; collision risk negligible for 3-entry comparison |
| Ring buffer over DB query | In-memory fixed array | Eliminates DB round-trip entirely for doom-loop check | Keep DB query but add index | DB query cost is the bottleneck; index doesn't help enough |
| Event filter at Bus.subscribeAll callback | Filter before enqueue | Avoids JSON.stringify cost for irrelevant events | Filter after dequeue, client-side filter | Server-side filter is strictly better — less serialization, less network |
| Bounded queue size | 1000 items, drop-oldest | Prevents memory growth on slow clients | Unbounded (current), drop-newest | Drop-oldest preserves latest state; 1000 is generous for any realistic client |
| History cache scope | Per runLoop invocation | Simplest lifecycle — no cross-invocation staleness risk | Per session (persistent), global LRU | Per-invocation avoids all staleness bugs; memory freed on loop exit |
| Tool cache scope | Per InstanceState (project) | Tools rarely change within a project session | Per runLoop, global | Per-project matches tool registration lifecycle |
| Tool cache key | agent + model + counts | Lightweight proxy for "did the toolset change?" | Content hash of all tool schemas | Counts are O(1); content hash would negate the caching benefit |
| No new DB tables | In-memory only | All optimizations are caches/buffers; persistence would add complexity | Persist cache to SQLite | In-memory is simpler, no migration needed, acceptable loss on restart |

## Risks

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Coalesced writes lose data on crash | Last ~300ms of part metadata lost; part appears stale in UI on restart | Low (crash is rare) | Flush on dispose, flush on terminal states, flush on `cleanup()`. Data is reconstructable from LLM re-run. |
| Stale history cache serves wrong messages | Model receives incorrect context, generates wrong response | Low (cache is per-loop, invalidated on compaction) | Compare compaction boundary on every iteration; full rebuild fallback on any mismatch |
| Tool cache serves stale schemas after hot-reload | Tool gets wrong parameters from LLM | Low (hot-reload is rare in production) | Invalidate on `register()` call; cache key includes tool count |
| Doom-loop hash collisions cause false positives | Agent incorrectly paused for permission | Very Low (64-bit hash, only 3 entries compared) | Configurable threshold; permission prompt lets user continue |
| Bounded queue drops important events | CLI misses a tool completion or status change | Low (1000 items is generous) | Terminal events (`session.status`, `session.error`) bypass queue limit; drop-oldest preserves latest state |
| Event filter breaks existing SSE consumers | Web app or desktop app stops receiving events | Low (filters are opt-in via query params) | No filter = current behavior (all events). Only CLI run command opts in. |
| PartCoalescer timer leaks | Memory/timer leak if dispose not called | Low | `cleanup()` in processor.ts always runs (Effect.ensuring); dispose clears all timers |

## Test Plan

### Unit Tests

#### Phase 1: PartCoalescer (`test/session/part-coalescer.test.ts`)

- **Happy path**: Buffer 5 non-terminal parts → only 1-2 DB writes within 300ms window
- **Terminal bypass**: Tool part with `status: "completed"` → immediate flush (0ms delay)
- **Flush on dispose**: Buffer 3 parts → call dispose → all 3 flushed
- **Timer reset**: Rapid updates reset the coalesce timer (not accumulate)
- **Mixed parts**: Interleave terminal and non-terminal parts → terminal always immediate
- **Mock**: `flush` callback counts invocations and captures parts

#### Phase 2: DoomLoopDetector (`test/session/doom-loop.test.ts`)

- **No loop**: 3 different tool calls → `detect()` returns false
- **Loop detected**: 3 identical `(toolName, input)` → `detect()` returns true
- **Ring rotation**: Record 10 entries, only last 3 matter
- **Different tool same input**: `(bash, {cmd: "ls"})` vs `(grep, {cmd: "ls"})` → no loop
- **Same tool different input**: `(bash, {cmd: "ls"})` vs `(bash, {cmd: "pwd"})` → no loop
- **Threshold config**: Threshold=5 → need 5 identical calls to trigger
- **Empty buffer**: `detect()` on fresh detector returns false

#### Phase 3: EventFilter (`test/util/queue.test.ts`, `test/server/event-filter.test.ts`)

- **Bounded queue**: Push 1001 items to queue(maxSize=1000) → oldest dropped, newest preserved
- **Drop-oldest**: Verify the dropped item is the first pushed, not the last
- **Null bypass**: `null` (terminal) always enqueues even at capacity
- **Unbounded fallback**: No `maxSize` → unlimited growth (backwards compat)
- **Session filter**: Events with wrong sessionID are skipped
- **Type filter**: Events with non-matching type prefix are skipped
- **Control events bypass**: `server.heartbeat`, `session.status` always pass through
- **No filter**: No query params → all events pass (backwards compat)

#### Phase 4: HistoryCache (`test/session/history-cache.test.ts`)

- **Cold start**: First call → full rebuild, cache populated
- **Cache hit**: Second call with 2 new messages → only tail converted
- **Compaction invalidation**: Change compaction boundary → full rebuild
- **Model change**: Different model key → full rebuild (media handling differs)
- **Empty session**: No messages → returns empty arrays
- **Correctness**: Compare cached result with full rebuild — must be identical

#### Phase 5: ToolSchemaCache (`test/tool/registry-cache.test.ts`)

- **Cache hit**: Same `(agent, model, tool count)` → no `tool.init()` calls
- **Agent change**: Different agent → cache miss → re-init
- **Model change**: Different model → cache miss → re-init (schema transform differs)
- **Register invalidation**: Call `register()` → next `tools()` call is a cache miss
- **Custom tool added**: Count changes → cache miss
- **Correctness**: Cached definitions match fresh `tool.init()` output

### Integration Tests

#### Prompt Loop Integration (`test/session/prompt-loop-perf.test.ts`)

- **Reduced DB writes**: Run a prompt loop with mocked LLM that emits 20 tool-input-delta events → verify DB write count is < 10 (was 20)
- **Doom-loop triggers permission**: Mock LLM that calls same tool 3x → verify `permission.ask` called with `doom_loop`
- **History cache correctness**: Run 3 loop iterations → verify model messages on iteration 3 match full rebuild
- **Tool cache across iterations**: Run 2 loop iterations → verify `tool.init()` called only on first iteration

#### SSE Filter Integration (`test/server/event-sse.test.ts`)

- **Filtered stream**: Connect with `?sessionID=X` → publish events for X and Y → only X events received
- **Unfiltered stream**: Connect without params → all events received

### End-to-End Tests

- **Full session with bash tool**: Run a real session with bash tool commands → verify output identical to pre-optimization baseline
- **Compaction + cache**: Run session until compaction triggers → verify loop continues correctly with invalidated cache
- **CLI run command**: `opencode run "echo hello"` → verify output matches expected format

### Non-Functional Tests

- **Latency**: Measure time from LLM stream event to SSE delivery — should not increase (coalescer adds ≤300ms to metadata, but terminal events are immediate)
- **Memory**: HistoryCache and ToolSchemaCache should not grow unbounded — verify cleanup on loop exit
- **Throughput**: Measure DB writes per loop iteration — target ≥50% reduction for tool-heavy sessions
