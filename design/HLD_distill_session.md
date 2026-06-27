# HLD: Distill Current Session

## Tech Stack

| Category  | Technology         | Purpose                                  |
| --------- | ------------------ | ---------------------------------------- |
| Language  | TypeScript 5.8     | Existing codebase standard               |
| Runtime   | Bun 1.3.11         | Native SQLite via `bun:sqlite`           |
| Framework | Effect-ts 4.0-beta | Service composition, `Effect.fn` tracing |
| Database  | SQLite + Drizzle   | `MessageV2.page` reads session messages  |
| AI SDK    | `ai` (v6)          | Distill agent prompt resolution          |

## Components

| Component               | Responsibility                                                  | Dependencies                                       |
| ----------------------- | --------------------------------------------------------------- | -------------------------------------------------- |
| `buildSessionContext`   | Build markdown context from single session's messages           | `MessageV2.page`, `extractText`                    |
| `Command.Info` (ext)    | Optional `dynamicTemplate` field for arg-aware dispatch         | `SessionID`, command arguments                     |
| `SessionPrompt.command` | Dispatch: prefer `dynamicTemplate` over `template` when present | `Command.Info`, `CommandInput`                     |
| `DISTILL_SESSION_TASK`  | Prompt variant relaxing "recurring 2+" criterion                | `DISTILL_TASK` base text                           |
| Distill command reg     | Wire `dynamicTemplate` with `this` routing logic                | `buildSessionContext`, `buildContext`, `AutoDream` |

## Architecture

```
User: /distill this
         │
         ▼
┌────────────────────────────────────────────────┐
│  SessionPrompt.command(input)                   │
│  input.sessionID = current session              │
│  input.arguments = "this"                       │
│  cmd = commands["distill"]                      │
└────────┬───────────────────────────────────────┘
         │
         ▼ cmd.dynamicTemplate exists?
         │
    ┌────┴────┐
    │ YES     │ NO (fallback)
    ▼         ▼
┌─────────┐  ┌──────────────┐
│dynamicTemplate({          │  │await cmd.template│
│  sessionID,               │  │(existing getter) │
│  arguments: "this"        │  └──────────────────┘
│})                         │
└─────────┬─────────────────┘
          │
          ▼ arguments === "this"?
     ┌────┴────┐
     │ YES     │ NO
     ▼         ▼
┌──────────┐  ┌──────────────────────┐
│buildSessionContext(sessionID, opts) │  │buildContext(days, opts)│
│→ single session markdown            │  │→ multi-session markdown│
└──────────┬──────────────────────────┘  └───────────┬───────────┘
           │                                          │
           ▼                                          ▼
┌─────────────────────────┐        ┌──────────────────────────┐
│DISTILL_SESSION_TASK +   │        │DISTILL_TASK + context    │
│context                  │        │(existing behavior)       │
└─────────────────────────┘        └──────────────────────────┘
           │                                          │
           └──────────────┬───────────────────────────┘
                          ▼
              Template resolved → prompt dispatched
              to distill agent as normal
```

**Description**: The `dynamicTemplate` field on `Command.Info` allows commands to produce their template at dispatch time with access to both `sessionID` and `arguments`. `SessionPrompt.command` checks for `dynamicTemplate` before falling back to the existing `template` getter. The distill command's `dynamicTemplate` inspects `arguments` for the literal `"this"` token — if matched, builds context from the current session only using `buildSessionContext`; otherwise delegates to the existing `buildContext` multi-session path.

## Interfaces

### `dream-spawn.ts` — New Export

| Method                | Input                                                                                | Output   | Behavior                                                              | Errors                                   |
| --------------------- | ------------------------------------------------------------------------------------ | -------- | --------------------------------------------------------------------- | ---------------------------------------- |
| `buildSessionContext` | `sessionID: SessionID, opts?: { max_context_chars?: number; max_messages?: number }` | `string` | Fetches messages from single session, formats as role-tagged markdown | Returns `""` if session has < 3 messages |

### `Command.Info` — Extended Type

| Field             | Type                                                                                           | Behavior                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `dynamicTemplate` | `(input: { sessionID: SessionID; arguments: string }) => string \| Promise<string>` (optional) | When present, `SessionPrompt.command` calls this instead of resolving `template` |

### `auto-dream.ts` — New Constant

| Constant               | Type     | Value                                                                            |
| ---------------------- | -------- | -------------------------------------------------------------------------------- |
| `DISTILL_SESSION_TASK` | `string` | `DISTILL_TASK` with "recurring 2+" criterion replaced by single-session guidance |

### `SessionPrompt.command` — Modified Dispatch

| Step                | Current Behavior                                  | New Behavior                                                                                                                          |
| ------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Template resolution | `yield* Effect.promise(async () => cmd.template)` | If `cmd.dynamicTemplate`: call it with `{sessionID: input.sessionID, arguments: input.arguments}`, await result. Else: existing path. |

## Data Flow

| Step | Component               | Action                                                                             | Next                    |
| ---- | ----------------------- | ---------------------------------------------------------------------------------- | ----------------------- |
| 1    | TUI / CLI               | User types `/distill this`                                                         | SessionPrompt.command   |
| 2    | SessionPrompt.command   | Resolves `cmd = commands["distill"]`                                               | dynamicTemplate check   |
| 3    | SessionPrompt.command   | `cmd.dynamicTemplate` exists → call with `{sessionID, arguments: "this"}`          | distill dynamicTemplate |
| 4    | distill dynamicTemplate | `"this"` detected → `buildSessionContext(sessionID, cfg.distill)`                  | context string          |
| 5    | buildSessionContext     | `MessageV2.page({sessionID, limit: maxMessages})` → extract text → format markdown | return context          |
| 6    | distill dynamicTemplate | Prepend `DISTILL_SESSION_TASK` to context                                          | return full template    |
| 7    | SessionPrompt.command   | Template resolved → placeholder substitution, agent dispatch                       | distill agent runs      |

