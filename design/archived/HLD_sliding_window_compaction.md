# HLD: Sliding Window Context Compaction

## Tech Stack

| Category  | Technology         | Purpose                                          |
| --------- | ------------------ | ------------------------------------------------ |
| Language  | TypeScript 5.8     | Type-safe implementation with strict inference   |
| Framework | Effect-ts 4.0-beta | Structured async, error handling, `Effect.fn`    |
| AI SDK    | Vercel AI SDK 6.x  | `generateText` (non-streaming) for summarization |
| Runtime   | Bun 1.3.11         | Fast execution, native TypeScript support        |
| Config    | Zod schemas        | Type-safe configuration validation               |

## Components

| Component              | Responsibility                                             | Dependencies                                     |
| ---------------------- | ---------------------------------------------------------- | ------------------------------------------------ |
| **SlidingWindow**      | Core logic: guard → estimate → split → summarize → compose | Token, Provider, Config, Flag, Log, resolveLocal |
| **Flag (1 line)**      | Feature gate env var                                       | `truthy` helper                                  |
| **Config (1 field)**   | `sliding_window` schema inside `compaction`                | Zod                                              |
| **prompt.ts (1 line)** | Integration call before `toModelMessagesEffect`            | SlidingWindow                                    |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     prompt.ts main loop                              │
│                                                                     │
│  prune → filterCompacted → insertReminders → resolveTools           │
│                                                    │                │
│                                          ┌─────────▼──────────┐     │
│                                          │  SlidingWindow      │     │
│                                          │  .compact()         │     │
│                                          └─────────┬──────────┘     │
│                                                    │                │
│                                          toModelMessagesEffect       │
│                                                    │                │
│                                          processor.process           │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                   src/session/sliding-window.ts                      │
│                                                                     │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────────┐  │
│  │  guards  │───▶│ estimate │───▶│  split   │───▶│  summarize   │  │
│  │          │    │ (Token)  │    │ (window) │    │ (generateText)│  │
│  └──────────┘    └──────────┘    └──────────┘    └──────┬───────┘  │
│       │                                                  │          │
│       │ no-op                                            ▼          │
│       ▼                                          ┌──────────────┐  │
│  return msgs                                     │   compose    │  │
│  unchanged                                       │ [summary]+   │  │
│                                                  │ [tail msgs]  │  │
│                                                  └──────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    In-Memory State                            │  │
│  │  cache: Map<SessionID, { headEndID, summary, ts }>           │  │
│  │  inflight: Set<SessionID>  (mutex)                           │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘

External Dependencies (imported, NOT modified):
  ├── src/session/compaction.ts  → SUMMARY_TEMPLATE (export added)
  ├── src/session/resolve-local.ts → resolveLocalAsync()
  ├── src/util/token.ts → Token.estimate()
  ├── src/flag/flag.ts → Flag.OPENCODE_EXPERIMENTAL_SLIDING_WINDOW
  └── ai → generateText, wrapLanguageModel
```

**Description**: `SlidingWindow.compact()` is called once per loop iteration, after `insertReminders` and tool resolution, but before `toModelMessagesEffect`. It operates on the in-memory `MessageV2.WithParts[]` array. If the feature is disabled or conditions aren't met, it returns messages unchanged (zero-cost no-op). When triggered, it splits messages into head (old) and tail (recent), summarizes the head via a cheap cloud model, and returns a synthetic summary message prepended to the tail. The DB is never modified — this is a view-layer transformation.

## Interfaces

### SlidingWindow (namespace in `src/session/sliding-window.ts`)

| Method       | Input          | Output                          | Behavior                                                                                              | Errors                           |
| ------------ | -------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------- |
| `compact`    | `CompactInput` | `Effect<MessageV2.WithParts[]>` | Full pipeline: guard → estimate → split → summarize → compose. Returns msgs unchanged on any failure. | Never fails (catches internally) |
| `invalidate` | `SessionID`    | `void`                          | Clears cache entry for session. Called when compaction task detected.                                 | None                             |

### Types

```ts
export namespace SlidingWindow {
  export type CompactInput = {
    msgs: MessageV2.WithParts[]
    model: Provider.Model
    cfg: Config.Info
    sessionID: SessionID
    agent: { name: string; mode: "primary" | "subagent" | "all" }
  }

