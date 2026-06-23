# HLD: /dream Memory Consolidation + Wire Diagnostics + Tool Call JSON Repair

Three independent fork-only features sharing no cross-dependencies.

## Tech Stack

| Category  | Technology              | Purpose                                     |
| --------- | ----------------------- | ------------------------------------------- |
| Language  | TypeScript 5.8          | Type safety, existing codebase              |
| Runtime   | Bun 1.3.11              | File I/O (`Bun.file`), fast startup         |
| Framework | Effect-ts 4.0           | Service composition (resolveLocal)          |
| AI SDK    | Vercel AI SDK 6.x       | `streamText`, `experimental_repairToolCall` |
| Storage   | Filesystem (JSONL, .md) | Append-only logs, memory files              |
| Config    | Zod schema in config.ts | Feature gating via `experimental.*`         |

## Components

| Component                                 | Responsibility                                      | Dependencies                            |
| ----------------------------------------- | --------------------------------------------------- | --------------------------------------- |
| `PersistentMemory.dream()`                | Load entries → LLM consolidation → backup → rewrite | `persistent.ts`, `resolveLocal`, Config |
| `/dream` slash command                    | TUI trigger, progress toast                         | `memory-commands.tsx`, SDK fetch        |
| `WireDiagnostics`                         | Per-request metric capture + JSONL write            | `llm.ts` hook site, Config, Global.Path |
| `JsonRepair.repair()`                     | State-machine JSON fixer for truncated/malformed    | standalone, no deps                     |
| `experimental_repairToolCall` enhancement | Wire repair into existing hook                      | `llm.ts`, `JsonRepair`                  |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  TUI (command palette)                                          │
│  ┌──────────┐                                                   │
│  │ /dream   │──▶ POST /session/:id/memory/dream                 │
│  └──────────┘                                                   │
└─────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────┐
│  PersistentMemory.dream()                                       │
│  ┌──────────┐    ┌─────────────┐    ┌───────────────┐          │
│  │ list()   │──▶ │ resolveLocal│──▶ │ LLM consolidate│          │
│  └──────────┘    └─────────────┘    └───────┬───────┘          │
│                                             │                   │
│                              ┌──────────────▼──────────┐       │
│                              │ backup → rewrite files  │       │
│                              └─────────────────────────┘       │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  LLM.stream() call site (src/session/llm.ts)                    │
│                                                                  │
│  ┌────────────────┐         ┌──────────────────┐               │
│  │ WireDiagnostics│◀── pre  │ streamText(...)   │               │
│  │ .capture()     │──▶ post │                   │               │
│  └───────┬────────┘         └────────┬──────────┘               │
│          │                           │                          │
│          ▼                           ▼                          │
│  ┌──────────────┐          ┌─────────────────────┐             │
│  │ JSONL append │          │ repairToolCall hook  │             │
│  │ (fire+forget)│          │  → JsonRepair.repair │             │
│  └──────────────┘          └─────────────────────┘             │
└─────────────────────────────────────────────────────────────────┘
```

Components are decoupled: WireDiagnostics wraps `streamText` timing/metrics, JsonRepair is a pure function called inside the existing `experimental_repairToolCall` hook, and `/dream` is an independent command-to-API flow.

## Interfaces

### PersistentMemory (additions to existing namespace)

| Method   | Input              | Output                                       | Behavior                                                                   | Errors                                           |
| -------- | ------------------ | -------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------ |
| `dream`  | `cfg: Config.Info` | `Promise<{ before: number, after: number }>` | List entries → build prompt → call LLM → backup dir → write merged entries | LLM failure (return unchanged), FS error (throw) |
| `backup` | none               | `string` (backup path)                       | Copy `memory/` to `memory.bak-<timestamp>/`                                | FS permission error                              |

### WireDiagnostics (new namespace)

| Method         | Input                                 | Output                | Behavior                                   | Errors                                  |
| -------------- | ------------------------------------- | --------------------- | ------------------------------------------ | --------------------------------------- |
| `enabled`      | `cfg: Config.Info`                    | `boolean`             | Check `experimental.wire_diagnostics` flag | none                                    |
| `open`         | `sessionID: string, cfg: Config.Info` | `Handle \| undefined` | Create JSONL handle; undefined if disabled | none                                    |
| `Handle.log`   | `event: RequestEvent`                 | `void`                | Fire-and-forget JSONL append               | Silent (logs once on first write error) |
| `Handle.close` | none                                  | `void`                | Mark handle closed                         | none                                    |

### JsonRepair (new namespace)

| Method         | Input                          | Output                | Behavior                                                             | Errors                             |
| -------------- | ------------------------------ | --------------------- | -------------------------------------------------------------------- | ---------------------------------- |
| `repair`       | `input: string`                | `string \| undefined` | State-machine parse; return fixed JSON or undefined if unrecoverable | none (pure function, never throws) |
| `isRepairable` | `input: string, error: string` | `boolean`             | Quick heuristic: does error suggest truncation/malformed JSON?       | none                               |

### /dream slash command

| Method     | Input                             | Output             | Behavior                              | Errors                      |
| ---------- | --------------------------------- | ------------------ | ------------------------------------- | --------------------------- |
| `onSelect` | none (reads sessionID from route) | toast notification | POST to API → show before/after count | Network error → error toast |

## Data Flow

### Phase 1: /dream Consolidation

| Step | Component                | Action                                                | Next     |
| ---- | ------------------------ | ----------------------------------------------------- | -------- |
| 1    | TUI `/dream` command     | User triggers from palette                            | API call |
| 2    | API route handler        | Validate session, call `PersistentMemory.dream(cfg)`  | dream()  |
| 3    | `PersistentMemory.dream` | `list()` → collect all Entry[]                        | LLM call |
| 4    | `resolveLocalAsync`      | Resolve cheap/local model                             | LLM      |
| 5    | LLM call                 | Send consolidation prompt + entries as context        | Parse    |
| 6    | Parse LLM output         | Extract `[type] name: content` lines                  | Backup   |
| 7    | `backup()`               | Copy memory dir to timestamped `.bak`                 | Rewrite  |
| 8    | Rewrite                  | Clear dir, write new merged .md files (capped at 200) | Response |
| 9    | Return                   | `{ before: N, after: M }` → toast in TUI              | Done     |

**Error Flows**: LLM timeout/failure → return original count unchanged, no backup created. FS error on backup → throw, abort rewrite. Parse returns 0 entries → abort, keep originals.

### Phase 2: Wire Diagnostics

| Step | Component              | Action                                                                 | Next         |
| ---- | ---------------------- | ---------------------------------------------------------------------- | ------------ |
| 1    | `LLM.stream()`         | Check `WireDiagnostics.enabled(cfg)`                                   | open handle  |
| 2    | `WireDiagnostics.open` | Create Handle with JSONL path                                          | Pre-capture  |
| 3    | Pre-capture            | Record ts, sessionID, modelID, message counts/bytes, tool schema bytes | streamText   |
| 4    | `streamText()`         | Normal LLM streaming                                                   | Post-capture |
| 5    | Post-capture           | Record response tokens, duration, tool call count                      | Log          |
| 6    | `handle.log(event)`    | Append JSONL line (fire-and-forget)                                    | Done         |

**Error Flows**: Write error → log once to stderr, silence future errors (same pattern as CacheDebugLog). Disabled → no-op, zero overhead.

### Phase 3: JSON Repair

| Step | Component                 | Action                                                               | Next       |
| ---- | ------------------------- | -------------------------------------------------------------------- | ---------- |
| 1    | AI SDK                    | Tool call parse fails → invokes `experimental_repairToolCall`        | Hook       |
| 2    | Existing hook             | Check case-mismatch (existing logic)                                 | JsonRepair |
| 3    | `JsonRepair.isRepairable` | Check if error message indicates JSON parse failure                  | Repair     |
| 4    | `JsonRepair.repair`       | State-machine: close strings, objects, arrays; strip trailing commas | Result     |
| 5    | Validate                  | `JSON.parse(repaired)` succeeds?                                     | Return     |
| 6a   | Success                   | Return repaired toolCall with fixed args                             | Done       |
| 6b   | Failure                   | Fall through to existing `invalid` tool routing                      | Done       |

**Error Flows**: repair() returns undefined → original error handling (route to `invalid` tool). JSON.parse on repaired string throws → same fallback.

## Data Model

| Entity                         | Fields                                                                                                                                                                                                                              | Relationships          | Constraints                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------- |
| `PersistentMemory.Entry`       | `name: string, type: MemoryType, created: string, project?: string, content: string, path: string, mtime: number`                                                                                                                   | Standalone .md files   | MAX_FILES=200, MAX_LINES=500 |
| `WireDiagnostics.RequestEvent` | `ts: number, sessionID: string, modelID: string, messages: {count, byRole, totalBytes}, tools: {count, schemaBytes}, providerOptions: {bytes}, response: {inputTokens, outputTokens, cacheRead, cacheWrite, durationMs, toolCalls}` | References session     | Append-only JSONL            |
| `DreamResult`                  | `before: number, after: number`                                                                                                                                                                                                     | Ephemeral return value | after ≤ 200                  |

## Decisions

| Decision             | Choice                                        | Reason                                                       | Alternatives                           | Tradeoffs                                                        |
| -------------------- | --------------------------------------------- | ------------------------------------------------------------ | -------------------------------------- | ---------------------------------------------------------------- |
| Consolidation model  | `resolveLocal()` (hybrid cheap)               | Reuses existing infrastructure; fast + cheap                 | Main model, dedicated model            | Cheap model may produce lower quality merges; backup mitigates   |
| Diagnostic storage   | JSONL files (same as cache-debug-log)         | Proven pattern in codebase; fire-and-forget; no DB overhead  | SQLite table, structured log           | No querying without external tool; acceptable for diagnostics    |
| JSON repair approach | State machine (no deps)                       | Zero dependencies; handles streaming truncation specifically | `jsonrepair` npm package, regex        | More code but no dep; can tailor to known provider failure modes |
| Repair hook location | Inside existing `experimental_repairToolCall` | Hook already exists; additive change                         | Separate middleware, pre-parse wrapper | Couples repair to single site (acceptable; it's the only site)   |
| Config gating        | `experimental.wire_diagnostics`               | Consistent with existing feature flag pattern                | Always-on, env var                     | Default off = zero perf impact for non-users                     |
| Backup strategy      | Timestamped dir copy before dream             | Reversible; user can manually restore                        | Git-based, SQLite journal              | Simple; disk space cost acceptable for memory files (~small)     |

## Risks

| Risk                                                                 | Impact                                 | Likelihood | Mitigation                                                                                                           |
| -------------------------------------------------------------------- | -------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------- |
| `/dream` LLM hallucinates/loses memories                             | Data loss of persistent memories       | Med        | Timestamped backup dir; user can restore; abort if 0 entries parsed                                                  |
| `/dream` on large memory set exceeds context                         | Consolidation fails or is incomplete   | Low        | Cap input to 200 files; cheap model context usually 8-32k; enough for 200 short entries                              |
| Wire diagnostics write contention                                    | Slow append under high concurrency     | Low        | Fire-and-forget pattern; JSONL append is atomic for <4KB lines; one file per session                                 |
| JSON repair produces syntactically valid but semantically wrong JSON | Tool gets wrong arguments              | Low        | Only triggers on already-failed calls (otherwise AI SDK parses fine); worst case = same as current `invalid` routing |
| Config schema drift on rebase                                        | Merge conflict in experimental section | Low        | Additive field only; append to end of experimental object                                                            |

## Test Plan

### Unit Tests

**Phase 1: /dream**

- `dream()` with 5 sample entries → LLM returns 3 merged → verify 3 files written
- `dream()` with LLM failure → verify original entries unchanged, no backup created
- `dream()` with LLM returning 0 entries → verify abort (no rewrite)
- `backup()` → verify timestamped dir created with correct files
- Cap enforcement: LLM returns 250 entries → verify only 200 written
- Idempotency: run dream twice on same entries → same output

**Phase 2: Wire Diagnostics**

- `enabled()` returns false when flag missing
- `enabled()` returns true when `experimental.wire_diagnostics: true`
- `open()` returns undefined when disabled
- `Handle.log()` appends valid JSONL line
- `Handle.log()` after close → no-op
- Verify all metric fields populated correctly from mock streamText result

**Phase 3: JSON Repair**

- Unclosed string: `{"foo": "bar` → `{"foo": "bar"}`
- Unclosed object: `{"a": 1` → `{"a": 1}`
- Unclosed array: `[1, 2` → `[1, 2]`
- Trailing comma: `{"a": 1,}` → `{"a": 1}`
- Truncated number: `{"x": 123.}` → `{"x": 123.0}`
- Null bytes: `{"a":\x00"b"}` → `{"a": "b"}`
- Valid JSON → return as-is (no mutation)
- Completely garbage → return undefined
- Nested structures: `{"a": {"b": [1, 2` → `{"a": {"b": [1, 2]}}`
- Integration: `repairToolCall` hook with repairable args → verify tool call succeeds

### Integration Tests

- `/dream` end-to-end: create temp memory dir with fixture entries → call dream → verify backup + merged output
- Wire diagnostics: mock LLM stream → verify JSONL file created with correct schema
- JSON repair in `repairToolCall`: simulate failed tool call with truncated JSON → verify repaired call routed correctly

### End-to-End Tests

- `/dream` command via TUI deps mock → verify toast shows "Consolidated: 5 → 3"
- Wire diagnostics JSONL parseable by `JSON.parse()` per line after real stream

### Non-Functional Tests

- `/dream` completes within 30s (LLM call timeout)
- Wire diagnostics adds <1ms overhead to stream path (fire-and-forget)
- JSON repair handles 64KB input without stack overflow (iterative state machine)