**Error Flows**:

- **Session has < 3 messages**: `buildSessionContext` returns `""`. `dynamicTemplate` returns only `DISTILL_SESSION_TASK` with no context appended. Distill agent sees empty history and outputs "No skills worth creating".
- **Session not found**: `MessageV2.page` throws `NotFoundError`. Propagates up through `SessionPrompt.command`'s Effect pipeline. Published as `Session.Event.Error`.
- **`/distill` with no args**: `dynamicTemplate` receives `arguments: ""`. Trimmed string is not `"this"` → falls through to existing `buildContext(days, opts)` path. Backward compatible.

## Data Model

No schema changes. Feature reads existing data:

| Entity       | Fields Used                        | Access Pattern                          |
| ------------ | ---------------------------------- | --------------------------------------- |
| MessageTable | `session_id`, `time_created`, `id` | `MessageV2.page({sessionID, limit})`    |
| PartTable    | (joined by `MessageV2.page`)       | Text parts extracted via `extractText`  |
| SessionTable | `id`                               | Existence check inside `MessageV2.page` |

## Decisions

| Decision                               | Choice                                             | Reason                                              | Alternatives                          | Tradeoffs                                                         |
| -------------------------------------- | -------------------------------------------------- | --------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------- |
| Extension mechanism                    | `dynamicTemplate` optional field                   | Backward compat, no changes to existing commands    | Overload `template` getter with args  | Extra field vs type complexity on existing getter                 |
| Argument detection                     | Literal `"this"` match (trimmed, case-insensitive) | Simple, unambiguous, no parser needed               | Regex, `--session` flag               | Limited to one keyword; extensible later if needed                |
| Prompt variant                         | Separate `DISTILL_SESSION_TASK` const              | Clear separation, no runtime string manipulation    | Conditional string concat in template | Two constants to maintain vs one with branching                   |
| Min message threshold                  | Return `""` on < 3 messages                        | Prevents meaningless distill on near-empty sessions | Throw error, return toast             | Silent degradation vs explicit user feedback                      |
| Reuse `extractText` / `MessageV2.page` | Same functions as `buildContext`                   | Consistent output format, no duplication            | New extraction logic                  | Coupled to existing format; changes to `buildContext` affect both |

## Risks

| Risk                                     | Impact                                          | Likelihood | Mitigation                                                   |
| ---------------------------------------- | ----------------------------------------------- | ---------- | ------------------------------------------------------------ |
| `dynamicTemplate` type not in zod schema | Runtime-only field, won't validate via schema   | Low        | Internal-only field, documented in type override             |
| `"this"` conflicts with future arguments | Would need migration if distill gains more args | Low        | Reserve `"this"` as keyword; future args use `--flag` style  |
| Large session overflows context window   | LLM truncation or error                         | Med        | `max_context_chars` cap (default 100k) inherited from config |
| Current session still in-progress        | Partial/incomplete context extracted            | Med        | Acceptable — user explicitly triggers; can re-run later      |

## Test Plan

### Unit Tests

**`buildSessionContext`** (`test/session/dream-spawn.test.ts`):

- Happy path: session with 10+ messages → returns markdown with role-tagged entries
- Empty session (0 messages): returns `""`
- Below threshold (< 3 messages): returns `""`
- Respects `max_messages` limit: truncates at N messages
- Respects `max_context_chars` limit: stops accumulating at char cap
- Skips synthetic parts (same behavior as `extractText` in `buildContext`)
- Uses summary when available (user messages with `info.summary`)

**`dynamicTemplate` dispatch** (`test/session/prompt.test.ts`):

- Command with `dynamicTemplate` → `dynamicTemplate` called, `template` not resolved
- Command without `dynamicTemplate` → existing `template` getter used (backward compat)
- `dynamicTemplate` receives correct `sessionID` and `arguments`

### Integration Tests

**`/distill this` end-to-end** (`test/command/distill.test.ts`):

- `/distill this` → triggers `buildSessionContext` with current session ID
- `/distill this` on session with < 3 messages → agent receives task without context
- `/distill` (no args) → triggers existing `buildContext` multi-session path
- `/distill other` → falls through to multi-session path (non-"this" argument)

### Edge Cases

- `/distill THIS` (uppercase) → case-insensitive match, treated as single-session
- `/distill  this  ` (whitespace) → trimmed, matches
- Auto-distill path unchanged (uses `DreamSpawn.distill`, not command dispatch)

### Non-Functional Tests

- **Performance**: `buildSessionContext` on 200-message session completes in < 100ms (single SQLite query + string ops)
- **No regressions**: existing `/distill` without args produces identical output as before

## File Change Map

| File                                 | Change                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| `src/session/dream-spawn.ts`         | Add `buildSessionContext(sessionID, opts?)` export                                |
| `src/session/auto-dream.ts`          | Add `DISTILL_SESSION_TASK` constant                                               |
| `src/command/index.ts`               | Add `dynamicTemplate` to distill command registration; update `Command.Info` type |
| `src/session/prompt.ts` (~line 2206) | Check `cmd.dynamicTemplate`, call if present before resolving `cmd.template`      |
| `test/session/dream-spawn.test.ts`   | Tests for `buildSessionContext`                                                   |
| `test/command/distill.test.ts`       | Integration tests for `/distill this` dispatch                                    |