  // Internal types (not exported)
  type CacheEntry = {
    headEndID: MessageID // last msg ID of the head that was summarized
    summary: string // the generated summary text
    ts: number // timestamp for LRU eviction
  }

  type SplitResult = {
    head: MessageV2.WithParts[] // older messages to summarize
    tail: MessageV2.WithParts[] // recent messages to preserve verbatim
  }
}
```

### Function Signatures (internal)

```ts
// Guard: returns true if compaction should proceed
function shouldCompact(input: CompactInput): boolean

// Token estimation for message array (uses Token.estimate on parts)
function estimate(msgs: MessageV2.WithParts[]): number

// Size of the last user turn (from last user msg to end)
function lastTurnSize(msgs: MessageV2.WithParts[]): number

// Split messages into head + tail based on tail budget (aligns to turn boundaries)
function split(msgs: MessageV2.WithParts[], budget: number): SplitResult | undefined

// Call cheap model to summarize head messages (async, matches llm-compress.ts pattern)
async function doSummarize(head: MessageV2.WithParts[], cfg: Config.Info): Promise<string | undefined>

// Build synthetic summary message (ephemeral, never persisted)
function synthetic(summary: string): MessageV2.WithParts
```

## Data Flow

| Step | Component                     | Action                                                                                                       | Next                    |
| ---- | ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------- |
| 1    | `prompt.ts` loop              | Calls `SlidingWindow.compact({ msgs, model, cfg, sessionID, agent })`                                        | SlidingWindow           |
| 2    | `SlidingWindow.shouldCompact` | Checks: flag enabled, agent is primary, not double-summarized, mutex free                                    | Step 3 or return msgs   |
| 3    | `SlidingWindow.estimate`      | Sums `Token.estimate()` across all message parts                                                             | Step 4                  |
| 4    | Guard: threshold              | If total < `cfg.compaction.sliding_window.threshold` (default 50k) → return msgs                             | Step 5                  |
| 5    | `SlidingWindow.split`         | Compute `tailBudget = max(total * tail_ratio, lastTurnTokens)`. Walk from end accumulating until budget met. | Step 6                  |
| 6    | Guard: head size              | If head < 4k tokens → return msgs (not worth network call)                                                   | Step 7                  |
| 7    | Cache lookup                  | Key = `(sessionID, head[last].info.id)`. Hit → use cached summary → Step 11                                  | Step 8                  |
| 8    | Mutex acquire                 | Add sessionID to `inflight` Set. If already present → return msgs                                            | Step 9                  |
| 9    | `SlidingWindow.doSummarize`   | `resolveLocalAsync` → `Provider.getLanguage` → `generateText` with SUMMARY_TEMPLATE, timeout.                | Step 10                 |
| 10   | Mutex release                 | `Effect.ensuring` removes sessionID from `inflight` (always runs, even on error)                             | Step 11                 |
| 11   | Cache store                   | Store `{ headEndID, summary, ts }` in LRU Map                                                                | Step 12                 |
| 12   | `SlidingWindow.synthetic`     | Build `MessageV2.WithParts` with role=user, synthetic text part containing `<context-summary>`               | Step 13                 |
| 13   | Return                        | `[synthetic, ...tail]` → back to prompt.ts                                                                   | `toModelMessagesEffect` |

**Error Flows**:

- `resolveLocalAsync` returns `undefined` → `doSummarize` returns undefined → compact returns msgs unchanged
- `generateText` throws or times out → caught by `Effect.tryPromise` + `Effect.catchAll` → returns undefined → compact returns msgs unchanged
- `generateText` returns empty → `doSummarize` returns undefined → compact returns msgs unchanged
- Any error path → `Effect.ensuring` always releases mutex (removes sessionID from `inflight` Set)
- Outer `Effect.catchAll` on the `tryPromise` ensures no unhandled errors propagate

## Data Model

| Entity                        | Fields                                                  | Relationships             | Constraints                                |
| ----------------------------- | ------------------------------------------------------- | ------------------------- | ------------------------------------------ |
| CacheEntry (in-memory)        | `headEndID: MessageID`, `summary: string`, `ts: number` | Keyed by SessionID in Map | Max 50 entries (LRU eviction)              |
| Inflight mutex (in-memory)    | Set<SessionID>                                          | Per-session exclusion     | Cleared after summarize completes or fails |
| Synthetic message (ephemeral) | `info: { id, role: "user", ... }`, `parts: [TextPart]`  | Never persisted to DB     | Text wrapped in `<context-summary>` tags   |

No database schema changes. All state is ephemeral in-memory.

## Decisions

| Decision                           | Choice                                | Reason                                                                      | Alternatives                 | Tradeoffs                                             |
| ---------------------------------- | ------------------------------------- | --------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------- |
| Single new file                    | All logic in `sliding-window.ts`      | Upstream-rebase safe; no conflicts with parallel changes                    | Spread across multiple files | Slightly larger file (~180 lines) but zero merge risk |
| Module-level Map/Set               | In-memory cache + mutex               | Simple, fast, no deps. Sessions are single-process.                         | Effect Ref/ScopedCache       | Simpler; no GC pressure; cleared on process restart   |
| Token estimation via string length | `Token.estimate(JSON.stringify(msg))` | Reuses existing utility; fast; ±15% accuracy acceptable for threshold check | Count via tokenizer          | No new deps; threshold is soft anyway                 |
| Tail split by token budget         | Walk from end accumulating tokens     | Preserves turn boundaries; respects last-turn guarantee                     | Fixed turn count             | Adaptive to varying turn sizes                        |
| Synthetic message as user role     | Matches existing compaction pattern   | `toModelMessagesEffect` handles user messages naturally                     | System message injection     | Consistent with overflow compaction                   |
| No DB persistence                  | Summary is ephemeral per-process      | DB retains full history; sliding window is a view optimization              | Persist summaries            | Simpler; no migration; restart just re-summarizes     |
| Graceful fallback on all errors    | Return msgs unchanged                 | Never worse than today; feature is additive                                 | Retry logic                  | Simpler; avoids latency spikes                        |

## Risks

| Risk                                                | Impact                               | Likelihood                           | Mitigation                                                             |
| --------------------------------------------------- | ------------------------------------ | ------------------------------------ | ---------------------------------------------------------------------- |
| Summary loses critical reasoning                    | Agent makes wrong decision           | Low (50% tail preserves recent work) | SUMMARY_TEMPLATE preserves TRIED/FIXED chains; user can disable        |
| Token estimate inaccuracy                           | Triggers too early/late by 1-2 turns | Low                                  | Soft threshold; ±15% jitter is acceptable                              |
| Haiku model unavailable                             | Feature silently disabled            | Low                                  | `resolveLocal` returns undefined → graceful skip                       |
| Memory leak from cache                              | Process memory grows                 | Very Low                             | LRU cap at 50 entries; `invalidate` on compaction                      |
| Race between sliding window and overflow compaction | Double-summarization                 | Very Low                             | Guard checks `msgs[0]` for existing summary; mutex prevents concurrent |
| Upstream merge conflict                             | Feature breaks on rebase             | Very Low                             | Only 3 single-line insertions in existing files                        |

## Test Plan

### Unit Tests

**File**: `packages/opencode/test/session/sliding-window.test.ts`

**`shouldCompact` guards:**

- Returns false when flag disabled + config disabled
- Returns false when agent mode is "subagent" and `primary_only` is true
- Returns false when msgs[0] already has summary (double-summarization guard)
- Returns false when sessionID is in inflight set
- Returns true when all guards pass

**`estimate`:**

- Returns correct token count for array of messages
- Handles empty array (returns 0)

**`split`:**

- Splits at correct boundary for given tail budget
- Last-turn guarantee: tail includes full last turn even if > tail_ratio
- Head is empty when all msgs fit in tail budget → returns no split
- Handles single-message array

**`summarize`:**

- Returns summary string on success (mock generateText)
- Returns undefined when resolveLocal returns undefined
- Returns undefined on timeout
- Returns undefined on empty response

**`compact` (integration of above):**

- Below threshold → returns msgs unchanged
- Above threshold, head < 4k → returns msgs unchanged
- Above threshold, cache hit → returns cached summary + tail
- Above threshold, cache miss → calls summarize, caches, returns summary + tail
- Summarize failure → returns msgs unchanged
- Mutex held → returns msgs unchanged

**`invalidate`:**

- Clears cache entry for given sessionID
- No-op for unknown sessionID

**Cache LRU:**

- Evicts oldest entry when exceeding 50 entries

### Integration Tests

- Full prompt loop with sliding window enabled: verify `toModelMessagesEffect` receives fewer messages
- Verify DB messages are NOT modified (full history preserved)
- Verify feature disabled by default (no behavior change without flag)

### Non-Functional Tests

- **Performance**: `estimate` + `split` complete in <5ms for 100-message array
- **Memory**: Cache bounded at 50 entries regardless of session count

## File Changes

### New File: `packages/opencode/src/session/sliding-window.ts`

~180 lines. Contains the entire `SlidingWindow` namespace.

```ts
import { Config } from "@/config/config"
import { Flag } from "@/flag/flag"
import { Provider } from "@/provider/provider"
import { Auth } from "@/auth"
import { Token } from "@/util/token"
import { Log } from "@/util/log"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID } from "./schema"
import { resolveLocalAsync } from "./resolve-local"
import { generateText, wrapLanguageModel } from "ai"
import { Effect } from "effect"
// Import SUMMARY_TEMPLATE — exported from compaction.ts
import { SessionCompaction } from "./compaction"

