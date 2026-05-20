# HLD: Hook Lifecycle Events (SessionStart, UserPromptSubmit, Stop)

## Tech Stack

| Category  | Technology     | Purpose                                              |
| --------- | -------------- | ---------------------------------------------------- |
| Language  | TypeScript 5.8 | Existing codebase language                           |
| Runtime   | Bun 1.3.11     | Runtime, process spawning for hook commands          |
| Framework | Effect-ts 4.0  | Effect.fn, Effect.runFork (fire-and-forget dispatch) |
| Config    | Zod            | Schema validation for hook rules                     |

## Components

| Component            | Responsibility                                 | Dependencies    |
| -------------------- | ---------------------------------------------- | --------------- |
| Hook.Event type      | Extend union with 2 new events                 | hook.ts         |
| Hook.Rule type       | Make `matcher` optional                        | hook.ts         |
| Hook.Payload type    | Add `prompt` field for user text               | hook.ts         |
| Hook.dispatch        | Handle optional matcher (match-all if absent)  | hook.ts         |
| Hook.execute         | Pass `CLAUDE_USER_PROMPT` env var              | hook.ts         |
| Config hooks schema  | Add SessionStart/UserPromptSubmit event arrays | config.ts       |
| Session.createNext   | Dispatch SessionStart after creation           | index.ts, Hook  |
| SessionPrompt.prompt | Dispatch UserPromptSubmit before loop          | prompt.ts, Hook |
| Session.remove       | Dispatch Stop before deletion                  | index.ts, Hook  |

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Session Lifecycle                       │
│                                                          │
│  createNext()          prompt()            remove()       │
│      │                    │                   │           │
│      ▼                    ▼                   ▼           │
│  SessionStart      UserPromptSubmit         Stop          │
│  (fire-forget)     (blocking/deny)     (fire-forget)     │
└──────┬───────────────────┬───────────────────┬───────────┘
       │                   │                   │
       ▼                   ▼                   ▼
