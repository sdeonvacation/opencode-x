# HLD: Agent Loop Performance (claude-code parity)

Source plan: `plans/PLAN_agent-loop-perf.md`. Design layered on `HLD_reduce-llm-turns.md` style. Prime constraint: every change must survive rebase onto `github.com/anomalyco/opencode:dev`. Prefer fork-local additive files; surgical hooks only in upstream-owned files.

## 1. Goals

Restate the 10 fixes from PLAN, grouped by phase. Quantitative targets from PLAN: **≥30% wall-clock per turn**, **≥50% SQLite tx per turn** on a 50-event tool-heavy fixture. No correctness regression.

| Phase | Fix #           | Goal                                                                                                                                                                                                                                                                | Quantitative target                                                       |
| ----- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 0     | (upstream wins) | Cherry-pick 5 upstream commits (`fb9d69ef62`, `ff55a40749`, `2d0d3d596e`, `ca28dd02ec`, `94564f3588`, `942630eb4a`, `9b369ee815`) — shrink `llm.ts`, fix mergeDeep type-instantiation hot path, serialize-tail compaction, double-compaction fix, prompt-cache auto | typecheck wall-clock −20%; redundant compaction calls = 0                 |
| 1     | 1               | `updatePart` coalescer batches DB writes during stream                                                                                                                                                                                                              | SQLite tx per turn ≥50% drop                                              |
| 1     | 2               | Doom-loop ring buffer replaces `MessageV2.parts()` SELECT per tool-call                                                                                                                                                                                             | SELECT count = 0 inside tool loop                                         |
| 1     | 3               | History cache rebuilds messages incrementally per turn                                                                                                                                                                                                              | wall-clock per turn ≥15% drop                                             |
| 1     | 4               | Tool schema/definition cache                                                                                                                                                                                                                                        | per-turn `init()` calls ≈ 0 after warmup                                  |
| 1     | 5               | Server-side SSE event filter                                                                                                                                                                                                                                        | bytes-on-wire and TUI render cost drop                                    |
| 2     | 6               | Input-aware parallel-safety incl. read-only bash whitelist                                                                                                                                                                                                          | parallel tool-call ratio ↑                                                |
| 3     | 7               | Mid-stream tool dispatch on `tool-input-end`                                                                                                                                                                                                                        | time-to-first-tool-result drop                                            |
| 4     | 8               | Skip snapshot when no FS-mutating tool ran in step                                                                                                                                                                                                                  | snapshot calls = 0 on pure-read turns                                     |
| 5     | 9               | Reactive (413-driven) compaction layered on serialize-tail                                                                                                                                                                                                          | proactive trigger threshold relaxed to 0.95; 413 retry succeeds same turn |
| 6     | 10              | Plugin-empty + provider-transform fast paths                                                                                                                                                                                                                        | `plugin.trigger` no-op cost ≈ 0; `toolCaching` rebuild on cache hit ≈ 0   |

Aggregate targets carry from PLAN §Testing Strategy.

## 2. Non-Goals

- No TUI render perf work (separate effort).
- No provider HTTP-level changes (no proxying, no batching of provider requests).
- No session storage migration (Drizzle schema unchanged except for additive columns covered by Phase 1 buddy commits).
- No removal of Effect-ts; all new fork-local code uses `Effect.fn` or plain async where buddy already does so.
- No new public API surface (CLI flags, SDK methods, server routes) beyond what PLAN specifies.
- No changes to AI SDK (we treat `streamText` lifecycle hooks as a fixed contract; if Phase 3 needs more, gated experimental flag stays off).
- No changes to existing plugin protocol (Phase 6 adds an internal `hasListeners` cheap check only).
- No removal of upstream's serialize-tail compaction (Phase 5 layers on top, never replaces).
- No removal of buddy's existing snapshot fork (Phase 4 composes with `06830327e7`).

## 3. Upstream-Rebase Strategy (CORE)

### 3.1 Classification rules

- **UPSTREAM-OWNED**: Dax/Kit churn weekly. Examples: `session/processor.ts`, `session/llm.ts`, `session/index.ts`, `provider/transform.ts`, `provider/index.ts`, `tool/registry.ts`, `tool/tool.ts`, `tool/bash.ts`, `tool/read.ts`, `plugin/index.ts`, `session/sliding-window.ts`, `session/compaction.ts`, `session/message-v2.ts`.
- **FORK-OWNED**: We authored or heavily diverged. Examples: `session/run-state.ts`, `sync/index.ts` (heavy buddy diff), hybrid-routing in `processor.ts:230-302`, sliding-window v2 in `processor.ts:480-690`.
- **NEW (additive)**: Fork-local files that don't exist upstream. Phase 1 buddy: `session/part-coalescer.ts`, `session/doom-loop.ts`, `session/history-cache.ts`. Phase 3: `session/streaming-dispatcher.ts`. Phase 4: `session/snapshot-gate.ts`. Phase 6: `provider/transform-cache.ts`, `plugin/listener-index.ts`.

### 3.2 Rebase-safety rules per touch

For every UPSTREAM-OWNED file, our diff MUST follow:

1. **Single named seam**: insert exactly one call into a fork-local helper module. No inline logic in upstream file.
2. **Helper signature uses upstream input shape unchanged**: helper takes the values upstream already has on the line, returns a value upstream already needs. If upstream renames a local, our helper still works.
3. **Helper is no-op when feature flag off**: identity transform / `Promise.resolve()` / `false`. Rebase conflicts that mistakenly drop the seam therefore degrade gracefully.
4. **Diff anchors are stable tokens**: prefer anchoring on AI SDK event names (`"tool-input-end"`, `"start-step"`, `"finish-step"`) or upstream function names — not line numbers, not local variable spellings.
5. **One conflict per file is the budget**: ≤10 lines net diff per upstream-owned file per phase.

### 3.3 Per-file inventory