export namespace SlidingWindow {
  const log = Log.create({ service: "sliding-window" })
  const MAX_CACHE = 50
  const MIN_HEAD = 4_000

  // --- In-memory state ---
  const cache = new Map<string, CacheEntry>()
  const inflight = new Set<string>()

  type CacheEntry = { headEndID: MessageID; summary: string; ts: number }

  export type CompactInput = {
    msgs: MessageV2.WithParts[]
    model: Provider.Model
    cfg: Config.Info
    sessionID: SessionID
    agent: { name: string; mode: "primary" | "subagent" | "all" }
  }

  type SplitResult = { head: MessageV2.WithParts[]; tail: MessageV2.WithParts[] }

  // --- Public API ---

  export const compact = Effect.fn("SlidingWindow.compact")(function* (input: CompactInput) {
    if (!shouldCompact(input)) return input.msgs

    const total = estimate(input.msgs)
    const threshold = input.cfg.compaction?.sliding_window?.threshold ?? 50_000
    if (total < threshold) return input.msgs

    const ratio = input.cfg.compaction?.sliding_window?.tail_ratio ?? 0.5
    const lastTurn = lastTurnSize(input.msgs)
    const budget = Math.max(Math.floor(total * ratio), lastTurn)
    const result = split(input.msgs, budget)
    if (!result) return input.msgs

    const headTokens = estimate(result.head)
    if (headTokens < MIN_HEAD) return input.msgs

    const headEndID = result.head[result.head.length - 1]!.info.id
    const key = input.sessionID

    // Cache hit
    const cached = cache.get(key)
    if (cached && cached.headEndID === headEndID) {
      cached.ts = Date.now()
      return [synthetic(cached.summary), ...result.tail]
    }

    // Mutex check
    if (inflight.has(key)) return input.msgs
    inflight.add(key)

    const summary = yield* Effect.tryPromise({
      try: () => doSummarize(result.head, input.cfg),
      catch: (err) => err,
    }).pipe(
      Effect.catchAll((err) => {
        log.warn("summarize_error", { sessionID: input.sessionID, error: String(err) })
        return Effect.succeed(undefined)
      }),
      Effect.ensuring(Effect.sync(() => inflight.delete(key))),
    )

    if (!summary) return input.msgs
    store(key, headEndID, summary)
    return [synthetic(summary), ...result.tail]
  })