┌──────────────────────────────────────────────────────────┐
│                   Hook.dispatch(event, payload, rules)     │
│                                                          │
│  1. Merge rules from file + config                       │
│  2. Filter by matcher (optional — match-all if absent)   │
│  3. Execute matched hooks (spawn sh -c, pipe JSON stdin) │
│  4. Check exit code:                                     │
│     - PreToolUse/UserPromptSubmit: non-zero → deny       │
│     - Others: non-zero → warn log only                   │
└──────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────┐
│              External Hook Commands                        │
│  (caveman plugin, mode-tracker, custom scripts)           │
│                                                          │
│  ENV: CLAUDE_SESSION_ID, CLAUDE_USER_PROMPT,             │
│       CLAUDE_MODEL, CLAUDE_TOOL_NAME, CLAUDE_TOOL_INPUT  │
│  STDIN: JSON payload                                     │
└──────────────────────────────────────────────────────────┘
```

**Description**: Three new dispatch points are inserted at session lifecycle boundaries. `SessionStart` fires after session row creation (non-blocking via `Effect.runFork`). `UserPromptSubmit` fires after `sessions.touch` but before entering the LLM loop (blocking — can deny). `Stop` fires inside `remove()` before deletion (non-blocking via `Effect.ignore`). The existing `Hook.dispatch` function is reused with a single-line filter change to support optional matchers.

## Interfaces

### Hook (type changes)

| Change         | Before                                                   | After                                                               | Behavior                           |
| -------------- | -------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------- |
| Event type     | `"PreToolUse" \| "PostToolUse" \| ... \| "SubagentStop"` | `... \| "SessionStart" \| "UserPromptSubmit"`                       | 2 new event literals               |
| EVENTS array   | 7 entries                                                | 9 entries                                                           | Drives `empty()` + `merge()` loops |
| Rule.matcher   | `matcher: string`                                        | `matcher?: string`                                                  | Optional — absent = match all      |
| Payload.prompt | (absent)                                                 | `prompt?: string`                                                   | User prompt text for env/stdin     |
| dispatch L163  | `active.filter((r) => matches(r.matcher, tool))`         | `active.filter((r) => !r.matcher \|\| matches(r.matcher, tool))`    | Rules without matcher always fire  |
| dispatch L169  | `event === "PreToolUse" && result.code !== 0`            | `(event === "PreToolUse" \|\| event === "UserPromptSubmit") && ...` | UserPromptSubmit can deny          |
| execute L124   | (no CLAUDE_USER_PROMPT)                                  | `CLAUDE_USER_PROMPT: payload.prompt ?? ""`                          | New env var for hook commands      |

### Hook.dispatch (signature unchanged)

| Method   | Input                                         | Output                      | Behavior                                         | Errors     |
| -------- | --------------------------------------------- | --------------------------- | ------------------------------------------------ | ---------- |
| dispatch | `(event, payload, rules, cfg?)` — same as now | `Effect<{ allowed: true }>` | Filters rules, executes hooks, checks exit codes | HookDenied |

### New dispatch call sites

| Call Site         | Event            | Payload                                           | Dispatch Mode    |
| ----------------- | ---------------- | ------------------------------------------------- | ---------------- |
| `index.ts:~437`   | SessionStart     | `{ sessionID: result.id }`                        | `Effect.runFork` |
| `prompt.ts:~1047` | UserPromptSubmit | `{ sessionID, prompt: extractText(input.parts) }` | blocking (yield) |
| `index.ts:~468`   | Stop             | `{ sessionID }`                                   | `Effect.ignore`  |

## Data Flow

### SessionStart

| Step | Component          | Action                                                        | Next              |
| ---- | ------------------ | ------------------------------------------------------------- | ----------------- |
| 1    | Session.createNext | Session row created, SyncEvent.run fired                      | Hook dispatch     |
| 2    | Hook.dispatch      | Load rules, filter (no matcher → all match), execute commands | External process  |
| 3    | External process   | Receives `{ sessionID }` on stdin + env                       | (fire-and-forget) |

### UserPromptSubmit

| Step | Component            | Action                                        | Next            |
| ---- | -------------------- | --------------------------------------------- | --------------- |
| 1    | SessionPrompt.prompt | User message created, `sessions.touch` called | Hook dispatch   |
| 2    | Hook.dispatch        | Load rules, execute hooks, check exit codes   | Decision        |
| 3a   | (exit 0)             | Proceed to LLM loop                           | `loop()`        |
| 3b   | (exit ≠ 0)           | Return HookDenied                             | Return user msg |

### Stop

| Step | Component        | Action                                        | Next              |
| ---- | ---------------- | --------------------------------------------- | ----------------- |
| 1    | Session.remove   | Session loaded, before SyncEvent.run(Deleted) | Hook dispatch     |
| 2    | Hook.dispatch    | Load rules, execute commands                  | External process  |
| 3    | External process | Receives `{ sessionID }` on stdin             | (fire-and-forget) |

**Error Flows**:

- **Hook load failure** (file missing/bad JSON): `Hook.load()` already returns `empty()` on error — no change needed.
- **Hook command timeout** (10s default): Process killed, `code` = signal code, logged as warning.
- **UserPromptSubmit denied**: Caller receives user message without LLM response (same pattern as `noReply`).
- **SessionStart/Stop hook failure**: Non-zero exit logged as warning, session lifecycle continues unimpeded.

## Data Model

No new DB tables or columns. Events are ephemeral dispatch points.

| Entity       | Fields                                                | Relationships | Constraints          |
| ------------ | ----------------------------------------------------- | ------------- | -------------------- |
| Hook.Payload | `tool?, input?, result?, sessionID?, model?, prompt?` | None          | All optional         |
| Hook.Rule    | `matcher?: string, hooks: HookDef[]`                  | Parent: Rules | matcher now optional |

## Surgical Change Specification

### File: `packages/opencode/src/hook/hook.ts`

| Location | Change Type | Description                                                                       |
| -------- | ----------- | --------------------------------------------------------------------------------- |
| L13-20   | Modify      | Add `"SessionStart" \| "UserPromptSubmit"` to `Event` type                        |
| L22-30   | Modify      | Add `"SessionStart", "UserPromptSubmit"` to `EVENTS` array                        |
| L38-41   | Modify      | Change `matcher: string` → `matcher?: string`                                     |
| L45-51   | Modify      | Add `prompt?: string` to `Payload` type                                           |
| L72-81   | Modify      | Add `SessionStart: [], UserPromptSubmit: []` to `empty()`                         |
| L123-128 | Insert      | Add `CLAUDE_USER_PROMPT: payload.prompt ?? ""` in env object (after L127)         |
| L163     | Modify      | `active.filter((r) => !r.matcher \|\| matches(r.matcher, tool))`                  |
| L169     | Modify      | `(event === "PreToolUse" \|\| event === "UserPromptSubmit") && result.code !== 0` |

### File: `packages/opencode/src/config/config.ts`

| Location    | Change Type | Description                                                                  |
| ----------- | ----------- | ---------------------------------------------------------------------------- |
| L1217       | Modify      | `matcher: z.string()` → `matcher: z.string().optional()`                     |
| L1231       | Modify      | Same for PostToolUse                                                         |
| L1245       | Modify      | Same for PostToolUseFailure                                                  |
| L1259       | Modify      | Same for Notification                                                        |
| L1273       | Modify      | Same for Stop                                                                |
| L1287       | Modify      | Same for SubagentStart                                                       |
| L1301       | Modify      | Same for SubagentStop                                                        |
| After L1311 | Insert      | Add `SessionStart` and `UserPromptSubmit` z.array schemas (matcher optional) |

### File: `packages/opencode/src/session/index.ts`

| Location   | Change Type | Description                                      |
| ---------- | ----------- | ------------------------------------------------ |
| L1 imports | Insert      | Add `import { Hook } from "../hook/hook"`        |
| After L436 | Insert      | SessionStart dispatch (4 lines, fire-and-forget) |
| After L469 | Insert      | Stop dispatch (4 lines, fire-and-forget)         |

### File: `packages/opencode/src/session/prompt.ts`

| Location    | Change Type | Description                                              |
| ----------- | ----------- | -------------------------------------------------------- |
| After L1046 | Insert      | UserPromptSubmit dispatch (12 lines, blocking with deny) |

## Code Diffs (Exact Insertions)

### hook.ts — Event type (L13-20)

```diff
   export type Event =
     | "PreToolUse"
     | "PostToolUse"
     | "PostToolUseFailure"
     | "Notification"
     | "Stop"
