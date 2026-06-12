# PLAN: Sliding Window + Summary Context Optimization

## Problem

When session context grows past ~50k tokens but is still well below the model's context limit (e.g. 200k), early turns become stale and irrelevant to the current task. The full history is sent every turn, inflating cost with no accuracy benefit. The current compaction only triggers at overflow—too late.

## Solution

Introduce a **proactive sliding-window compaction** that, before each primary-agent LLM call, checks whether the token count exceeds a configurable threshold (default 50k). When triggered, it uses a **cheap cloud model** (Haiku-tier, 200k context) to summarize the older half of context into a rolling summary, then sends `[summary] + [recent verbatim turns]` to the main model.

**Gated behind**: `OPENCODE_EXPERIMENTAL_SLIDING_WINDOW=true` env var OR `compaction.sliding_window.enabled: true` in config. Disabled by default.

## Design Decisions

| Decision          | Choice                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| Feature gate      | Env var `OPENCODE_EXPERIMENTAL_SLIDING_WINDOW` OR config `compaction.sliding_window.enabled`. Default: **off**. |
| Threshold         | Configurable, default 50k, primary agents only                                                                  |
| Summary model     | Cheap cloud model (Haiku-tier via `resolveLocal`); fallback: skip (send full context)                           |
| Tail ratio        | **50% of total context** (configurable). Aggressively compact old, generously preserve recent.                  |
| Summary placement | Prefix injection (synthetic message at context top)                                                             |
| Trigger timing    | Pre-send check (before main model call)                                                                         |
| Persistence       | Ephemeral per-turn; DB retains full history                                                                     |
| Head size limit   | None needed — Haiku-tier models have 200k context                                                               |
| Tail guarantee    | Always preserve full last turn (never truncate current work)                                                    |

## Architecture

```
prompt loop (each step)
  │
  ├─ prune (existing)
  ├─ filterCompacted (existing)
  │
  ├─ [NEW] slidingWindowCompact(msgs, model, cfg, agent)
  │     ├─ guard: feature flag disabled → no-op
  │     ├─ guard: skip if agent is not primary
  │     ├─ guard: skip if msgs[0] is already a compaction summary
  │     ├─ guard: skip if compaction in-flight for this session (mutex)
  │     ├─ estimate total tokens of msgs
  │     ├─ if total < threshold → no-op, return msgs as-is
  │     ├─ compute tail budget: max(total * tail_ratio, lastTurnSize)
  │     ├─ split msgs into [head] + [tail]
  │     ├─ if head trivially small (< 4k) → no-op
  │     ├─ if cached summary covers head → reuse
  │     ├─ else → acquire mutex, call cheap model to summarize head
  │     ├─ cache summary keyed by (sessionID, head_end_id)
  │     └─ return [synthetic summary msg] + [tail msgs]
  │
  ├─ toModelMessages (existing)
  └─ processor.process (existing)
```

## Model Assumptions

The "cheap_model" in config is a **Haiku-tier cloud model** (not a local 7B):

- ~200k context window — any realistic head fits in one call
- Fast inference: ~1-3s for 50k input
- Cheap: ~$0.25/1M input, ~$1.25/1M output
- Good at structured extraction (SUMMARY_TEMPLATE works well)

## Tail Budget Strategy

**Principle: aggressively compact OLD, generously preserve RECENT.**

The tail preserves **50% of total context** (configurable via `tail_ratio`). This means:

| Total context | Tail (verbatim) | Head (summarized)     | Effective turns preserved |
| ------------- | --------------- | --------------------- | ------------------------- |
| 55k           | 27.5k           | 27.5k → ~2-3k summary | Last ~3-4 turns           |
| 70k           | 35k             | 35k → ~3k summary     | Last ~4-5 turns           |
| 100k          | 50k             | 50k → ~4k summary     | Last ~5-7 turns           |
| 150k          | 75k             | 75k → ~5k summary     | Last ~7-9 turns           |

The tail grows proportionally with the session, ensuring the agent always has generous recent context. Only the truly stale first half gets summarized.

**Last-turn guarantee**: `tailBudget = max(total * tail_ratio, lastTurnSize)` — never truncate current work. If the most recent turn is 20k tokens (heavy tool usage), the tail is at least 20k regardless of the ratio.

## Phases

### Phase 1: Feature Flag & Config

**Files:** `src/flag/flag.ts`, `src/config/config.ts`

1. Add flag to `src/flag/flag.ts`:

   ```ts
   export const OPENCODE_EXPERIMENTAL_SLIDING_WINDOW = truthy("OPENCODE_EXPERIMENTAL_SLIDING_WINDOW")
   ```