  export function invalidate(sessionID: SessionID): void {
    cache.delete(sessionID)
  }

  // --- Internal helpers ---

  function shouldCompact(input: CompactInput): boolean {
    const cfg = input.cfg
    const enabled = cfg.compaction?.sliding_window?.enabled ?? Flag.OPENCODE_EXPERIMENTAL_SLIDING_WINDOW
    if (!enabled) return false
    if (cfg.compaction?.auto === false) return false
    const primaryOnly = cfg.compaction?.sliding_window?.primary_only ?? true
    if (primaryOnly && input.agent.mode === "subagent") return false
    // Double-summarization guard
    const first = input.msgs[0]
    if (first?.parts.some((p) => p.type === "text" && p.text.includes("<context-summary>"))) return false
    // Mutex guard
    if (inflight.has(input.sessionID)) return false
    return true
  }

  function estimate(msgs: MessageV2.WithParts[]): number {
    let total = 0
    for (const msg of msgs) {
      for (const part of msg.parts) {
        if (part.type === "text") total += Token.estimate(part.text)
        else if (part.type === "tool" && part.state.status === "completed") total += Token.estimate(part.state.output)
        else total += Token.estimate(JSON.stringify(part))
      }
    }
    return total
  }

  function lastTurnSize(msgs: MessageV2.WithParts[]): number {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].info.role === "user") {
        return estimate(msgs.slice(i))
      }
    }
    return 0
  }

  function split(msgs: MessageV2.WithParts[], budget: number): SplitResult | undefined {
    let acc = 0
    for (let i = msgs.length - 1; i >= 0; i--) {
      acc += estimate([msgs[i]])
      if (acc >= budget && i > 0) {
        // Align to turn boundary (user message start)
        let idx = i
        while (idx > 0 && msgs[idx].info.role !== "user") idx--
        if (idx === 0) return undefined
        return { head: msgs.slice(0, idx), tail: msgs.slice(idx) }
      }
    }
    return undefined
  }

  // Follows llm-compress.ts pattern: async function, direct Provider calls
  async function doSummarize(head: MessageV2.WithParts[], cfg: Config.Info): Promise<string | undefined> {
    const model = await resolveLocalAsync(cfg, "sliding-window")
    if (!model) return undefined

    const timeout = cfg.compaction?.sliding_window?.timeout_ms ?? 30_000
    const context = head
      .map((m) => {
        const role = m.info.role
        const text = m.parts
          .filter((p): p is MessageV2.TextPart => p.type === "text")
          .map((p) => p.text)
          .join("\n")
        return `[${role}]: ${text}`
      })
      .join("\n\n")

    const language = await Provider.getLanguage(model)

    const response = await generateText({
      model: wrapLanguageModel({ model: language, middleware: [] }),
      system: "You are a context summarizer. Produce a structured summary of the conversation.",
      messages: [{ role: "user", content: `${SessionCompaction.SUMMARY_TEMPLATE}\n\n${context}` }],
      temperature: 0,
      maxOutputTokens: 2048,
      abortSignal: AbortSignal.timeout(timeout),
    })

    const text = response.text.trim()
    if (!text) {
      log.warn("empty_summary", { model: model.id })
      return undefined
    }

    log.info("summarized", {
      model: model.id,
      input_tokens: Token.estimate(context),
      output_tokens: Token.estimate(text),
    })
    return text
  }

  function synthetic(summary: string): MessageV2.WithParts {
    return {
      info: {
        id: MessageID.ascending(),
        role: "user",
        sessionID: "" as SessionID,
        time: { created: Date.now() },
      } as MessageV2.User,
      parts: [
        {
          id: "" as any,
          type: "text" as const,
          text: `<context-summary>\n${summary}\n</context-summary>`,
          synthetic: true,
          time: { start: Date.now(), end: Date.now() },
        } as MessageV2.TextPart,
      ],
    }
  }

  function store(key: string, headEndID: MessageID, summary: string) {
    if (cache.size >= MAX_CACHE) {
      let oldest: string | undefined
      let oldestTs = Infinity
      for (const [k, v] of cache) {
        if (v.ts < oldestTs) {
          oldest = k
          oldestTs = v.ts
        }
      }
      if (oldest) cache.delete(oldest)
    }
    cache.set(key, { headEndID, summary, ts: Date.now() })
  }
}
```

**Note**: The above is the design blueprint. Implementation will refine types (e.g., proper `MessageV2.WithParts` construction for synthetic messages, exact `SUMMARY_TEMPLATE` import path, `Provider.use` service access pattern).

### Edit: `packages/opencode/src/flag/flag.ts`

**Location**: Line 54, after `OPENCODE_HYBRID_ROUTING`

**Surrounding code (lines 53-55)**:

```ts
  export const OPENCODE_EXPERIMENTAL = truthy("OPENCODE_EXPERIMENTAL")
  export const OPENCODE_HYBRID_ROUTING = truthy("OPENCODE_HYBRID_ROUTING")
  export const OPENCODE_EXPERIMENTAL_FILEWATCHER = Config.boolean("OPENCODE_EXPERIMENTAL_FILEWATCHER").pipe(
```

**Insertion** (1 line, after line 54):

```ts
export const OPENCODE_EXPERIMENTAL_SLIDING_WINDOW = truthy("OPENCODE_EXPERIMENTAL_SLIDING_WINDOW")
```

**Result (lines 53-56)**:

```ts
  export const OPENCODE_EXPERIMENTAL = truthy("OPENCODE_EXPERIMENTAL")
  export const OPENCODE_HYBRID_ROUTING = truthy("OPENCODE_HYBRID_ROUTING")
  export const OPENCODE_EXPERIMENTAL_SLIDING_WINDOW = truthy("OPENCODE_EXPERIMENTAL_SLIDING_WINDOW")
  export const OPENCODE_EXPERIMENTAL_FILEWATCHER = Config.boolean("OPENCODE_EXPERIMENTAL_FILEWATCHER").pipe(
```

### Edit: `packages/opencode/src/config/config.ts`

**Location**: Line 1143, inside the `compaction` z.object, before `.optional()`

**Surrounding code (lines 1133-1144)**:

```ts
      compaction: z
        .object({
          auto: z.boolean().optional().describe("Enable automatic compaction when context is full (default: true)"),
          prune: z.boolean().optional().describe("Enable pruning of old tool outputs (default: true)"),
          reserved: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("Token buffer for compaction. Leaves enough window to avoid overflow during compaction."),
        })
        .optional(),
```

**Insertion** (add `sliding_window` field after `reserved`, before the closing `})`):

Insert after line 1142 (the `reserved` describe line), before line 1143 (`})`):

```ts
          sliding_window: z
            .object({
              enabled: z.boolean().optional().default(false).describe("Enable proactive sliding-window compaction"),
              threshold: z.number().int().min(10000).optional().default(50_000).describe("Token threshold to trigger (default: 50000)"),
              tail_ratio: z.number().min(0.2).max(0.9).optional().default(0.5).describe("Fraction of context preserved verbatim (default: 0.5)"),
              primary_only: z.boolean().optional().default(true).describe("Only apply to primary agents (default: true)"),
              timeout_ms: z.number().int().min(1000).optional().default(30_000).describe("Summary generation timeout (default: 30000)"),
            })
            .optional(),