| File                        | Class    | Phases            | Net lines (target) | Seam strategy                                                                                                                                                                                                                                                     |
| --------------------------- | -------- | ----------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session/processor.ts`      | UPSTREAM | 1, 3, 4, 5        | ≤30 cumulative     | Single import block of fork-local helpers; each phase adds ≤8-line additive call site, anchored on event-name `case` labels. All logic in helpers.                                                                                                                |
| `session/llm.ts`            | UPSTREAM | 0 (pick), 2, 3, 5 | ≤20 cumulative     | Phase 0 reduces baseline (upstream extracted to `llm/request.ts`). Phase 2 wires `parallelToolCallOptions` arg via fork helper that reads `ToolMeta`. Phase 3 wires fork-local dispatcher subscription as `onChunk` proxy. Phase 5 adds 413 catch in retry block. |
| `session/index.ts`          | UPSTREAM | 1                 | ≤12                | `updatePart` and `updatePartDelta` route through `PartCoalescer.enqueue(...)` — single line replacement at function entry; coalescer falls through to original SQL on flush.                                                                                      |
| `session/sliding-window.ts` | UPSTREAM | 5                 | ≤6                 | Threshold constant read from `cfg.compaction?.sliding_window?.proactive_ratio ?? 0.95` (was hard-coded 0.85). Pure config-driven change.                                                                                                                          |
| `session/compaction.ts`     | UPSTREAM | 5                 | ≤4                 | Add `Effect.fork`-spawnable variant via re-export wrapper; original sync entry preserved.                                                                                                                                                                         |
| `session/message-v2.ts`     | UPSTREAM | 1                 | ≤6                 | Add cached `parts()` accessor that consults `HistoryCache` first. Default path unchanged.                                                                                                                                                                         |
| `session/run-state.ts`      | FORK     | 4                 | ≤6                 | Add `fsToolFired: boolean` and `lastSnapshotAt: number` fields. Fork-owned; rebase-safe.                                                                                                                                                                          |
| `tool/registry.ts`          | UPSTREAM | 1                 | ≤8                 | Wrap registry init in cache (already in buddy commit). One named export of `RegistryCache` from a fork-local module; `registry.ts` reads via single `if (cached) return cached`.                                                                                  |
| `tool/tool.ts`              | UPSTREAM | 2                 | ≤8                 | Extend `Info` interface optionally with `parallelSafe(input): boolean`. Default falls back to existing static `parallelSafe?: boolean`.                                                                                                                           |
| `tool/bash.ts`              | UPSTREAM | 2                 | ≤4                 | Add fork-local predicate `BashSafety.isReadOnly(cmd)`; bash uses single import + one-line call. Whitelist lives in fork-local file.                                                                                                                               |
| `tool/read.ts`              | UPSTREAM | 2                 | ≤2                 | Already `parallelSafe: true` (line 240). Phase 2 only confirms gating in `llm.ts`; no edit unless Phase 3 of `PLAN_parallel-tool-calls.md` requires LSP guard.                                                                                                    |
| `plugin/index.ts`           | UPSTREAM | 6                 | ≤6                 | Add `hasListeners(name)` method on the Effect service, sourced from a single counter map. No change to `trigger`.                                                                                                                                                 |
| `provider/transform.ts`     | UPSTREAM | 6                 | ≤8                 | `toolCaching` and `message` middleware bodies wrapped by `TransformCache.memo(...)` from fork-local file; single one-liner per function.                                                                                                                          |
| `provider/index.ts`         | UPSTREAM | 6                 | ≤4                 | Cache tool-list hash invalidation hook (call into `TransformCache.invalidate(modelID)` on mutation).                                                                                                                                                              |
| `server/routes/event.ts`    | UPSTREAM | 1                 | ≤8                 | Buddy commit already does this. We re-cherry-pick; reconcile only.                                                                                                                                                                                                |
| `util/queue.ts`             | FORK     | 1                 | n/a                | Buddy extension; reconcile against any upstream churn.                                                                                                                                                                                                            |
| `sync/index.ts`             | FORK     | 1                 | n/a                | Coalescer integrates into existing fork-owned tx path.                                                                                                                                                                                                            |

### 3.4 Per-phase diff budget claim

- **Phase 0**: 0 new files (all upstream cherry-picks). Modifies M=4 upstream files via picks themselves; conflicts only.
- **Phase 1**: Adds 4 new files (`part-coalescer.ts`, `doom-loop.ts`, `history-cache.ts`, plus buddy's `util/queue.ts` extension is fork-owned). Modifies M=6 upstream-owned files (`processor.ts`, `index.ts`, `message-v2.ts`, `registry.ts`, `event.ts`, `llm.ts`) with **≤K=12 lines net diff per file**.
- **Phase 2**: 1 new file (`tool/bash-safety.ts`). Modifies M=4 upstream files (`tool.ts`, `bash.ts`, `read.ts`, `llm.ts`) with **≤K=6 lines per file**.
- **Phase 3**: 1 new file (`session/streaming-dispatcher.ts`). Modifies M=2 upstream files (`processor.ts`, `llm.ts`) with **≤K=8 lines per file**. 1 config schema addition.
- **Phase 4**: 1 new file (`session/snapshot-gate.ts`). Modifies M=2 files (`processor.ts` upstream, `run-state.ts` fork) with **≤K=8 lines per file**.
- **Phase 5**: 0 new files. Modifies M=4 upstream files (`llm.ts`, `sliding-window.ts`, `compaction.ts`, `processor.ts`) with **≤K=6 lines per file**.
- **Phase 6**: 2 new files (`provider/transform-cache.ts`, `plugin/listener-index.ts`). Modifies M=3 upstream files (`plugin/index.ts`, `provider/transform.ts`, `provider/index.ts`) with **≤K=6 lines per file**.

### 3.5 Rebase-safety verification per phase

After every upstream rebase:

1. `bun --cwd packages/opencode typecheck` clean.
2. `bun --cwd packages/opencode test test/session/part-coalescer.test.ts test/session/streaming-dispatcher.test.ts test/session/snapshot-gate.test.ts test/tool/bash-safety.test.ts` clean.
3. Per-phase rebase contract test: each helper module exposes one default-behavior identity test (feature flag off → unchanged behavior).
4. `git diff upstream/dev -- packages/opencode/src/session/processor.ts | wc -l` ≤ 60.
5. `git diff upstream/dev -- packages/opencode/src/session/llm.ts | wc -l` ≤ 40.

## 4. Architecture per phase

### 4.1 Phase 0 — Upstream cherry-picks

Components: none new (just upstream commits applied in order).

Pick order (PLAN §Phase 0):

1. `fb9d69ef62` — extracts `session/llm/request.ts`. Apply first to reduce surface for later picks.
2. `ff55a40749` — wraps `mergeDeep` in `llm.ts` + `config.ts`. Fixes type-instantiation hot path.
3. `2d0d3d596e` — serialize compaction tail.
4. `ca28dd02ec` — restore tail turns after summarization.
5. `94564f3588` — prevent double auto-compaction from `filterCompacted` reorder.
6. `942630eb4a` — cache-policy auto-placement.
7. `9b369ee815` — default `cache: 'auto'`.

Conflict notes:

- `llm.ts` extraction (`fb9d69ef62`) conflicts with our hybrid-routing v4 (`llm.ts:240-380` workflow approval, repair, header injection). Resolution: extract our workflow approval block into `session/llm/workflow-approval.ts` mirroring upstream's `llm/request.ts` pattern; call from new `llm.ts` post-pick.
- Compaction picks (`2d0d3d596e`, `ca28dd02ec`) conflict with sliding-window v2 (`sliding-window.ts:54-160`). Resolution: keep our `cache_sliding_window` LRU code; merge upstream's `serialize`/`restore` calls at the post-summary commit point.
- Cache-policy picks intersect provider transform — verify our `parallelToolCallOptions` (`transform.ts:1108-1121`) preserved.

Configuration: none.

Testing: existing test suite + `bun typecheck`. After each pick: `bun --cwd packages/opencode typecheck && bun --cwd packages/opencode test --timeout 30000`.

Rebase safety check: pure cherry-picks; future upstream rebase yields identity diffs once these commits are present in our history.

### 4.2 Phase 1 — Buddy perf foundation (fixes 1–5)

#### Components

| Component        | File                                 | Class        | Responsibility                                                                                                               |
| ---------------- | ------------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `PartCoalescer`  | `session/part-coalescer.ts`          | NEW          | Buffer `updatePart`/`updatePartDelta` writes; flush on time window or terminal-state event                                   |
| `DoomLoop`       | `session/doom-loop.ts`               | NEW          | In-memory ring buffer of recent tool-call signatures; detect repeated patterns without re-running `MessageV2.parts()` SELECT |
| `HistoryCache`   | `session/history-cache.ts`           | NEW          | Per-session message-array cache; incremental append, invalidate on compaction                                                |
| `RegistryCache`  | inline in `tool/registry.ts` (buddy) | UPSTREAM-mod | Cache `Tool.init()` results keyed by agent + tool list version                                                               |
| `EventFilter`    | `server/routes/event.ts` (buddy)     | UPSTREAM-mod | SSE per-client event-type filter                                                                                             |
| Queue extensions | `util/queue.ts`                      | FORK         | Used by `PartCoalescer` for batched flush                                                                                    |

#### Data flow

Stream-event hot path (after Phase 1):

```
streamText fullStream
  │
  ├── delta/text/tool-input-* events
  │      └─> processor.ts:case  ──> session.updatePart(part)
  │                                      │
  │                                      ▼
  │                             PartCoalescer.enqueue(part)
  │                                      │
  │                            ┌─────────┴─────────┐
  │                            │ terminal-state?    │
  │                            │  (final text,      │
  │                            │   tool-result,     │
  │                            │   finish-step,     │
  │                            │   compressed-out)  │
  │                            └────┬───────┬───────┘
  │                                 │ yes   │ no
  │                                 ▼       ▼
  │                         flush()      window timer (e.g. 16ms)
  │                              │           │
  │                              └─────┬─────┘
  │                                    ▼
  │                          sync/index.ts batch tx
  │                                    ▼
  │                              SQLite write
  │
  └── tool-input-end / tool-result events
         └─> DoomLoop.observe(signature)
                  │
                  ▼  (no SELECT)
            in-memory ring; threshold ≥3 identical → flag