2. Add config field `compaction.sliding_window`:

   ```ts
   sliding_window: z.object({
     enabled: z.boolean().optional().default(false).describe("Enable proactive sliding-window compaction"),
     threshold: z
       .number()
       .int()
       .min(10000)
       .optional()
       .default(50_000)
       .describe("Token count threshold to trigger sliding window (default: 50000)"),
     tail_ratio: z
       .number()
       .min(0.2)
       .max(0.9)
       .optional()
       .default(0.5)
       .describe("Fraction of total context to preserve as verbatim tail (default: 0.5)"),
     primary_only: z.boolean().optional().default(true).describe("Only apply to primary agents (default: true)"),
     timeout_ms: z
       .number()
       .int()
       .min(1000)
       .optional()
       .default(30_000)
       .describe("Timeout for summary generation call (default: 30000)"),
   }).optional()
   ```

3. Feature enabled check:
   ```ts
   const enabled = cfg.compaction?.sliding_window?.enabled ?? Flag.OPENCODE_EXPERIMENTAL_SLIDING_WINDOW
   ```

### Phase 2: Core Module

**Files:** `src/session/sliding-window.ts`

1. Create `src/session/sliding-window.ts` with `SlidingWindow` namespace:
   - In-memory LRU cache (max 50 sessions)
   - Per-session mutex (`Set<SessionID>`)

2. `estimate(msgs, model)` — reuse `Token.estimate` + `toModelMessagesEffect`

3. `splitWindow(msgs, cfg, model)`:
   - Compute `tailBudget = max(total * tail_ratio, lastTurnSize)`
   - Walk turns from end, accumulating until budget is met
   - Return `{ head, tail }`

4. `summarize(head, cfg)`:
   - Resolve model via `resolveLocal(provider, cfg, "sliding-window")`
   - If no model resolved → return `undefined`
   - Use `SUMMARY_TEMPLATE` from compaction.ts
   - Call `generateText` with configured timeout
   - Validate non-empty
   - Return summary string or `undefined` on failure

5. `compact(input)`:
   - Guards: feature flag, primary_only, double-summarization, mutex
   - Estimate tokens; if below threshold → no-op
   - Split with tail budget
   - If head < 4k → no-op (not worth the network call)
   - Cache check → hit: reuse; miss: summarize
   - On failure → return msgs unchanged (graceful fallback)
   - Build synthetic message with `<context-summary>` tags
   - Return `[summary msg, ...tail]`

### Phase 3: Integration

**Files:** `src/session/prompt.ts`

1. In the main prompt loop (before `toModelMessagesEffect`, ~line 1374):
   ```ts
   msgs = yield * SlidingWindow.compact({ msgs, model, cfg, sessionID, agent: agent.name })
   ```
2. Guard: skip if `cfg.compaction?.auto === false`
3. Invalidate cache synchronously when compaction task detected in loop

### Phase 4: Agent Awareness

**Files:** `src/agent/agent.ts` (or wherever `primary` flag lives)

1. Determine if agent is "primary" — check `agent.primary` field or absence of `parentSessionID`
2. Pass to `SlidingWindow.compact`

### Phase 5: Caching & Concurrency

**Files:** `src/session/sliding-window.ts`

1. LRU Map keyed by sessionID: `{ headEndID, summary, ts }`
2. Cache hit: `headEndID` matches last msg ID of current head
3. Invalidation: synchronous clear on compaction detection, session delete/reset
4. Memory bound: max 50 entries, LRU eviction
5. Per-session mutex: `Set<SessionID>`. If held → skip (return msgs unchanged)

## Accuracy Safeguards

### Last-Turn Guarantee

**Problem**: A single tool-heavy turn can be 15-20k tokens. On edge cases (just over threshold), a naive split might cut into the current turn.

**Solution**: Tail budget floored at last turn size. The agent never loses its own recent work.

### Why 50% Tail Works

At 50% tail, the agent always sees the last 3-7 turns verbatim (depending on session length). This covers:

- All recent edits and their results
- The current debugging chain
- Recent tool outputs
- The user's last several instructions
- Most back-references ("that fix", "same approach") since they typically point to the last 2-4 turns

Only truly old content (the first half of the session — initial exploration, abandoned approaches, resolved errors) gets summarized. This is exactly the content that's stale.

## Guards Against Quality Loss

| Guard                        | Mechanism                                                              |
| ---------------------------- | ---------------------------------------------------------------------- |
| Feature disabled by default  | Env var or config must explicitly enable                               |
| Double-summarization         | Skip if `msgs[0].info.summary === true` (already compacted)            |
| Concurrent calls             | Per-session mutex; skip if held                                        |
| Bad summary                  | Validate non-empty; on failure, skip and send full context             |
| Network failure / timeout    | 30s timeout; on any error, skip and send full context                  |
| Reasoning chain preservation | SUMMARY_TEMPLATE's "What Happened" section with TRIED:/FIXED: prefixes |
| Current work preservation    | Last-turn guarantee — tail budget floored at last turn size            |
| Trivial head                 | Skip if head < 4k tokens (not worth the network call)                  |