```

### Edit: `packages/opencode/src/session/prompt.ts`

**Location**: Line 1372-1374, between `plugin.trigger` and `Effect.all([...toModelMessagesEffect...])`

**Surrounding code (lines 1372-1378)**:

```ts
yield * plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })

const [skills, env, instructions, modelMsgs] =
  yield *
  Effect.all([
    Effect.promise(() => SystemPrompt.skills(agent)),
    Effect.promise(() => SystemPrompt.environment(model)),
    instruction.system().pipe(Effect.orDie),
    MessageV2.toModelMessagesEffect(msgs, model),
  ])
```

**Insertion** (2 lines after line 1372, before the `const [skills...` block):

```ts
const cfg = yield * config.get()
msgs = yield * SlidingWindow.compact({ msgs, model, cfg, sessionID, agent })
```

**Additional**: Add import at top of file (line ~13 area, after existing session imports):

```ts
import { SlidingWindow } from "./sliding-window"
```

**Note on `cfg` availability**: There is no `cfg` variable in the `runLoop` scope. It must be obtained via `yield* config.get()` (the `config` service is captured at line 105 as `const config = yield* Config.Service`). The `agent` variable is available at line 1289 (`const agent = yield* agents.get(lastUser.agent)`) and has a `.mode` field (`"primary" | "subagent" | "all"`).

### Edit: `packages/opencode/src/session/compaction.ts` — ONE WORD

`SUMMARY_TEMPLATE` is a `const` inside the `SessionCompaction` namespace (line 44). It needs `export` added so `sliding-window.ts` can import it.

Change line 44 from:

```ts
const SUMMARY_TEMPLATE = `Output exactly...`
```

to:

```ts
export const SUMMARY_TEMPLATE = `Output exactly...`
```

This is a 1-word addition that doesn't change behavior. No other modifications to this file.

## Detailed Module Design: `src/session/sliding-window.ts`

### Module Structure (~180 lines)

```
Lines 1-15:    Imports (Config, Flag, Provider, Token, Log, MessageV2, resolveLocalAsync, generateText, Effect)
Lines 16-25:   Namespace declaration, constants, in-memory state (cache Map, inflight Set)
Lines 26-35:   Type definitions (CacheEntry, CompactInput, SplitResult)
Lines 36-80:   compact() — Effect.fn, orchestrates: guard → estimate → split → cache → summarize → compose
Lines 81-100:  shouldCompact() — all guard checks (flag, auto, primary_only, double-summarization, mutex)
Lines 101-120: estimate() + lastTurnSize() — token counting via Token.estimate on parts
Lines 121-140: split() — window splitting with turn boundary alignment
Lines 141-175: doSummarize() — async function: resolveLocalAsync → Provider.getLanguage → generateText
Lines 176-190: synthetic() — build ephemeral MessageV2.WithParts
Lines 191-210: store() + invalidate() — LRU cache management
```

### Guard Logic (shouldCompact)

```
1. enabled = cfg.compaction?.sliding_window?.enabled ?? Flag.OPENCODE_EXPERIMENTAL_SLIDING_WINDOW
   → false: return false
2. cfg.compaction?.auto === false → return false
3. primaryOnly && input.agent.mode === "subagent" → return false
4. msgs[0] has <context-summary> in text parts → return false (double-summarization)
5. inflight.has(sessionID) → return false (mutex)
6. All pass → return true
```

### Cache Strategy

- **Key**: `SessionID` (one entry per session)
- **Value**: `{ headEndID: MessageID, summary: string, ts: number }`
- **Hit condition**: `cache[sessionID].headEndID === head[last].info.id`
  - This means the head hasn't grown since last summarization
  - Hits during multi-step tool loops (same user turn, assistant keeps calling tools)
- **Miss**: Every new user message grows the head → invalidates
- **Eviction**: LRU when Map exceeds 50 entries
- **Explicit invalidation**: `SlidingWindow.invalidate(sessionID)` called when compaction task detected in prompt loop (line 1268-1278 area)

### Mutex Implementation

```ts
const inflight = new Set<string>()

// Acquire: if (inflight.has(key)) return msgs; inflight.add(key)
// Release: finally { inflight.delete(key) }
```

Simple Set-based mutex. Single-process, single-threaded (Bun). Prevents concurrent summarization for the same session if the prompt loop re-enters before the previous summarize completes (shouldn't happen in practice due to sequential loop, but guards against edge cases with Effect scheduling).

### Fallback Behavior

Every error path returns `input.msgs` unchanged:

- Feature disabled → no-op (synchronous guard)
- Below threshold → no-op (synchronous guard)
- Head too small → no-op (synchronous guard)
- `resolveLocalAsync` returns undefined → `doSummarize` returns undefined → no-op
- `generateText` throws → `Effect.tryPromise` catches → `Effect.catchAll` returns undefined → no-op
- `generateText` timeout → AbortSignal fires → same catch path → no-op
- Empty response → `doSummarize` returns undefined → no-op
- Mutex held → no-op (synchronous guard)
- Mutex always released via `Effect.ensuring` (never leaks)

**Invariant**: The feature can NEVER make things worse than today. Worst case = full context sent (status quo).

### Integration with Existing Compaction

```
prompt loop iteration:
  1. prune (existing) — removes old tool outputs
  2. filterCompacted (existing) — applies overflow compaction if present
  3. insertReminders (existing)
  4. [NEW] SlidingWindow.compact — proactive summarization of old turns
  5. toModelMessagesEffect — converts to AI SDK format
  6. processor.process — sends to model
```

- If overflow compaction already fired (filterCompacted produced a summary at msgs[0]), the double-summarization guard in step 4 skips sliding window.
- If sliding window fires, it reduces token count → makes overflow compaction less likely to ever trigger.
- They are complementary, not conflicting.

### `cfg` Access Pattern

In `prompt.ts`, `cfg` is NOT pre-bound in the `runLoop` scope. It must be obtained inline via:

```ts
const cfg = yield * config.get()
```

Where `config` is the `Config.Service` captured at line 105 of the layer. This is the same pattern used in `compaction.ts` (line 262, 332, 421) and `processor.ts` (line 120).

The `agent` variable (line 1289) has type `Agent.Info` with field `mode: "primary" | "subagent" | "all"`. Pass `{ name: agent.name, mode: agent.mode }` to `SlidingWindow.compact`.