```

Doom-loop ring updates from the in-memory buffer **before** coalesced flush (it must not depend on persisted state). Coalescer flush and ring observe are independent sequences.

History-cache flow:

```
Session.messages(sessionID)
  │
  ▼
HistoryCache.get(sessionID)
  │
  ├── miss → MessageV2.list() → cache full array → return
  └── hit  → return cached array
        ▲
        │ on Session.updateMessage / SlidingWindow.invalidate
        └── HistoryCache.append / HistoryCache.drop
```

#### Interfaces

```ts
// session/part-coalescer.ts
export namespace PartCoalescer {
  export interface Options {
    windowMs: number // default 16
    maxBatch: number // default 64
    terminal: (p: MessageV2.Part) => boolean
  }
  export interface Handle {
    enqueue(p: MessageV2.Part): Effect.Effect<MessageV2.Part>
    flush(reason: "terminal" | "window" | "dispose"): Effect.Effect<void>
    dispose(): Effect.Effect<void>
  }
  export const open: (sessionID: SessionID, opts?: Partial<Options>) => Effect.Effect<Handle>
}
```

```ts
// session/doom-loop.ts
export namespace DoomLoop {
  export interface Signature {
    tool: string
    argHash: string
  }
  export interface Detector {
    observe(sig: Signature): "ok" | "loop"
    reset(): void
  }
  export const open: (opts?: { window?: number; threshold?: number }) => Detector
}
```

```ts
// session/history-cache.ts
export namespace HistoryCache {
  export interface Entry {
    msgs: MessageV2.WithParts[]
    version: number
  }
  export const get: (sessionID: SessionID) => Effect.Effect<MessageV2.WithParts[]>
  export const append: (sessionID: SessionID, m: MessageV2.WithParts) => void
  export const invalidate: (sessionID: SessionID) => void
  export const onCompactionInvalidate: (sessionID: SessionID) => void // wired from sliding-window
}
```

#### Integration seams in upstream code

- `session/index.ts` `updatePart` body (≈3 lines): replace direct `SyncEvent.run` call with `PartCoalescer.enqueue`. Coalescer eventually calls original write inside its flush (the original code path is preserved; coalescer is a transparent enqueue+drain layer).
- `session/index.ts` `updatePartDelta` body (≈3 lines): same.
- `session/processor.ts` once at handler entry: `const coalescer = yield* PartCoalescer.open(ctx.sessionID)`. Once at handler exit (`finally`): `yield* coalescer.dispose()`.
- `session/processor.ts` after `tool-result` (≈1 line): `DoomLoop.observe({tool, argHash})`.
- `session/message-v2.ts` `parts()` accessor (≈3 lines): consult `HistoryCache` first.
- `tool/registry.ts` cache: per buddy commit; one-line cache check in registry init.
- `server/routes/event.ts`: per buddy commit; SSE filter param.

#### Configuration

```ts
// config/schema.ts
experimental?: {
  part_coalescer?: boolean              // default true
  history_cache?: boolean               // default true
  doom_loop?: boolean                   // default true
  registry_cache?: boolean              // default true
  event_filter?: boolean                // default true
  coalesce_window_ms?: number           // default 16
}
```

Kill-switch: any flag = false → helper short-circuits to identity behavior (direct write, fresh SELECT, etc).

#### Testing

- Unit: `part-coalescer.test.ts` (window, terminal-flush, dispose-flush, max-batch, terminal predicate); `doom-loop.test.ts` (ring rotation, threshold, reset on different tool); `history-cache.test.ts` (miss, append, invalidate); `registry-cache.test.ts` (key by agent + tool list hash); `event-filter.test.ts` (per-client filter — backport from buddy).
- Integration: full session run with all flags on; assert SQLite tx count ≥50% lower than baseline (bench harness).
- Bench harness: `packages/opencode/script/bench-loop.ts` measures DB tx + wall-clock per turn on a 50-event tool-heavy fixture.

#### Rebase safety check

- Verify `session/index.ts` `updatePart` still has exactly one named seam call; rebase-conflicts mark the seam — restore by re-inserting the single line.
- `session/message-v2.ts` `parts()` cache lookup does not duplicate parsing logic.
- `tool/registry.ts` cache survives upstream registry refactors because it keys on `(agentID, hash(tool ids))` — upstream's tool-list shape is the natural key.

### 4.3 Phase 2 — Input-aware parallel-safety (fix 6)

#### Components

| Component                  | File                  | Class        | Responsibility                                                                                                     |
| -------------------------- | --------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `BashSafety`               | `tool/bash-safety.ts` | NEW          | Read-only command whitelist matcher                                                                                |
| `Tool.parallelSafe(input)` | `tool/tool.ts`        | UPSTREAM-mod | Optional input-aware predicate on tool def                                                                         |
| Bash predicate             | `tool/bash.ts`        | UPSTREAM-mod | Single import + one-line call                                                                                      |
| Read predicate             | `tool/read.ts`        | UPSTREAM-mod | Stays `parallelSafe: true`                                                                                         |
| LLM gate                   | `session/llm.ts`      | UPSTREAM-mod | Compute static-vs-dynamic safety; pass `providerOptions.parallelToolCalls` only when ALL pending tools static-safe |

#### Interfaces

```ts
// tool/tool.ts (extended)
export namespace Tool {
  export interface Def<P extends z.ZodType, M extends Metadata> {
    // existing fields...
    parallelSafe?: boolean | ((input: z.infer<P>) => boolean)
  }
  export interface Info<P extends z.ZodType, M extends Metadata> {
    id: string
    parallelSafe?: boolean | ((input: any) => boolean)
    init: (ctx?: InitContext) => Promise<DefWithoutID<P, M>>
  }
}
```

```ts
// tool/bash-safety.ts
export namespace BashSafety {
  export const WHITELIST_PREFIXES: readonly string[] = [
    "ls",
    "cat",
    "grep",
    "find",
    "git status",
    "git log",
    "git diff",
    "pwd",
    "wc",
  ]
  export function isReadOnly(cmd: string): boolean
}
```

```ts
// tool/bash.ts (one-line addition)
parallelSafe: (input) => BashSafety.isReadOnly(input.command),
```

#### Integration seams

- `tool/tool.ts` `Info` interface: union the existing static `parallelSafe?: boolean` with `((input) => boolean)`; resolution helper `Tool.evalParallelSafe(info, input)` lives in `tool/tool.ts` (or `tool/parallel-safe.ts` if we want zero churn — preferred).
- `session/llm.ts`: at the parallel-tool decision point (currently calls `ProviderTransform.parallelToolCallOptions`), compute `staticSafe = allTools.every(t => t.parallelSafe === true)`. If true, set `providerOptions.parallelToolCalls = true`. Dynamic predicates evaluated at dispatch time (Phase 3 dispatcher) — not at request time, since input not yet known.
- `tool/bash.ts`: one new line inside `Tool.define("bash", ...)`.

#### Configuration

```ts
experimental?: {
  parallel_read?: boolean              // default true (PLAN says lift after audit)
  parallel_bash_readonly?: boolean     // default true
}
```

#### Testing

- Unit `bash-safety.test.ts`: whitelist hits + misses (`ls -la`, `cat foo`, `npm test`, `git push`, command chains `ls && rm`).
- Unit `tool.test.ts`: `parallelSafe` static + dynamic resolution.
- Integration: mixed-safety batch — `read + bash ls` → parallel; `read + bash npm test` → serial.

#### Rebase safety check

- `tool/tool.ts` change is purely additive on `Info`/`Def` interface; upstream additions to other fields do not collide.
- `tool/bash.ts` one-line addition anchored on the call to `Tool.define("bash", { ... })`.

### 4.4 Phase 3 — Mid-stream tool dispatch (fix 7)

#### Components

| Component             | File                              | Class        | Responsibility                                                                                                              |
| --------------------- | --------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `StreamingDispatcher` | `session/streaming-dispatcher.ts` | NEW          | Subscribe to `tool-input-end`; spawn `tool.execute()` on a fiber when input-aware safe; cache result by `toolCallId`        |
| Subscription seam     | `session/processor.ts`            | UPSTREAM-mod | Inject dispatcher into stream-event loop                                                                                    |
| AI SDK hook seam      | `session/llm.ts`                  | UPSTREAM-mod | Wire `onChunk`/`prepareStep` if AI SDK exposes; otherwise dispatcher reads `fullStream` chunks already routed via processor |

#### Data flow

```
streamText.fullStream
       │
       ▼
