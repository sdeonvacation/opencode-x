# Plan: Agent Workflow Performance (P0+P1)

## Overview

Surgical performance optimizations targeting the 5 highest-impact bottlenecks in the agent prompt loop. P0 delivers 3 quick wins (throttled part writes, in-memory doom-loop detection, server-side event filtering). P1 delivers 2 structural caches (incremental history cache, tool schema cache). All changes are internal to `packages/opencode` with no API/schema changes.

## Tech Stack

TypeScript, Bun, Effect, Drizzle ORM, Hono (SSE routes)

## Testing Strategy

- Unit: each optimization in isolation (coalescer timing, ring buffer correctness, cache invalidation, event filter logic)
- Integration: full prompt-loop step with mocked tools verifying reduced DB call count / event count
- Done when: all existing tests pass + new perf-regression tests pass + no behavioral change in session output

## Phases

### Phase 1: Throttle/coalesce part metadata persistence (P0)

- Step 1: Add coalescing buffer in `Session.updatePart` that batches writes within 200–500ms window
- Step 2: Persist immediately on terminal states (completed/error) and on flush/dispose
- Step 3: Keep in-memory latest state for live UI events (emit lightweight bus event without DB write)
- Step 4: Add unit tests for coalescer timing, flush-on-dispose, and terminal-state bypass

### Phase 2: In-memory doom-loop detection (P0)

- Step 1: Add ring buffer (last N tool signatures) to `ProcessorContext`
- Step 2: Compute stable hash of `(toolName, input)` instead of `JSON.stringify` comparison
- Step 3: Replace `MessageV2.parts()` DB call in doom-loop check with ring buffer lookup
- Step 4: Add unit tests for ring buffer rotation, hash collision handling, detection accuracy

### Phase 3: Server-side event filtering (P0)

- Step 1: Accept optional `sessionID` and `types` query params on SSE endpoint
- Step 2: Filter events before enqueue/stringify (skip irrelevant events server-side)
- Step 3: Add bounded queue size with drop-oldest policy in `AsyncQueue`
- Step 4: Update CLI subscriber to pass session filter; add integration test for filtered stream

### Phase 4: Incremental history/model-message cache (P1)

- Step 1: Add `HistoryCache` per session in `runLoop` state tracking `(lastMessageID, modelMessages[])`
- Step 2: On each iteration, fetch only messages after `lastMessageID` and append to cached result
- Step 3: Invalidate cache on compaction boundary change
- Step 4: Apply `filterCompacted` incrementally on tail only when compaction window unchanged
- Step 5: Add unit tests for cache hit/miss, invalidation on compaction, correctness vs full rebuild

### Phase 5: Tool schema/definition cache (P1)

- Step 1: Add cache keyed by `(agentID, providerID, modelID, toolset version hash)` in `ToolRegistry`
- Step 2: Return cached transformed definitions when key matches; skip `tool.init` + schema transform
- Step 3: Invalidate on plugin/MCP tool registry change events
- Step 4: Add unit tests for cache key generation, invalidation, and schema equivalence

## Risks

- **Coalesced writes lose data on crash**: Mitigate with flush-on-dispose and terminal-state immediate persist
- **Stale history cache serves wrong messages**: Mitigate with compaction-boundary invalidation + full-rebuild fallback
- **Tool cache serves stale schemas after hot-reload**: Mitigate with version-hash invalidation on registry change events
- **Doom-loop hash collisions cause false positives**: Mitigate with stable deterministic hashing + configurable threshold
- **Bounded queue drops important events**: Mitigate with drop-oldest (not drop-newest) policy + terminal events bypass queue limit