## Interaction with Existing Systems

- **Existing overflow compaction**: Unchanged. Still triggers at model context limit. Sliding window reduces likelihood of ever reaching overflow.
- **Prune**: Still runs before sliding window. Pruned tool outputs = fewer tokens in head = cheaper/faster summary.
- **Hybrid tool compression**: Complementary. Compresses individual tool outputs at write-time; sliding window compresses _conversational_ history.
- **filterCompacted**: Applied first. If overflow compaction already produced a summary, the double-summarization guard skips sliding window.
- **Feature flag pattern**: Follows `OPENCODE_HYBRID_ROUTING` precedent — env var + config property, config wins.

## Cost Analysis

Assumptions: Haiku-tier model @ $0.25/1M input, $1.25/1M output. Main model (Sonnet) @ $3/1M input.

**Realistic 15-turn session** (debugging + implementation, ~67k total tokens):

With 50% tail ratio:

| Turn                    | Context (no SW) | Tail (50%) | Head summarized | Tokens sent | Savings |
| ----------------------- | --------------- | ---------- | --------------- | ----------- | ------- |
| 10 (first trigger, 52k) | 52k             | 26k        | 26k → 2k        | 28k         | 46%     |
| 12 (57k)                | 57k             | 28k        | 29k → 2.5k      | 30.5k       | 47%     |
| 15 (67k)                | 67k             | 33k        | 34k → 3k        | 36k         | 46%     |

**Per-session costs (turns 10-15)**:

- Main model input savings: ~$0.30
- Summary costs (6 cache misses, ~30k input each): ~$0.05
- **Net savings: ~$0.25 (19% input cost reduction)**

For longer sessions (25+ turns, 120k+ context): savings scale to ~$0.50-$0.80 net (30%+ reduction).

Cache hit rate (realistic): ~15-25% of steps (tool-continuation loops within a turn).

## Latency Impact

| Scenario              | Added latency     | Notes                        |
| --------------------- | ----------------- | ---------------------------- |
| Feature disabled      | 0ms               | No-op                        |
| Below threshold       | 0ms               | No-op                        |
| Cache hit             | ~1ms              | Map lookup                   |
| Cache miss (30k head) | ~1-2s             | Haiku fast on smaller inputs |
| Cache miss (60k head) | ~2-3s             | Still comfortable for Haiku  |
| Timeout/failure       | 0ms after timeout | Falls back to full context   |

**Net session speed**: Summary adds ~10s total (6 misses × ~1.7s avg for 50% heads). Main model TTFT savings from smaller input: ~20s (15 calls × ~1.3s faster). **Net: ~10s faster overall.**

## Risks & Mitigations

| Risk                             | Severity  | Mitigation                                                            |
| -------------------------------- | --------- | --------------------------------------------------------------------- |
| Summary loses reasoning chains   | 🟡 Medium | SUMMARY_TEMPLATE + 50% tail means recent reasoning is always verbatim |
| User references very old context | 🟡 Medium | 50% tail covers most cases; summary preserves key facts for the rest  |
| Network failure                  | 🟢 Low    | Timeout + graceful fallback to full context                           |
| Double-summarization             | 🟢 Low    | Explicit guard on first msg                                           |
| Race condition                   | 🟢 Low    | Per-session mutex                                                     |
| Token.estimate inaccuracy (±15%) | 🟢 Low    | Threshold jitter of ±1-2 turns, minimal impact                        |
| Feature causes regression        | 🟢 Low    | Disabled by default; explicit opt-in required                         |

## Known Limitations (Accepted)

1. **Reasoning chains in old turns compressed to bullets** — mitigated by 50% tail keeping recent chains verbatim.
2. **Cache miss on every new user turn** — head grows each time, invalidating cache. Hits only during multi-step tool loops (~15-25% of steps).
3. **No retrieval fallback** — for references to very old content (first half of session), model works from summary only.

## Success Criteria

- Feature is opt-in and does not affect any user who hasn't enabled it
- Sessions >50k tokens show reduced input token counts when enabled
- No regression in task completion accuracy (manual testing with flag on)
- Existing compaction/overflow tests pass unchanged
- New unit tests: split logic, cache, mutex, last-turn guarantee
- Graceful degradation: any failure → full context sent (never worse than today)

## Out of Scope (Future)

- Retrieval fallback for explicit user back-references (semantic search over old messages)
- Per-tool selective retention (e.g. keep recent `edit` calls verbatim in head)
- UI indication of sliding window state
- Incremental/streaming summary updates
- Background pre-computation of summary after each turn
- Enabling by default (requires confidence from opt-in testing)