+    | "SessionStart"
+    | "UserPromptSubmit"
     | "SubagentStart"
     | "SubagentStop"
```

### hook.ts — EVENTS array (L22-30)

```diff
   export const EVENTS: Event[] = [
     "PreToolUse",
     "PostToolUse",
     "PostToolUseFailure",
     "Notification",
     "Stop",
+    "SessionStart",
+    "UserPromptSubmit",
     "SubagentStart",
     "SubagentStop",
   ]
```

### hook.ts — Rule type (L38-41)

```diff
   export type Rule = {
-    matcher: string
+    matcher?: string
     hooks: HookDef[]
   }
```

### hook.ts — Payload type (L45-51)

```diff
   export type Payload = {
     tool?: string
     input?: unknown
     result?: unknown
     sessionID?: string
     model?: string
+    prompt?: string
   }
```

### hook.ts — empty() (L72-81)

```diff
   function empty(): Rules {
     return {
       PreToolUse: [],
       PostToolUse: [],
       PostToolUseFailure: [],
       Notification: [],
       Stop: [],
+      SessionStart: [],
+      UserPromptSubmit: [],
       SubagentStart: [],
       SubagentStop: [],
     }
   }
```

### hook.ts — execute() env (after L127)

```diff
       CLAUDE_MODEL: payload.model ?? "",
       CLAUDE_TOOL_RESULT: payload.result !== undefined ? JSON.stringify(payload.result) : "",
+      CLAUDE_USER_PROMPT: payload.prompt ?? "",
     }