processor.ts: stream loop
       │
       ├── case "tool-input-end" ─► StreamingDispatcher.observe(call)
       │                                    │
       │                          parallelSafe(input) ?
       │                                    │
       │                            ┌───────┴───────┐
       │                            │ yes           │ no
       │                            ▼               ▼
       │                      Effect.fork        skip
       │                       tool.execute
       │                       store in
       │                       pendingResults[id]
       │
       └── case "tool-result"   ─► StreamingDispatcher.consume(id)
                                          │
                                  ┌───────┴───────┐
                                  │ have result?   │
                                  └───┬───────┬───┘
                                      │ yes   │ no
                                      ▼       ▼
                              return cached   await SDK exec
```

Idempotency guard: `pendingResults` is a `Map<toolCallId, Promise<Result>>`. If AI SDK fires its own execute concurrently, we still resolve the same promise — the first to complete wins; the second `consume` returns the cached result. AI SDK's own `tool-result` event therefore must be intercepted in our processor case before re-dispatch — done in the `case "tool-result"` branch. If AI SDK already executed the tool itself (no fork-eligible path), the dispatcher passes through untouched.

#### Interfaces

```ts
// session/streaming-dispatcher.ts
export namespace StreamingDispatcher {
  export interface Call {
    toolCallId: string
    toolName: string
    input: unknown
  }
  export interface Result {
    toolCallId: string
    output: string
    metadata: any
  }
  export interface Handle {
    observe(call: Call, ctx: Tool.Context): Effect.Effect<void>
    consume(toolCallId: string): Effect.Effect<Result | undefined>
    dispose(): Effect.Effect<void>
  }
  export const open: (tools: Record<string, Tool.Def>, enabled: boolean) => Effect.Effect<Handle>
}
```

#### Integration seams

- `session/processor.ts`: at handler entry (after coalescer), `const dispatcher = yield* StreamingDispatcher.open(tools, cfg.experimental?.midstream_tool_dispatch ?? false)`. On `tool-input-end`: `yield* dispatcher.observe(...)`. On `tool-result`: `const cached = yield* dispatcher.consume(toolCallId); if (cached) value = mergeWithCached(value, cached)`.
- `session/llm.ts`: no edit unless AI SDK hook needed. PLAN §Step 4 says "fall back to no-op" if hook not exposed — so the processor-side observe is sufficient for v1.

#### Configuration

```ts
experimental?: {
  midstream_tool_dispatch?: boolean    // default false (PLAN §Phase 3 Step 3)
}
```

#### Testing

- Unit `streaming-dispatcher.test.ts`: mock stream emits 3 `tool-input-end` events 100ms apart; assert all 3 fork concurrently; consume returns each. Also: input-unsafe call → no fork.
- Integration: real provider; measure time-to-first-result.
- Idempotency: two consumes for same id → both return same value.

#### Rebase safety check

- Only the two `case` branches in `processor.ts` are touched. Upstream churn around streamText handling is unlikely to reshape the case names — we anchor on `"tool-input-end"` and `"tool-result"` strings.
- Helper isolated; flag default false → upstream rebase that drops the seam degrades gracefully (feature off).

### 4.5 Phase 4 — Skip snapshot when no FS tool (fix 8)

#### Components

| Component              | File                       | Class        | Responsibility                                                                     |
| ---------------------- | -------------------------- | ------------ | ---------------------------------------------------------------------------------- |
| `SnapshotGate`         | `session/snapshot-gate.ts` | NEW          | Decide whether `snapshot.track()` / `snapshot.patch()` should run for current step |
| `ctx.fsToolFired`      | `session/run-state.ts`     | FORK         | Per-step flag                                                                      |
| Seam in `processor.ts` | `session/processor.ts`     | UPSTREAM-mod | Replace direct `snapshot.track/patch` with `SnapshotGate.track/patch`              |

#### Interfaces

```ts
// session/snapshot-gate.ts
export namespace SnapshotGate {
  export const FS_TOOLS = new Set(["edit", "write", "bash", "patch", "multiedit"])