```

### hook.ts — dispatch matcher filter (L163)

```diff
-    const matched = active.filter((r) => matches(r.matcher, tool))
+    const matched = active.filter((r) => !r.matcher || matches(r.matcher, tool))
```

### hook.ts — dispatch blocking check (L169)

```diff
-        if (event === "PreToolUse" && result.code !== 0) {
+        if ((event === "PreToolUse" || event === "UserPromptSubmit") && result.code !== 0) {
```

### session/index.ts — SessionStart dispatch (after L436)

```typescript
// Hook dispatch: SessionStart (fire-and-forget)
yield *
  Effect.sync(() => {
    Effect.runFork(
      Effect.gen(function* () {
        const rules = yield* Effect.promise(() => Hook.load())
        yield* (Hook.dispatch("SessionStart", { sessionID: result.id }, rules) as Effect.Effect<any>).pipe(
          Effect.ignore,
        )
      }),
    )
  })
```

Insert after:

```typescript
yield * Effect.sync(() => SyncEvent.run(Event.Created, { sessionID: result.id, info: result }))
```

### session/index.ts — Stop dispatch (after L469, inside remove before SyncEvent.run Deleted)

```typescript
// Hook dispatch: Stop (fire-and-forget)
yield *
  Effect.promise(async () => {
    const rules = await Hook.load()
    await Effect.runPromise((Hook.dispatch("Stop", { sessionID }, rules) as Effect.Effect<any>).pipe(Effect.ignore))
  }).pipe(Effect.ignore)
```

Insert after `const session = yield* get(sessionID)` (L469) and before `const kids = yield* children(sessionID)` (L470).

### session/prompt.ts — UserPromptSubmit dispatch (after L1046)

```typescript
// Hook dispatch: UserPromptSubmit (blocking — can deny)
if (cfg.experimental?.hooks) {
  const rules = yield * Effect.promise(() => Hook.load())
  const text = input.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n")
  const hookResult =
    yield *
    (
      Hook.dispatch("UserPromptSubmit", { sessionID: input.sessionID, prompt: text }, rules, cfg) as Effect.Effect<
        { allowed: true },
        any
      >
    ).pipe(Effect.catch((denied: any) => Effect.succeed({ allowed: false as const, reason: denied.message as string })))
  if (!hookResult.allowed) return message
}
```

Insert after:

```typescript
yield * sessions.touch(input.sessionID)
```

Note: `cfg` is obtained via `yield* config.get()` — it must be fetched before this block. Looking at the prompt function (L1041-1059), `cfg` is NOT currently available. It's obtained inside `resolveTools` (L234). The dispatch site needs to obtain config:

```typescript
// Hook dispatch: UserPromptSubmit (blocking — can deny)
const cfg = yield * config.get()
if (cfg.experimental?.hooks) {
  const rules = yield * Effect.promise(() => Hook.load())
  const text = input.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n")
  const hookResult =
    yield *
    (
      Hook.dispatch("UserPromptSubmit", { sessionID: input.sessionID, prompt: text }, rules, cfg) as Effect.Effect<
        { allowed: true },
        any
      >
    ).pipe(Effect.catch((denied: any) => Effect.succeed({ allowed: false as const, reason: denied.message as string })))
  if (!hookResult.allowed) return message
}
```

## Decisions

| Decision                   | Choice                        | Reason                                               | Alternatives                  | Tradeoffs                                      |
| -------------------------- | ----------------------------- | ---------------------------------------------------- | ----------------------------- | ---------------------------------------------- |
| SessionStart dispatch mode | `Effect.runFork` (non-block)  | Session creation must not wait for plugins           | Blocking (wait for hook)      | Plugin may miss fast subsequent actions        |
| UserPromptSubmit mode      | Blocking (yield\*)            | Must be able to deny prompt submission               | Fire-and-forget               | Slow hooks delay user response                 |
| Stop dispatch mode         | Non-blocking + ignore         | Deletion must not fail if hook errors                | Blocking                      | Hook may not complete before process exits     |
| matcher optional           | `matcher?: string`            | Claude Code lifecycle hooks don't use matchers       | Separate type for lifecycle   | Existing tool hooks slightly looser validation |
| Text extraction from parts | Filter text parts, join `\n`  | Simple, covers all prompt text                       | Pass full parts array         | Loses non-text content info                    |
| Config access in prompt()  | `yield* config.get()` inline  | Config service already available in the Effect scope | Thread cfg from outer closure | One extra config read per prompt               |
| Stop hook in remove()      | Before SyncEvent.run(Deleted) | Hook needs session to still exist                    | After deletion                | Slight delay before actual cleanup             |

## Risks

| Risk                                    | Impact                                                 | Likelihood | Mitigation                                                                   |
| --------------------------------------- | ------------------------------------------------------ | ---------- | ---------------------------------------------------------------------------- |
| Slow UserPromptSubmit plugin            | Blocks all user input for 10s                          | Med        | 10s timeout kills process; user can disable hooks                            |
| Hook command crashes                    | Stderr noise in logs                                   | Low        | Already handled — warn log, continue                                         |
| Config unavailable in createNext        | Can't gate behind experimental                         | Low        | SessionStart dispatches unconditionally (rules empty if no hooks configured) |
| `remove()` called without InstanceState | Hook.load() fails on path resolve                      | Low        | Wrapped in `Effect.ignore` — errors suppressed                               |
| Matcher change breaks existing rules    | Rules with `matcher: "*"` now redundant but still work | None       | Backward compatible — explicit matcher still matches                         |

## Test Plan

### Unit Tests

**File**: `test/hook/hook.test.ts` (new or extend existing)

| Scenario                                    | Input                                   | Expected                            |
| ------------------------------------------- | --------------------------------------- | ----------------------------------- |
| dispatch SessionStart with no rules         | `dispatch("SessionStart", {}, empty())` | `{ allowed: true }`                 |
| dispatch UserPromptSubmit — allowed         | Hook exits 0                            | `{ allowed: true }`                 |
| dispatch UserPromptSubmit — denied          | Hook exits 1                            | `HookDenied` error                  |
| dispatch with optional matcher (absent)     | Rule has no `matcher` field             | Rule fires for any tool value       |
| dispatch with matcher present               | Rule has `matcher: "read*"`             | Only fires when tool matches        |
| payload.prompt passed to CLAUDE_USER_PROMPT | `{ prompt: "hello" }`                   | Env var set to "hello"              |
| Stop event — non-zero exit                  | Hook exits 1                            | Warning logged, no error propagated |

### Integration Tests

| Scenario                             | Components                  | Verification                             |
| ------------------------------------ | --------------------------- | ---------------------------------------- |
| SessionStart fires on session create | Session.createNext + Hook   | Hook command receives sessionID on stdin |
| UserPromptSubmit blocks prompt       | SessionPrompt.prompt + Hook | `prompt()` returns user message only     |
| Stop fires on session remove         | Session.remove + Hook       | Hook command executes before deletion    |
| Caveman plugin activates             | Full stack + settings.json  | Plugin receives SessionStart event       |

### End-to-End Tests

| Journey                               | Steps                                                                                          | Success Criteria                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------- |
| Caveman plugin with opencode          | 1. Configure ~/.claude/settings.json with SessionStart hook 2. Create session 3. Submit prompt | Hook commands fire, no errors      |
| Deny prompt via UserPromptSubmit hook | 1. Configure hook that exits 1 2. Submit prompt                                                | User message returned, no LLM call |

### Non-Functional Tests

| Requirement   | Target                                     | Verification                               |
| ------------- | ------------------------------------------ | ------------------------------------------ |
| Hook timeout  | Commands killed after 10s                  | Configure slow hook, verify process killed |
| No regression | Existing PreToolUse hooks                  | Run existing hook tests, verify pass       |
| Feature gate  | Only fires when `experimental.hooks: true` | Disable flag, verify no dispatch           |

## Upstream Rebase Safety Analysis

Each change is designed to survive upstream rebases:

| Change                       | Why Rebase-Safe                                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Event type union (append)    | Added before `SubagentStart` — independent lines, no conflict with appends                                      |
| EVENTS array (append)        | Same position strategy — upstream additions at end won't conflict                                               |
| Rule.matcher optional        | Single-character change (`?` added) — any upstream change to Rule rewrites line anyway                          |
| Payload.prompt               | New field appended — independent of existing fields                                                             |
| empty() additions            | Added before SubagentStart entries — positionally stable                                                        |
| execute() env var            | Single line insert after existing env vars — upstream additions won't overlap                                   |
| dispatch filter (L163)       | Single-line replacement — if upstream modifies this line, conflict is intentional (semantic)                    |
| dispatch blocking (L169)     | Same — semantic dependency on event semantics                                                                   |
| config.ts matcher optional   | `.optional()` appended to each `z.string()` — single-point change per line                                      |
| config.ts new event schemas  | Inserted before closing `})` of hooks object — upstream event additions would conflict only if at same position |
| index.ts SessionStart insert | Inserted after a unique anchor line (`SyncEvent.run(Event.Created...)`) — stable anchor                         |
| index.ts Stop insert         | Inserted after `const session = yield* get(sessionID)` — unique anchor                                          |
| prompt.ts UserPromptSubmit   | Inserted after `yield* sessions.touch(input.sessionID)` — unique anchor                                         |

**Key principle**: All insertions use unique single-line anchors that are unlikely to be modified by unrelated upstream changes. No broad reformatting. No moving existing code. Pure additions at stable insertion points.