  export const onToolCall: (ctx: RunState, toolName: string) => void
  export const track: (ctx: RunState, snapshot: Snapshot.Service) => Effect.Effect<string | undefined>
  export const patch: (
    ctx: RunState,
    snapshot: Snapshot.Service,
  ) => Effect.Effect<{ files: string[]; hash: string } | undefined>
}
```

#### Integration seams

- `processor.ts:480` (`case "start-step"`):
  Before: `if (!ctx.snapshot) ctx.snapshot = yield* snapshot.track()`
  After: `if (!ctx.snapshot) ctx.snapshot = yield* SnapshotGate.track(ctx, snapshot)`
- `processor.ts:502` (`case "finish-step"` snapshot:track call): identical replacement.
- `processor.ts:511` (snapshot.patch): `const patch = yield* SnapshotGate.patch(ctx, snapshot)`. If `undefined` (no fs tool fired), skip the inner `updatePart`.
- `processor.ts:596` (the second patch site, sliding-window v2 fork): same replacement.
- Tool-call observation: in `case "tool-input-end"` (already exists), call `SnapshotGate.onToolCall(ctx, toolName)`.

`run-state.ts`:

```ts
export interface RunState {
  // existing fields...
  fsToolFired: boolean
  lastSnapshotAt?: string // snapshot hash of last successful track
}
```

#### Configuration

```ts
experimental?: {
  skip_snapshot_no_fs?: boolean        // default true
}
```

Kill-switch: false → `SnapshotGate` always returns full track/patch.

#### Testing

- Unit: pure-read step (3 grep + 1 read) → 0 `track()` calls, 0 `patch()` calls.
- Unit: mixed step (read + edit) → exactly 1 track + 1 patch.
- Integration: full session with mixed steps; assert correct patch parts emitted only when files changed.
- Composition with buddy `06830327e7` (parallel-toolcall snapshot fork): verify gate applies before fork-merge; if `fsToolFired` true on any parallel branch, gate fires once.

#### Rebase safety check

- `processor.ts` seams anchored on snapshot function calls (`snapshot.track`, `snapshot.patch`) — stable upstream identifiers.
- `run-state.ts` is fork-owned; field additions safe.

### 4.6 Phase 5 — Reactive compaction (fix 9)

#### Components

| Component          | File                        | Class        | Responsibility                                                             |
| ------------------ | --------------------------- | ------------ | -------------------------------------------------------------------------- |
| 413 catch          | `session/llm.ts`            | UPSTREAM-mod | Detect overflow error in retry path; trigger compaction inline; retry once |
| Threshold relax    | `session/sliding-window.ts` | UPSTREAM-mod | Proactive ratio config from 0.85 → 0.95                                    |
| Async fork variant | `session/compaction.ts`     | UPSTREAM-mod | `compactAsync` re-export wrapping `Effect.fork`                            |
| Fork point         | `session/processor.ts`      | UPSTREAM-mod | Spawn compaction before next API turn when proactive                       |

#### Data flow

```
streamText turn
   │
   ├── proactive check (sliding-window)
   │        if tokens > limit * 0.95
   │              │
   │              ├── cached summary present? → use it (fast)
   │              └── miss → Effect.fork compaction
   │                          ├── next turn dispatches with stale-but-bounded history
   │                          └── on completion: HistoryCache.invalidate
   │
   ├── streamText fires
   │
   ├── error: 413 / overflow
   │     │
   │     ▼
   │  catch branch
   │     ├── trigger SlidingWindow.compact (sync, await summary)
   │     ├── retry same turn with compacted history
   │     └── (use upstream's tail-restore so tail turns survive)
   │
   └── ok → done
```

Trigger precedence: proactive (0.95) is the primary defense. Reactive (413) is a fallback that catches cases where pre-stream estimate underflows (multimodal, tool output growth). When both fire on the same turn, reactive wins (it already executed).

#### Interfaces

```ts
// session/compaction.ts (additive)
export const compactAsync: (
  input: SlidingWindow.CompactInput,
) => Effect.Effect<Fiber.RuntimeFiber<MessageV2.WithParts[]>>

// session/llm.ts (additive helper, fork-local file preferred)
// session/llm/reactive-compact.ts
export namespace ReactiveCompact {
  export const isOverflow: (err: unknown) => boolean // 413 + provider-specific signatures
  export const handle: (
    err: unknown,
    input: StreamInput,
  ) => Effect.Effect<{ messages: MessageV2.WithParts[]; retry: true } | { retry: false }>
}
```

#### Integration seams

- `session/llm.ts`: at the catch site near `streamText` (around the existing `onError` callback), one new line: `if (ReactiveCompact.isOverflow(err)) return yield* ReactiveCompact.handle(err, input)`. Helper lives in `session/llm/reactive-compact.ts` (fork-local, mirrors upstream's `llm/request.ts` pattern post Phase 0).
- `session/sliding-window.ts:73`: replace hard-coded 0.85 with `opts?.proactive_ratio ?? 0.95`.
- `session/compaction.ts`: add `compactAsync` re-export. Original `compact` unchanged.
- `session/processor.ts`: at start of each turn, if proactive condition met but no cached summary, spawn `Effect.fork(compactAsync(...))`; result feeds `HistoryCache.invalidate` on completion. One ≤6-line block.

#### Configuration

```ts
compaction?: {
  sliding_window?: {
    proactive_ratio?: number   // default 0.95
    reactive_enabled?: boolean // default true
  }
}
experimental?: {
  reactive_compaction?: boolean   // default true
  async_compaction?: boolean      // default false initially (Step 3 fork point)
}
```

#### Testing

- Unit: simulate 413 error → `ReactiveCompact.handle` returns retry plan with compacted messages; verify upstream tail-restore preserves tail turns.
- Unit: proactive trigger at 0.95 fires; below 0.95 no fire.
- Integration: realistic workload — assert proactive-vs-reactive ratio (proactive should dominate).
- Composition with serialize-tail: after compaction, tail of N most recent turns is intact and reattached.

#### Rebase safety check

- `sliding-window.ts` change is single-line constant → config; upstream churn that renames the constant breaks at compile time, easy to spot.
- `llm.ts` 413 catch piggybacks on existing `onError` or retry block; helper module isolates the matcher.
- Composition with PLAN_sliding_window_compaction.md: this Phase strictly extends; no overlap with the prior plan's components.

### 4.7 Phase 6 — Plugin/transform fast paths (fix 10)

#### Components

| Component               | File                          | Class        | Responsibility                                                  |
| ----------------------- | ----------------------------- | ------------ | --------------------------------------------------------------- |
| `Plugin.hasListeners`   | `plugin/index.ts`             | UPSTREAM-mod | O(1) check before iteration                                     |
| `ListenerIndex`         | `plugin/listener-index.ts`    | NEW          | Per-event-name counter map                                      |
| `TransformCache`        | `provider/transform-cache.ts` | NEW          | Memoize `toolCaching` and `message` middleware                  |
| `transform.ts` wrappers | `provider/transform.ts`       | UPSTREAM-mod | One-line `TransformCache.memo(...)`                             |
| Invalidation hook       | `provider/index.ts`           | UPSTREAM-mod | Call `TransformCache.invalidate(modelID)` on tool-list mutation |

#### Interfaces

```ts
// plugin/index.ts (extension)
export namespace Plugin {
  // existing service shape...
  hasListeners(name: TriggerName): boolean
}

// plugin/listener-index.ts
export namespace ListenerIndex {
  export const build: (hooks: Hooks[]) => Map<string, number>
  export const has: (idx: Map<string, number>, name: string) => boolean
}
```

```ts
// provider/transform-cache.ts
export namespace TransformCache {
  export interface Key {
    modelID: string
    toolHash: string
    sessionID: string
  }
  export const memo: <T>(key: Key, fn: () => T) => T
  export const invalidate: (modelID: string) => void
}
```

#### Integration seams

- `plugin/index.ts:251` (`for (const hook of s.hooks)` inside `trigger`): wrap with `if (!ListenerIndex.has(s.index, name)) return output`. `s.index` precomputed at hook-load time (one-shot).
- `processor.ts:566-574` and other `plugin.trigger` sites: optional cheap pre-check `if (!Plugin.hasListeners(name)) skip`. Optional because `trigger` itself is now O(1) on miss; included for cases where building the trigger input is itself expensive.
- `provider/transform.ts` `toolCaching`: wrap body with `TransformCache.memo({modelID, toolHash, sessionID}, () => current body)`.
- `provider/transform.ts` `message` middleware: wrap system-prompt slice in same cache.
- `provider/index.ts` on tool-list mutation event: `TransformCache.invalidate(modelID)`.

#### Configuration

```ts
experimental?: {
  plugin_fast_path?: boolean         // default true
  transform_cache?: boolean          // default true
}
```

#### Testing

- Unit `listener-index.test.ts`: empty hooks → has() always false; mixed hooks → correct counts.
- Unit `transform-cache.test.ts`: hit, miss, invalidate.
- Bench: `wrapLanguageModel` overhead before/after on 20-turn session.

#### Rebase safety check

- `plugin/index.ts` extension is one new method on the service; upstream additions to `Service.of({...})` parallel additive paths.
- `provider/transform.ts` wrappers are body-level memo; upstream changes to body are transparently re-cached on key collision.

## 5. Cross-Phase Concerns

### 5.1 Coalescer ↔ hybrid-routing-v4 second `updatePart` → terminal-state flush

Hybrid-routing v4 emits a second `updatePart` for the compressed-output write at end of workflow turn. This must hit the DB **before** the next API turn dispatches. Rule: `PartCoalescer.terminal` predicate returns true for any part with `type === "step-finish"` OR with `metadata.terminal === true` (workflow compressed-output write sets this). Coalescer flushes synchronously on `enqueue` of a terminal part.

### 5.2 Coalescer ↔ doom-loop ring buffer

Doom-loop ring updates from the **in-memory tool-call buffer**, not from coalesced/persisted parts. Reason: ring must observe every tool call regardless of flush schedule. Rule: `processor.ts` `case "tool-result"` calls `DoomLoop.observe(...)` directly with the in-flight `value`; no DB read.

### 5.3 History-cache ↔ sliding-window v2

Sliding-window v2 mutates the compaction window. Rule: `SlidingWindow.compact` invokes `HistoryCache.onCompactionInvalidate(sessionID)` on successful summary. History cache drops the entry; next `Session.messages()` rebuilds from `MessageV2.list()` and includes the synthetic summary message.

### 5.4 Mid-stream dispatcher ↔ AI SDK `tool-result` event → idempotency

AI SDK may execute a tool itself when our dispatcher already forked it. Rule: dispatcher's `pendingResults` is keyed by `toolCallId`. Both consumers (dispatcher.consume, AI SDK's own `tool-result` branch) read from the same map. Map values are `Promise` — first resolve wins, second consumer awaits same promise. No double-execute. `processor.ts` `case "tool-result"` checks dispatcher first; if hit, replaces `value.output` with cached. If miss, AI SDK's value passes through.

### 5.5 Reactive compaction ↔ proactive sliding-window → trigger precedence

Both can fire on the same turn. Rule:

1. Proactive (0.95 ratio) checked at turn start; if cached summary present → instant; else fork compaction; turn dispatches without blocking.
2. If turn errors with 413 anyway, reactive catches; awaits compaction (or starts fresh if fork failed); retries turn once.
3. If reactive succeeds, mark turn flag `compacted_reactively: true` so proactive does not double-fire on retry.

### 5.6 Snapshot skip ↔ buddy `06830327e7` parallel-toolcall snapshot fork

`06830327e7` already forks snapshot per parallel branch. Rule: `SnapshotGate` is the single decision authority — buddy's fork code reads `ctx.fsToolFired` from the merged child contexts. If any child set `fsToolFired = true`, the parent gate fires once. No double-track / double-patch.

## 6. Configuration

All new config keys, types, defaults, kill-switches:

```ts
// config/schema.ts (additive)
{
  experimental?: {
    // Phase 1
    part_coalescer?: boolean              // default true
    history_cache?: boolean               // default true
    doom_loop?: boolean                   // default true
    registry_cache?: boolean              // default true
    event_filter?: boolean                // default true
    coalesce_window_ms?: number           // default 16

    // Phase 2
    parallel_read?: boolean               // default true (after audit)
    parallel_bash_readonly?: boolean      // default true

    // Phase 3
    midstream_tool_dispatch?: boolean     // default false (gated)

    // Phase 4
    skip_snapshot_no_fs?: boolean         // default true

    // Phase 5
    reactive_compaction?: boolean         // default true
    async_compaction?: boolean            // default false (gated)

    // Phase 6
    plugin_fast_path?: boolean            // default true
    transform_cache?: boolean             // default true
  },

  compaction?: {
    sliding_window?: {
      proactive_ratio?: number           // default 0.95 (was hard-coded 0.85)
      reactive_enabled?: boolean         // default true
    }
  }
}
```

Kill-switch contract: every flag false → corresponding helper short-circuits to identity behavior. No flag false leaves the system half-on.

## 7. Migration / Rollout

| Phase | Order                                           | Gate                                           | Fallback                            | Blast radius                              |
| ----- | ----------------------------------------------- | ---------------------------------------------- | ----------------------------------- | ----------------------------------------- |
| 0     | First                                           | none — pure pick                               | revert pick                         | upstream-shaped; conflicts only           |
| 1     | After 0                                         | each flag default true (proven by buddy)       | flag=false → identity               | all stream events touch coalescer; medium |
| 2     | After 1                                         | static-safe is default-true; dynamic safe flag | flag=false → no parallel            | parallel-tool path only                   |
| 3     | After 1, 2                                      | `midstream_tool_dispatch=false`                | flag=false → no-op                  | tool-call latency; medium                 |
| 4     | After 1                                         | `skip_snapshot_no_fs=true`                     | flag=false → full snapshot          | snapshot subsystem only                   |
| 5     | After 0 (needs picks `2d0d3d596e`/`ca28dd02ec`) | `reactive_compaction=true`; async fork off     | flag=false → proactive only at 0.85 | error path on overflow                    |
| 6     | Independent                                     | `plugin_fast_path`, `transform_cache` true     | flag=false → original               | plugin/transform overhead path            |

Rollout strategy:

1. Phase 0 first — purely smaller surface for everything else.
2. Phase 1 second — biggest perf payoff; flags default true.
3. Phase 4 + Phase 6 in parallel — orthogonal to 1; both default true.
4. Phase 2 third — needs Phase 3 of `PLAN_parallel-tool-calls.md` for read-only audit.
5. Phase 5 fourth — needs Phase 0 picks present.
6. Phase 3 last — gated, default off; enable after bench harness proves win.

## 8. Risks (with rebase-specific risks per upstream-touched file)

PLAN risk list inherited; sharper version:

| Risk                                                                     | Touch point                               | Likelihood | Mitigation                                                                                                                  |
| ------------------------------------------------------------------------ | ----------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| `processor.ts` rebase conflict with future upstream stream-loop refactor | `processor.ts` (UPSTREAM, 4 phases touch) | High       | Anchor seams on AI SDK event names not line numbers; cap diff at ≤30 net lines; rebase-test fixture                         |
| `llm.ts` request-build refactor by upstream after Phase 0                | `llm.ts` (UPSTREAM, 3 phases touch)       | Med        | Phase 0 picks `fb9d69ef62` first → smaller residual `llm.ts`; our hooks live in `llm/` subfolder mirroring upstream pattern |
| `provider/transform.ts` cache key drift after upstream tool-list reshape | `transform.ts`                            | Med        | Cache key derived from upstream `Tool.id` + `model.id` only — natural shape                                                 |
| `plugin/index.ts` `Service.of` shape change                              | `plugin/index.ts`                         | Low        | `hasListeners` added by single-line spread inside the existing `Service.of({...})` block; trivial to re-add                 |
| `tool/tool.ts` `Info`/`Def` interface drift                              | `tool/tool.ts`                            | Low        | Our addition is optional field; upstream additions don't intersect                                                          |
| Coalesced writes lose events on crash                                    | `part-coalescer.ts`                       | Med        | Flush on dispose (try/finally in processor); terminal-state immediate flush; `EventSequenceTable` recovery replay           |
| Doom-loop hash collisions cause false positives                          | `doom-loop.ts`                            | Low        | Canonical-JSON hash + threshold ≥3                                                                                          |
| History cache stale after compaction                                     | `history-cache.ts`                        | Med        | Explicit `onCompactionInvalidate` hook + full-rebuild fallback                                                              |
| Tool registry cache stale after MCP/plugin hot-reload                    | `tool/registry.ts`                        | Low        | Version-hash invalidation on registry mutation                                                                              |
| Mid-stream dispatch breaks AI SDK contract on version bump               | `streaming-dispatcher.ts`                 | High       | Default-off flag; only kick fiber on `tool-input-end`; auto-fallback if shape mismatch                                      |
| Reactive compaction adds latency on overflow turn                        | `llm.ts`                                  | Med        | Combined with proactive 0.95; rare; one-shot retry                                                                          |
| Skipped snapshot misses ambient FS changes                               | `snapshot-gate.ts`                        | Low        | Acceptable per PLAN; opencode does not currently track external edits between steps                                         |
| Bash whitelist false negatives                                           | `bash-safety.ts`                          | Med        | Conservative whitelist + per-tool `parallelSafe: true` escape                                                               |
| Plugin fast-path hides bugs in plugin loader                             | `plugin/index.ts`                         | Low        | `hasListeners` cheap and tested separately; `trigger` path still in test suite                                              |
| Buddy cherry-pick conflicts with hybrid-routing v4 second `updatePart`   | `processor.ts`                            | High       | Treat compressed-output write as terminal in coalescer; immediate flush                                                     |

## 9. Verification

Per-phase verification against PLAN's quantitative targets.

### 9.1 Bench harness

`packages/opencode/script/bench-loop.ts` (Phase 1 deliverable):

- Fixture: 50-event tool-heavy turn (mix of read/grep/edit).
- Metrics: SQLite tx count, wall-clock per turn, time-to-first-tool-result, parallel-tool-call ratio.
- Output: JSON to stdout; CI consumes diff.

### 9.2 Per-phase metric expectations

| Phase | Metric                                     | Baseline          | Target          |
| ----- | ------------------------------------------ | ----------------- | --------------- |
| 0     | typecheck wall-clock                       | upstream baseline | −20%            |
| 1     | SQLite tx per turn                         | N                 | ≤0.5 N          |
| 1     | wall-clock per turn                        | T                 | ≤0.85 T         |
| 1     | `MessageV2.parts()` SELECTs in tool loop   | K                 | 0               |
| 2     | parallel-tool ratio (read+ls)              | 0% (serial)       | 100% (parallel) |
| 3     | time-to-first-tool-result                  | F ms              | ≤0.7 F ms       |
| 4     | `snapshot.track()` calls on pure-read turn | 1                 | 0               |
| 5     | proactive vs reactive trigger ratio        | n/a               | proactive ≥80%  |
| 6     | `wrapLanguageModel` overhead per turn      | M ms              | ≤0.5 M ms       |
| All   | aggregate wall-clock per turn              | T                 | ≤0.7 T          |
| All   | aggregate SQLite tx per turn               | N                 | ≤0.5 N          |

### 9.3 Regression test inventory

Existing suites must continue green:

- `test/session/*.test.ts` — session lifecycle.
- `test/tool/*.test.ts` — tool contract.
- `test/server/event*.test.ts` — SSE.
- `test/sync/*.test.ts` — DB tx behavior.
- `test/provider/*.test.ts` — transform.

New tests added per phase (all from PLAN testing strategy + this HLD §4.x).

### 9.4 Post-rebase checklist

After every upstream rebase to `dev`:

1. Diff size per upstream-owned file ≤ budget (§3.4).
2. Helper module identity tests (flag=off → behavior unchanged) green.
3. Bench harness numbers within ±10% of last green run.

## 10. Future Work

Items deferred:

- **AI SDK fork for true mid-stream dispatch**: if Phase 3 hooks insufficient (AI SDK never exposes a `prepareStep` callback that returns prepared results), fork AI SDK to emit a `tool-input-ready-for-execute` event. Out of scope for this HLD; revisit after Phase 3 bench data.
- **Doom-loop rate-limit feedback to model**: currently observe + flag only. Future: inject system message after threshold hit, asking model to break out of loop.
- **History-cache cross-session sharing**: shared sub-history (e.g., system prompt prefix) across sessions. Out of scope.
- **Reactive compaction tail-only mode**: when 413 fires, try dropping oldest tool-result blocks before full compaction. Faster recovery; future optimization.
- **Plugin async listener registry**: dynamic plugin registration at runtime would invalidate `ListenerIndex.build` once per change. Currently we assume static-after-init. Revisit if MCP hot-reload becomes hot path.
- **Provider transform cache eviction**: current `TransformCache` has no LRU bound. Acceptable per session; cross-session memory growth needs eviction in long-lived servers.
- **Parallel bash with arg-pattern matchers**: extend whitelist to argument-pattern-aware (e.g., `git -C <dir> log` is read-only too). Phase 2 v2.
- **Snapshot batch across steps**: when N consecutive steps each fire one fs tool, single `track`+`patch` over all of them. Phase 4 v2.

## Plan Deltas (Appendix)

Findings that the PLAN does not yet capture:

- **Phase 3 idempotency**: PLAN §Step 2 says "buffer tool results … on `tool-result` event from AI SDK, return cached". Does not specify that AI SDK may run tool concurrently with our fork. HLD §5.4 fills the gap with a `Map<toolCallId, Promise<Result>>` rule.
- **Phase 1 terminal-state predicate**: PLAN risk list mentions "compressed-output write as terminal-state in coalescer (immediate flush)" but does not specify the predicate. HLD §5.1 makes it explicit (`type === "step-finish"` OR `metadata.terminal === true`).
- **Phase 5 retry-loop guard**: PLAN does not mention preventing double-compaction on the retry pass. HLD §5.5 introduces `compacted_reactively` flag.
- **Phase 0 conflict reconcile in `llm.ts:240-380`**: PLAN §Step 7 lists the file but not the exact extraction pattern. HLD §4.1 proposes mirroring upstream's `llm/request.ts` with our own `llm/workflow-approval.ts`.
- **Phase 4 composition with `06830327e7`**: PLAN risk #8 says "Skipped snapshot misses ambient FS changes (acceptable)" but does not address parallel-toolcall fork. HLD §5.6 specifies that `fsToolFired` merges from child branches.
- **Phase 6 `ListenerIndex` build timing**: PLAN does not specify when the index is built. HLD §4.7 sets it at hook-load (one-shot); future work item §10 flags MCP hot-reload as the v2 trigger.
- **Bench harness location**: PLAN §Phase 1 Step 7 specifies `script/bench-loop.ts`; HLD §9.1 confirms and adds metric set. No conflict.
