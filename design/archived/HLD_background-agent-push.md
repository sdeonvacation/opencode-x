# HLD: Background Agent Push (Leader+D Detach)

Source plan: `/Users/i570749/.claude/plans/delightful-wiggling-horizon.md`
Source requirement: `/Users/i570749/opencode-x/requirements/REQUIREMENT_background-agent-push.md`

## Tech Stack

- Language: TypeScript (Bun runtime)
- Framework: Effect 4 (services / layers / fibers / Deferred)
- Server: existing opencode HTTP route layer (`server/routes/session.ts`)
- SDK: `@hey-api/openapi-ts`-generated client (`packages/sdk/js`)
- TUI: SolidJS components in `packages/opencode/src/cli/cmd/tui`
- Persistence: in-memory only (process-scoped); no new persistence layer
- Feature flag: `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`

## Scope assumptions

- Detach is **same-session** in v1: the detached run's `sessionID` equals the
  user's foreground `sessionID`. The detached transcript is the session's
  transcript. Cross-session is explicitly out of scope (see §9).
- Notification policy is **passive**: completion surfaces a toast and a
  `<system-reminder>` on the next user turn. No autonomous resumption, no
  synthetic prompt fired by the server. Codified as architectural invariant.
- Rollout is gated behind `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`.
- Detach is implemented as **Option B (Detach-by-Wrap)**. Option A
  (always-bg) is explicitly out of scope.

---

## 1. Architecture overview

### Components at a glance

| Component | Kind | Responsibility |
|-----------|------|----------------|
| `SessionRunState.peek` | new accessor (existing service) | Read-only handle to the existing per-session `Runner` (no mutation, no fiber ownership transfer). |
| `SessionPrompt.background` | new RPC method | Detach the in-flight run by registering a `BackgroundJob` that *awaits* the runner's pending `Deferred`; publishes TUI events; queues a reminder note on completion. |
| `BackgroundJob` (existing) | reused | Tracks `{info, done, fiber}`. Used as the "wrapper" that watches the existing run from the outside. |
| `DetachedNotes` | new module (`session/detached-notes.ts`) | In-memory `Map<SessionID, Note[]>` with `queue` / `drain`. Drain-on-read. |
| `prompt-reminders.insertReminders` (existing) | extended | At end of function, drains `DetachedNotes` for the session and appends a `<system-reminder>` text part to the *new* user message only. |
| `POST /:sessionID/background` | new HTTP route | Mirror of the abort route. Calls `SessionPrompt.background`. |
| SDK `client.session.background` | regenerated | Mirrors existing `abort`. |
| TUI chord `session.background` | new command entry | Default `<leader> d`. Calls SDK; updates TUI-local detached set; toasts. |
| TUI detached-set signal | new module-scope signal | `Set<SessionID>` flagging which sessions the user has detached from the local TUI's POV. Used to (a) unblock prompt input cursor and (b) gate submission of new prompts to a still-running detached session. |
| Reuse: `BackgroundTaskUpdate` listener | existing (`prompt/index.tsx`) | Drives badge increment + toast. No change needed beyond emitting events from the new RPC. |
| Reuse: `app-event-listeners.ts` ToastShow wiring | existing | Toasts on completion. |

### ASCII diagram

```
                          ┌────────────────────────────────────────────────┐
                          │              opencode server (Effect)          │
                          │                                                │
                          │  ┌──────────────┐   ┌────────────────────────┐ │
                          │  │ SessionPrompt│──►│ SessionRunState.peek   │ │
                          │  │ .background  │   │   → Runner (existing)  │ │
                          │  └──────┬───────┘   │   - state._tag         │ │
                          │         │           │   - state.run.done     │ │
                          │         │ register  └────────────────────────┘ │
                          │         ▼                                      │
                          │  ┌──────────────┐   awaits                     │
                          │  │ BackgroundJob│ ──── Deferred.await ────────►│  (runner.state.run.done)
                          │  │   .start     │                              │
                          │  └──────┬───────┘                              │
                          │         │ on resolve / interrupt /             │
                          │         │ failure (matchCauseEffect)           │
                          │         ▼                                      │
                          │   Effect.tap chain:                            │
                          │    1. Bus.publish BackgroundTaskUpdate         │
                          │    2. Bus.publish ToastShow                    │
                          │    3. DetachedNotes.queue(sessionID, …)        │
                          │                                                │
                          │  Next user turn → SessionPrompt.prompt →       │
                          │   insertReminders(deps, input) →               │
                          │     DetachedNotes.drain(sessionID) →           │
                          │     append <system-reminder> to user msg       │
                          └────────────────────────────────────────────────┘
                                            ▲                  │
                                  HTTP RPC  │ Bus / SSE         ▼
                          ┌─────────────────┴───────────────────────────────┐
                          │                       TUI                        │
                          │  leader+d ──► sdk.client.session.background()    │
                          │  detachedSet.add(sessionID)                      │
                          │  prompt input unblocked, badge++, toast          │
                          │                                                  │
                          │  on session.status idle      → detachedSet.del   │
                          │  on BackgroundTaskUpdate(*)  → existing wiring   │
                          └──────────────────────────────────────────────────┘
```

### Lifecycle

1. User triggers chord while runner is `Running`.
2. RPC peeks the runner, validates `state._tag === "Running"`, registers a
   `BackgroundJob` with `id = sessionID` whose `run` Effect is
   `Deferred.await(runner.state.run.done)` plus the publish chain.
3. Underlying `Runner` continues to own and drive its own fiber.
4. When the run's `Deferred` resolves (success / failure / interrupt), the
   `BackgroundJob.start` `matchCauseEffect` maps it to
   `completed | error | cancelled`, emits TUI events, queues a `DetachedNote`.
5. On the user's next prompt to the same session, `insertReminders` drains the
   note(s) and appends a `<system-reminder>` to the user message.

---

## 2. Component breakdown

### 2.1 `SessionPrompt.background(sessionID)`

- **File**: `packages/opencode/src/session/prompt.ts` (new sibling to `cancel`)
- **Responsibility**: Detach RPC. Idempotent. Does *not* alter the runner.
- **Dependencies**: `SessionRunState` (for `peek`), `BackgroundJob` (for `start`),
  `Bus` (for event publish), `DetachedNotes` (for queue), `Flag`.
- **Interface (TS)**:

  ```ts
  export interface Interface {
    // …existing…
    readonly background: (sessionID: SessionID) => Effect.Effect<boolean>
  }

  export async function background(sessionID: SessionID): Promise<boolean>
  ```

  Returns `true` when a `BackgroundJob` was registered (or already running for
  this `sessionID`), `false` when there is nothing to detach (idle / unknown
  session / flag off).

- **Behavior**:
  1. If `!Flag.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` → return `false`.
  2. `runner = yield* state.peek(sessionID)`. If absent → return `false`.
     Otherwise three-way branch on `runner.state._tag`:
     - `"Running"` → proceed (happy path; await `state.run.done`).
     - `"ShellThenRun"` → proceed (await `state.run.done`; the run's
       `Deferred` resolves after `finishShell` fires the actual run).
     - `"Shell"` or `"Idle"` (or anything else) → return `false`. v1 gap;
       see §5.
  3. `title = yield* sessions.title(sessionID)` (best-effort; falls back to a
     truncated `sessionID`).
  4. Build `run: Effect<string, unknown>` =
     `Deferred.await(runner.state.run.done)` then `Effect.map` to a one-line
     summary derived from the most recent assistant message text (last 200
     chars). Wrap so `Cause.hasInterruptsOnly` → `cancelled`.
  5. `BackgroundJob.start({ id: sessionID, type: "session.background", title,
     metadata: { sessionID }, run })`. Per existing semantics, if a job with
     the same id is already `running`, `start` short-circuits (idempotent).
  6. Wrap the registered run with `Effect.tap` to publish:
     - `Bus.publish(TuiEvent.BackgroundTaskUpdate, { sessionID, taskID:
       sessionID, title, state })`
     - `Bus.publish(TuiEvent.ToastShow, { variant, message })`
     - `DetachedNotes.queue(sessionID, state, summary)`

     The publish chain is layered *inside* the supplied `run` so it executes
     within the job-tracked scope (so `BackgroundJob`'s `matchCauseEffect`
     drives state transitions before/around it).
  7. Return `true`.

- **Marker**: Wrap the new function body and Interface field with
  `// fork: background-detach (#FORK)` markers per upstream-rebase invariants
  (§8).

### 2.2 `SessionRunState.peek(sessionID)`

- **File**: `packages/opencode/src/session/run-state.ts`
- **Responsibility**: Expose the existing per-session `Runner` for read-only
  inspection. Does *not* call `runner(sessionID, onInterrupt)` (which would
  *create* a runner). Reads directly from the `runners` Map inside the
  `InstanceState`.
- **Dependencies**: none beyond the existing `InstanceState`.
- **Interface (TS)** — appended at the *end* of `Interface` and `Service.of` for
  rebase stability:

  ```ts
  readonly peek: (sessionID: SessionID) => Effect.Effect<Runner<MessageV2.WithParts> | undefined>
  ```

- **Why a new accessor instead of reusing `assertNotBusy`**: callers need the
  `Runner` handle (to read `runner.state.run.done`), not just a busy bit.
  `peek` returns `undefined` when no runner exists for the session.

### 2.3 `BackgroundJob` reuse — fiber ownership rules

- The detached run continues to be driven by the existing `Runner` fiber forked
  into `SessionRunState`'s scope (see `run-state.ts` and `runner.ts:startRun`).
- The `BackgroundJob` registered by `SessionPrompt.background` does **not**
  call `Fiber.fromEffect`-wrap the running fiber. It runs its own small fiber
  (forked into `BackgroundJob`'s scope) whose only work is `Deferred.await` on
  the runner's `run.done`.
- Result: there is exactly one fiber driving the model loop (the runner's
  fiber). The `BackgroundJob`'s fiber is a passive watcher.
- `BackgroundJob.cancel(sessionID)` is **not** the recommended cancellation
  path. Use `SessionPrompt.cancel(sessionID)` → `SessionRunState.cancel`,
  which interrupts the runner; the watcher then resolves via the runner's
  `Deferred.fail(Cancelled)` chain, and `Cause.hasInterruptsOnly` maps it to
  `cancelled` in `BackgroundJob.start`'s `matchCauseEffect`.

### 2.4 `DetachedNotes` (new file)

- **File**: `packages/opencode/src/session/detached-notes.ts`
- **Module-level state**: `const notes = new Map<SessionID, Note[]>()`
- **Type**:

  ```ts
  export type Note = {
    state: "completed" | "error" | "cancelled"
    summary: string
  }

  export namespace DetachedNotes {
    export const queue: (sessionID: SessionID, state: Note["state"], summary: string) => void
    export const drain: (sessionID: SessionID) => Note[]
    export const peek: (sessionID: SessionID) => readonly Note[]   // tests only
  }
  ```

- **Invariants**:
  - `drain` returns the queued notes and clears the entry. Drain-on-read is
    the cache-safety guarantee (§6).
  - Notes are not persisted across process restart (matches v1 non-goals).
  - The map is process-global, intentionally simple. No locks needed:
    `insertReminders` runs single-threaded per session under Effect.
- **Unbounded-growth note**: if the user detaches a session and never
  returns (no further submissions), notes accumulate in the map for the
  process lifetime. Acceptable in v1 because notes are tiny (one
  `state` enum + ≤200 char summary) and the map is process-scoped — every
  restart wipes it. If this becomes a problem, a per-session cap (e.g.,
  retain only the most recent N notes per `sessionID`) is a one-line fix
  inside `queue`.

### 2.5 `prompt-reminders.ts` extension

- **File**: `packages/opencode/src/session/prompt-reminders.ts`
- **Edit scope**: One additional block *immediately before* the final
  `return { messages, changed }` line (most stable diff anchor).
- **Logic**:

  ```ts
  // fork: background-detach (#FORK) — begin
  const pending = DetachedNotes.drain(input.session.id)
  if (pending.length) {
    const userMessage = input.messages.findLast((m) => m.info.role === "user")
    if (userMessage) {
      for (const note of pending) {
        userMessage.parts.push({
          id: PartID.ascending(),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text: REMINDER_TEMPLATE(note.state),
          synthetic: true,
        })
      }
      changed = true
    }
  }
  // fork: background-detach (#FORK) — end
  ```

- **Reminder text** (deterministic given `state`). The template is keyed on
  the literal state strings `"completed"`, `"error"`, `"cancelled"` (exact
  casing, lowercased). `REMINDER_TEMPLATE(state)` returns:

  ```
  <system-reminder>
  Background task completed. The prior assistant turn (which the user detached) finished with status: completed. Its full output is the most recent assistant message in this conversation. Continue based on the user's next instruction. Do not autonomously act on the result unless the user asks.
  </system-reminder>
  ```

  …with the `completed` token replaced by `error` or `cancelled` for the
  other two states. No timestamps, ids, durations, or counters. Same `state`
  always produces byte-identical text.

- **Event schema extension required**: `TuiEvent.BackgroundTaskUpdate` in
  `packages/opencode/src/cli/cmd/tui/event.ts` currently declares
  `state: z.enum(["running", "completed", "error"])`. This HLD requires
  `"cancelled"` as a fourth variant so interrupted detached runs can be
  reported faithfully (see §3.3, §7). Extend the enum to
  `z.enum(["running", "completed", "error", "cancelled"])` as part of this
  feature. Append the new variant at the *end* of the enum for
  upstream-rebase trailing-position safety.

### 2.6 `POST /:sessionID/background` route

- **File**: `packages/opencode/src/server/routes/session.ts`
- **Mirror**: existing abort route (line ~415).
- **Operation id**: `session.background` (drives SDK method name).
- **Response schema**: `{ success: boolean }` (mirrors abort's shape).
- **Error mapping**: returns `success: false` on `Flag` off or no runner;
  500 only on unexpected.

### 2.7 SDK regeneration

- Run: `bun run --cwd packages/sdk/js generate` (verify exact script in that
  package's `package.json`).
- Surface (mirror of `abort` at `sdk.gen.ts:2114`):

  ```ts
  client.session.background(opts: { path: { sessionID: string } }): Promise<{ success: boolean }>
  ```

- Generated files are *fully derived*; never hand-edit. Rebase strategy: drop
  the generated dir's conflicts, regen.

### 2.8 TUI chord + state

- **File**: `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`
- **New command entry** placed *immediately after* `session.interrupt`:

  ```ts
  {
    value: "session.background",
    keybind: "session_background",
    title: "Push to background",
    enabled: () => status().type !== "idle" && !detachedSet().has(sessionID),
    onSelect: async () => {
      const ok = await sdk.client.session.background({ path: { sessionID } })
      if (ok?.success) {
        setDetachedSet((s) => new Set(s).add(sessionID))
        toast({ variant: "info", message: "Detached. Will notify on completion." })
      } else {
        toast({ variant: "warning", message: "Cannot detach: not running or feature disabled." })
      }
    },
  }
  ```

- **Detached-set signal**: module-scope
  `const [detachedSet, setDetachedSet] = createSignal<Set<SessionID>>(new Set())`.
  Lives in this component. If a sibling component needs it, hoist into
  `tui/context/sync.tsx` later (out of scope for v1).
- **Prompt input gating** (input box logic):
  - Treat `detachedSet().has(sessionID)` as "session is idle" for the input
    cursor only — input remains enabled.
  - On submit, if `detachedSet().has(sessionID)`, short-circuit with toast
    `"Session has detached run; wait for completion or switch sessions."`.
- **Cleanup**: when `session.status` event reports `idle` for the session,
  remove from set. When user submits a new prompt successfully (after toast
  clears), remove from set (allows re-detach later).
- **Existing wiring reused** (`prompt/index.tsx:209` BackgroundTaskUpdate
  listener): no change. Server emits the same event the `task` tool emits
  today (`tool/task.ts:inject`), so the badge counter / toast pipeline picks
  it up automatically.

### 2.9 Keybind registration

- **File**: `packages/opencode/src/cli/cmd/tui/context/keybind.tsx` (and the
  `TuiConfig` keybinds schema).
- Add `session_background` key (default `<leader>+d`) at the *end* of the
  keybind keys block — trailing position survives upstream additions cleanly.
- Leader chord decay (2s) is handled by existing `leader(active)` in
  `keybind.tsx`; no new chord state machine.

### 2.10 Parent-side tracking via todo list

Surfacing a detached run's lifecycle to the **parent agent** via the
existing `todoread` / `todowrite` tools. Goal: parent has durable visibility
into background work without re-querying `task_status` or scanning
scrollback. Operator-visible too (todos render in TUI).

#### Lifecycle

| Phase | Trigger | Todo state mutation |
|-------|---------|---------------------|
| Detach | User presses `<leader>+d` | Server appends a todo: `{ content: "[bg] <session title>", status: "in_progress", id: <sessionID> }`. Todo `id` reuses `sessionID` for idempotency (same as `BackgroundJob.id`). |
| Completion | `BackgroundJob` resolves `completed` | Todo status flips `in_progress` → `completed` (auto). Reminder text instructs the agent to verify output and confirm or reopen. |
| Failure | `BackgroundJob` resolves `error` | Todo stays `in_progress` with content prefix updated to `[bg failed] …`. Reminder asks agent to triage. |
| Cancellation (Esc) | `BackgroundJob` resolves `cancelled` | Todo deleted (operator stopped it; no further action expected). Reminder still fires with `state: "cancelled"` for context. |
| Manual verification | Agent reads result, decides it's good | Agent calls `todowrite` to mark the todo `completed` (closes the loop). |
| Manual reopen | Agent finds output broken / partial | Agent calls `todowrite` to keep todo `in_progress` and writes a follow-up todo describing remediation. |

Distinction matters: **server auto-flips `in_progress → completed` on
`BackgroundJob` success** (the *task ran to completion*), but the agent has
the final say on whether the *outcome was correct*. If the agent decides the
output is wrong, it re-marks the todo `in_progress` (or deletes and recreates
with a clearer description) per existing `todowrite` semantics.

#### Implementation sketch

- **File**: `packages/opencode/src/session/detached-todos.ts` (new). Thin
  adapter on top of the existing todo store (find the canonical accessor —
  likely `tool/todoread.ts` / `tool/todowrite.ts` or a `Todo.Service`).
  Exports:
  ```ts
  export namespace DetachedTodos {
    export const open: (sessionID: SessionID, title: string) => Effect.Effect<void>
    export const markCompleted: (sessionID: SessionID) => Effect.Effect<void>
    export const markFailed: (sessionID: SessionID, reason: string) => Effect.Effect<void>
    export const remove: (sessionID: SessionID) => Effect.Effect<void>
  }
  ```
  Uses `sessionID` as the todo `id` so retries / double-detach are
  idempotent. All four functions are no-ops if the todo doesn't exist
  (defensive — handles late events after operator deleted the todo).

- **Hook into `SessionPrompt.background`** (§2.1):
  - Step 5.5 (between job registration and watcher publish chain): `yield*
    DetachedTodos.open(sessionID, title)`.

- **Hook into watcher publish chain** (§2.1 step 6):
  - On `state === "completed"`: `yield* DetachedTodos.markCompleted(sessionID)`.
  - On `state === "error"`: `yield* DetachedTodos.markFailed(sessionID, summary)`.
  - On `state === "cancelled"`: `yield* DetachedTodos.remove(sessionID)`.

- **Reminder template (§2.5) extended** to point the agent at the todo:

  ```
  <system-reminder>
  Background task finished with status: completed. Its full output is the most recent assistant message in this conversation. A todo with id "<sessionID>" tracks this run. After verifying the output, mark the todo completed via todowrite. If the output is wrong or partial, keep the todo open and add a follow-up todo describing remediation. Do not autonomously act on the result unless the user asks.
  </system-reminder>
  ```

  Same wording for `error`, except instruct triage. For `cancelled`, omit
  the todo reference (it was removed) and state operator stopped the run.

  Determinism preserved: text is keyed only on `state` enum. The
  `<sessionID>` token is interpolated, but `sessionID` is part of the
  per-turn message id space anyway and is *only* placed in the *new* user
  message — does not enter cached prefix (C1, C2 hold).

#### Edge cases

| Case | Handling |
|------|----------|
| Operator deletes the todo manually before completion | `markCompleted` is a no-op (id not found). Reminder still fires; agent reads `[deleted]` from `todoread` and infers state. |
| Agent never returns to session | Todo persists in todo store as `in_progress` (or `[bg failed]`). Visible in TUI todos panel. Operator can clean up. |
| Two concurrent detaches in different sessions | Independent todos keyed by their `sessionID`s. No collision. |
| Same-session double detach (idempotent BackgroundJob) | `DetachedTodos.open` no-ops if todo with that id exists. |
| App restart | Todos persist via existing todo storage (it's already durable; verify during impl). `BackgroundJob` does not — so on restart the todo will be stuck `in_progress` with no live job. v1 acceptable: operator/agent observe stale and clean up. v1.1: scan stale `[bg]` todos at startup and mark `[bg interrupted]`. |

#### File-map delta

| File | Action |
|------|--------|
| `packages/opencode/src/session/detached-todos.ts` | new |
| `packages/opencode/src/session/prompt.ts` (§2.1) | additionally calls `DetachedTodos.open` + `markCompleted/Failed/remove` |
| `packages/opencode/src/session/prompt-reminders.ts` (§2.5) | reminder template includes todo id |

#### Non-goals (still v1)

- Bidirectional sync (agent's `todowrite` does *not* feed back into
  `BackgroundJob`'s status).
- Cross-session todos (parent-of-subagent case still v1.1+).

---

## 3. Data flow

### 3.1 Detach happy path

```
User    TUI                    Server                    BackgroundJob       Runner
 │       │                      │                         │                   │
 │ <leader>d                    │                         │                   │
 │──────►│ POST /:id/background │                         │                   │
 │       │─────────────────────►│ SessionPrompt.background│                   │
 │       │                      │── peek(sid) ────────────────────────────────►│
 │       │                      │◄──────────────── runner (state=Running) ────│
 │       │                      │── start({id:sid, run: Deferred.await(...)})►│ fork watcher
 │       │                      │                         │── await(run.done)─►│ (no change)
 │       │◄─── 200 success ─────│                         │                   │
 │ ◄─unblock input + toast ─────│                         │                   │
```

### 3.2 Completion → toast → reminder

```
Runner          BackgroundJob.start             Bus / TUI          DetachedNotes
 │ run.done resolves (success)                                       │
 │──────────────────────►│ matchCauseEffect.onSuccess(output)        │
 │                       │   tap: publish BackgroundTaskUpdate(completed)
 │                       │   tap: publish ToastShow                  │
 │                       │   tap: queue(sid, "completed", summary)   │
 │                       │                                           │
                          ─── BackgroundJob.finish(completed) ──►   ──► entry persisted

Later: user submits new prompt
 ─► SessionPrompt.prompt → insertReminders(deps, input) → drain(sid)
   appends <system-reminder> text part to the new user message
```

### 3.3 Interrupt-after-detach

```
User Esc (session_interrupt; default keybind in config.ts:n="escape")
  → SDK abort → SessionPrompt.cancel
  → SessionRunState.cancel → Runner.cancel
    → Fiber.interrupt(run.fiber) → run.done fails with Cancelled
      → watcher's Deferred.await fails (interrupt cause)
        → BackgroundJob.start.matchCauseEffect.onFailure
          → Cause.hasInterruptsOnly → finish(id, "cancelled", { error })
            → tap publishes ToastShow + queues note(state="cancelled")
```

Note: `Ctrl+C` is `app_exit` (kills the whole TUI), not `session_interrupt`.
Esc is the per-session cancel. Holds for detached runs too — user navigates
back to the detached session and presses Esc.

### 3.4 Quit while detached

```
App shutdown → InstanceState scope finalizer
  → SessionRunState scope finalizer iterates runners, runner.cancel each
    → Runner.cancel interrupts fiber
      → processor.ts Effect.onInterrupt path persists final assistant message
        (existing pattern, unchanged)
  → BackgroundJob scope finalizer interrupts watcher (irrelevant; Deferred
    already resolved with Cancelled cause)
```

No new code required for shutdown; existing finalizers cover it.

### 3.5 Primary submits new prompt to detached session

```
User types in detached session, hits Enter
  → submit handler checks detachedSet().has(sessionID)
    → true → toast "Session has detached run; wait or switch sessions"
      → prompt is NOT sent to server. Submission short-circuited.
```

When the detached run finishes and the session goes idle, `detachedSet`
clears, and submissions resume normally. The next prompt's `insertReminders`
call drains pending notes.

---

## 4. Interfaces / type signatures

```ts
// session/run-state.ts
namespace SessionRunState {
  interface Interface {
    // existing methods…
    readonly peek: (sessionID: SessionID) => Effect.Effect<Runner<MessageV2.WithParts> | undefined>
  }
}

// session/prompt.ts
namespace SessionPrompt {
  interface Interface {
    // existing methods…
    readonly background: (sessionID: SessionID) => Effect.Effect<boolean>
  }
  export function background(sessionID: SessionID): Promise<boolean>
}

// session/detached-notes.ts
namespace DetachedNotes {
  type Note = { state: "completed" | "error" | "cancelled"; summary: string }
  function queue(sessionID: SessionID, state: Note["state"], summary: string): void
  function drain(sessionID: SessionID): Note[]
  function peek(sessionID: SessionID): readonly Note[]   // tests only
}

// HTTP route (server/routes/session.ts) — operation id: session.background
//   POST /:sessionID/background  →  { success: boolean }

// SDK (packages/sdk/js/src/v2/gen/sdk.gen.ts) — auto-generated
client.session.background(opts: { path: { sessionID: string } }): Promise<{ success: boolean }>

// TuiConfig keybinds (cli/cmd/tui/context/keybind.tsx)
type KeybindKey = /* …existing union… */ | "session_background"
// default: "session_background": ["<leader>", "d"]

// TUI prompt component (cli/cmd/tui/component/prompt/index.tsx)
const [detachedSet, setDetachedSet] = createSignal<Set<SessionID>>(new Set())
```

---

## 5. Concurrency & fiber ownership

**Invariant**: the existing `Runner` retains exclusive fiber ownership of the
in-flight model loop. `BackgroundJob` only registers a passive watcher.

### Runner state at detach time

| Runner state    | `peek` response                        | Behavior                                                                 |
|-----------------|----------------------------------------|--------------------------------------------------------------------------|
| `Idle`          | runner present or undefined            | `state._tag !== "Running"` → return `false`. Chord disabled in TUI.      |
| `Running`       | runner with `run.done`                 | Watcher awaits `Deferred.await(runner.state.run.done)`. Happy path.      |
| `Shell`         | runner; no `run.done` yet              | Treated as "not detachable in v1" → return `false`. Document as v1 gap.  |
| `ShellThenRun`  | runner with both `shell` and pending `run.done` | Acceptable: watcher awaits `Deferred.await(state.run.done)`. Runner's internal `finishShell` will start the actual run; the run's `Deferred` resolves later. |

V1 simplification: implement detach for `Running` and `ShellThenRun` only.
For `Shell` (rare in practice), return `false` and toast accordingly; lift in
a follow-up.

### What if the run's `Deferred` is never resolved?

Cannot occur under existing invariants:

- `Runner.startRun` attaches `Effect.onExit` which calls `finishRun` for *every*
  exit (success, failure, interrupt). `finishRun` calls `Deferred.done` /
  `Deferred.fail`. So `run.done` is always resolved exactly once during the
  fiber's lifetime.
- On scope shutdown, the runner fiber is interrupted; `Effect.onExit` still
  fires; `Deferred` resolves with `Cancelled`.

**No timeout** is required on the watcher's `Deferred.await`. Adding one would
risk a phantom "background task complete" toast while the run is still going.

### Idempotency: double-detach

`BackgroundJob.start` already checks `existing?.info.status === "running"` and
short-circuits with the existing `snapshot`. Because we use `id: sessionID`,
a second detach for the same session is a no-op — returns the existing job's
snapshot. The new RPC therefore returns `true` on a duplicate detach
(consistent with "yes, this session is detached") and TUI's `enabled` gate
prevents duplicate user triggers in normal flow anyway.

### Two distinct sessions detached concurrently

Independent `BackgroundJob` entries keyed by their `sessionID`s. Existing
`model_concurrency` semantics apply to the underlying runs — the watchers add
no concurrency pressure.

### Race: runner replaced after `peek`

If `runner` is removed from the Map after `peek` returns it (e.g., `onIdle`
deletes the entry), the watcher still holds a reference to the
`Deferred(run.done)`. Map deletion does not invalidate the captured `Deferred`.
Safe.

---

## 6. Provider caching safety (codified invariants)

These are architectural invariants. Violating any of them is a regression.

| # | Invariant | Enforcement |
|---|-----------|-------------|
| C1 | Reminder text is appended **only** to the most recent user message, never to system prompt, tool defs, assistant messages, or earlier user messages. | `insertReminders` finds `userMessage = messages.findLast(role === "user")`. The new block uses the same target. Code review + cache regression test. |
| C2 | Reminder is drained on first read; never re-injected on retries. | `DetachedNotes.drain` clears the entry atomically. Persisted user message keeps the reminder once; subsequent `insertReminders` calls observe `pending.length === 0` for that note. Cache regression test asserts byte-identical bytes for prefix on turn N+1. |
| C3 | Reminder text is deterministic given `(state)`. No timestamps, ids, durations, counters, or any volatile field. | Fixed template string keyed on `state`. Test asserts the template is a literal. |
| C4 | No new fields on `MessageV2` schemas. | Reminder is a plain `text` part with `synthetic: true`, identical structure to plan-mode reminder. No schema migration. |
| C5 | TUI-local `detachedSet` signal must not flow into any server-side request body. | Architectural: signal lives in `prompt/index.tsx` module scope; never serialized into RPC payloads. The detach RPC takes `sessionID` only. |
| C6 | No edits to `processor.ts`, `prompt`/`complete`/`loop`/`shell`/`command` bodies, or any model-facing serializer. | New code is a sibling export only. Code review + grep guard. |
| C7 | Cancelled vs natural completion writes different `finish` metadata on the assistant message — verify `finish` is not part of the model-facing prompt serializer. | One-time audit during impl; assertion test that toggling `finish` value does not change request bytes. |

### Cache regression test (outline)

`packages/opencode/test/session/background-detach-cache.test.ts`

1. Build a fixture session with deterministic system prompt + tool set.
2. **Control run**: drive the session through one user turn (turn 1)
   end-to-end without detach. Snapshot the exact `bodyBytes` of the
   provider-bound HTTP request for turn 2.
3. **Detached run**: same fixture; mid-turn-1 invoke
   `SessionPrompt.background(sessionID)`; let the run complete; drain the
   reminder by issuing turn 2. Snapshot turn 2's `bodyBytes`.
4. Compute byte-diff:
   - Assert: bytes of `system` + tool defs + `messages[0..N-2]` are
     **byte-identical** between control and detached runs.
   - Assert: the only diff is *within* `messages[N-1]` (the new user message),
     and that diff is exactly the reminder text part appended.
5. Run a third turn (turn 3) without further detach in both branches.
   Assert turn 3 bodies are byte-identical, confirming drain-on-read.

---

## 7. Failure modes

| Case | Trigger | Handling |
|------|---------|----------|
| Detach when session idle | `peek` returns runner with `state._tag === "Idle"` | RPC returns `false`. TUI chord `enabled` gate already prevents. Defense-in-depth. |
| Detach when no runner | `peek` returns `undefined` | RPC returns `false`. |
| Double detach | Second `background(sessionID)` while job is running | `BackgroundJob.start` short-circuits via `existing?.info.status === "running"`. RPC returns `true`. |
| Interrupt after detach | `Esc` (session_interrupt; default `escape`) → `SessionPrompt.cancel` → runner cancel | Runner Deferred fails with `Cancelled` → watcher `matchCauseEffect.onFailure` with `Cause.hasInterruptsOnly` → `finish(id, "cancelled")` → toast + reminder note `state: "cancelled"`. Note: `Ctrl+C` triggers `app_exit`, not session interrupt. |
| Quit while detached | App shutdown | `SessionRunState` scope finalizer cancels each runner; `processor.ts:Effect.onInterrupt` flushes final assistant message (existing); watcher resolves as cancelled; `BackgroundJob` scope finalizer cleans up. No data loss. |
| RPC failure (network / 5xx) | Server unreachable | TUI `onSelect` catches; toast `"Cannot detach: <reason>"`. Detached set unchanged. |
| Flag off | `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` not set | RPC returns `{ success: false }`. TUI shows `"Cannot detach: feature disabled"` toast. Chord still registered (allowed for discoverability). |
| `Shell` state | Runner is mid-shell, no run pending | RPC returns `false` (v1 limitation). |
| Runner replaced after `peek` | Race: peek returns handle, then `onIdle` deletes from map | Watcher awaits the captured `Deferred`. Map deletion does not invalidate it. Safe. |
| User submits to detached session | TUI submit → `detachedSet.has(sid)` true | Submit short-circuited with toast. No server call. |

---

## 8. Upstream-rebase invariants

This repo is `opencode-x`, a fork. Future rebases will pull conflicting
changes in hot files (`session/prompt.ts`, `routes/session.ts`,
`tui/component/prompt/index.tsx`, `run-state.ts`, `prompt-reminders.ts`,
`keybind.tsx`). Treat rebase safety as a first-class architectural concern.

### Anchor / fork-marker rules

- **New sibling, don't modify existing.** All new server code is added as new
  exported functions in existing files; no edits to existing function bodies
  except where strictly required (the `insertReminders` drain block).
- **Fork markers**: wrap each fork-only block with
  ```
  // fork: background-detach (#FORK) — begin
  …
  // fork: background-detach (#FORK) — end
  ```
  Required locations:
  - `SessionPrompt.background` definition + `Interface` field + `Service.of`
    binding
  - `peek` field in `SessionRunState`
  - `POST /:sessionID/background` route block in `routes/session.ts`
  - drain block in `insertReminders`
  - new command entry in `prompt/index.tsx`
  - keybind default and TuiConfig key in `keybind.tsx`
- **File-isolation strategy**:
  - Pending notes data structure → new file `detached-notes.ts`. Imports only,
    no edits, in `prompt-reminders.ts`.
  - Tests → new file `background-detach.test.ts` and
    `background-detach-cache.test.ts`. Never appended to existing test files.
  - SDK → never hand-edited; regenerate.
- **Trailing-position adds**:
  - `peek` is appended at the *end* of `SessionRunState.Interface` and
    `Service.of({...})`.
  - `session_background` keybind key is appended at the *end* of the keybind
    keys block (not alphabetized).
  - The drain block in `insertReminders` is anchored *immediately before* the
    final `return { messages, changed }`.
- **No renames / restructures.** `cancel`/`abort` naming inconsistencies are
  not touched. New names use the `background` prefix exclusively.
- **Atomic commit boundary.** Land as a single commit (or one commit per
  file at most), so `git revert` / `git cherry-pick` is mechanical.

### Pre-rebase operator checklist

1. `git log --oneline upstream/main..HEAD -- packages/opencode/src/session/prompt.ts` to identify all fork commits in the hot file.
2. Re-run `bun run --cwd packages/sdk/js generate` after rebase.
3. Re-run the verification suite. The canary is
   `packages/opencode/test/session/background-detach.test.ts` (chord +
   RPC surface) plus
   `packages/opencode/test/session/background-detach-cache.test.ts`
   (provider-cache invariants). If either fails post-rebase, the rebase
   silently broke the feature.

---

## 9. Non-goals (v1)

- Persistence of `BackgroundJob` / `DetachedNotes` across process restart.
- `Ctrl+X Ctrl+K` stop-all-bg chord (claude-code parity, future).
- Result-file path propagation for post-compaction recovery.
- `/bg` slash command alias.
- Server-side `detached: true` status variant on `SessionStatus` (we chose
  TUI-local store per requirement clarification — keeps server semantics
  byte-identical w.r.t. cache and message construction).
- Auto-resume / synthetic-prompt firing by primary agent on completion.
- Cross-session detach (where a subagent in a sibling session is detached
  back to the parent). Same-session is the v1 assumption. Cross-session would
  require: (a) reminder addressing by foreign sessionID, (b) `task_status`
  fallback for output retrieval, (c) decoupled toast routing. Out of scope.

---

## 10. Verification plan

### Build / typecheck

- `bun run --cwd packages/opencode typecheck`
- `bun run --cwd packages/sdk/js generate` (regen SDK from OpenAPI)
- `bun run --cwd packages/sdk/js typecheck`
- Confirm `cli/cmd/tui/event.ts` `BackgroundTaskUpdate.state` enum includes
  `"cancelled"` (schema extension from §2.5). Typecheck fails if the route
  publishes `"cancelled"` against the un-extended enum.

### Unit / integration tests

`packages/opencode/test/session/background-detach.test.ts`:

- **detach-while-running**: start `SessionPrompt.prompt` with a slow tool;
  while `status === "busy"`, call `SessionPrompt.background(sessionID)`;
  assert returns `true`, `BackgroundJob.list` contains entry, the underlying
  prompt promise still resolves; on resolution `BackgroundJob` info status is
  `completed`; `DetachedNotes.peek` shows one note with `state: "completed"`.
- **interrupt-after-detach**: detach, then `SessionPrompt.cancel(sessionID)`;
  assert `BackgroundJob` info status becomes `cancelled` and reminder note
  `state: "cancelled"`.
- **double-detach idempotency**: two consecutive `background(sessionID)` calls
  while running; assert only one job, both calls return `true`.
- **detach-when-idle**: assert returns `false`, no job created, no note.
- **flag-off**: with flag unset, assert returns `false` even when running.
- **drain semantics**: queue two notes, call `drain` twice; first returns
  both, second returns empty.
- **todo lifecycle**: detach → assert todo `[bg] …` exists `in_progress`
  with id == sessionID. Let run complete → assert todo flipped to
  `completed`. Detach + cancel → assert todo removed. Detach + error →
  assert todo content prefix becomes `[bg failed]`.

### Cache regression test

`packages/opencode/test/session/background-detach-cache.test.ts` — see §6
outline.

### Manual E2E checklist

Run TUI with `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=1`.

1. Start a long prompt (e.g. agent invoking a 30s tool).
2. Press `<leader>` then `d` within 2s. Verify:
   - Prompt input unblocks; cursor active.
   - `bgTasks` badge increments.
   - Toast: `"Detached. Will notify on completion."`
3. Try to submit a new prompt to the same session → blocked with toast
   `"Session has detached run; wait or switch sessions."`.
4. Switch to another session → unblocked. Switch back → still detached.
5. Wait for the underlying tool to finish. Verify:
   - Toast: `"Background task complete: <title>"`.
   - `bgTasks` decrements.
   - `detachedSet` clears (next submit succeeds).
6. Submit a new prompt in the originally-detached session. Inspect the
   provider request body (devtools / log). Verify:
   - The `<system-reminder>` text part is present in the new user message.
   - Submitting a *second* turn shows that the reminder is **not** repeated
     in the persisted history (drain-on-read).
7. Repeat with manual interrupt: detach, then press `Esc`. Verify toast
   `"Background task cancelled"` and reminder `state: "cancelled"` on next
   turn. (`Ctrl+C` would exit the app, not cancel the task.)
8. Repeat with `/quit` while detached. Verify clean shutdown, no orphan
   processes.

### Regression suite

- Existing `Esc` (`session_interrupt`) chord unchanged.
- Existing `Ctrl+C` (`app_exit`) behavior unchanged.
- `task` tool background path (`tool/task.ts`) untouched and still works.
- `session.abort` route untouched.
- Plan-mode reminder injection still works (drain block is appended *after*
  the existing plan-reminder logic).

---

## Decisions

| Decision | Reason | Alternatives |
|----------|--------|--------------|
| Detach-by-Wrap (Option B) | Reuses every existing primitive; no edits to perf-tuned `processor.ts` | Option A (always-bg) — invasive, deferred. |
| Watcher awaits `runner.state.run.done` (no fiber transfer) | Single fiber owner = no double-finalize, no double-interrupt | Wrap fiber via `Fiber.fromEffect` — duplicates ownership. |
| `BackgroundJob.id = sessionID` | Free idempotency via existing `existing?.info.status === "running"` check | Generate fresh job id — would require a separate map. |
| TUI-local detached set | Server-side `SessionStatus` stays byte-identical; no cache risk | Add `detached: true` to `SessionStatus` — perturbs server cache surface. |
| Drain-on-read for reminders | Cache safety: reminder appears in exactly one persisted user message | Always re-inject — divergent prefix on every later turn. |
| Passive notification (no auto-resume) | User detached to free attention; auto-resume contradicts intent; claude-code parity | Synthetic auto-prompt — out of v1; layerable later behind a config key. |
| Same-session in v1 | Detached transcript is already in scrollback; reminder is just a flag | Cross-session — needs output routing + `task_status` integration. Future. |
| New file for `DetachedNotes` | One-line import + drain in upstream file = trivial rebase | Inline in `prompt-reminders.ts` — fatter diff. |
| Parent tracks bg work via existing todo tool | Agent already reads/writes todos every turn; zero new tool surface; operator-visible | New "background panel" tool — duplicates todo semantics. |
| Server auto-flips todo on `BackgroundJob` success; agent confirms separately | Distinguishes "ran to completion" from "output verified"; matches user expectation | Server marks completed only after agent verification — never closes if agent never returns. |

## Risks

| Risk | Mitigation |
|------|------------|
| Reminder injection regresses Anthropic prompt cache | C1-C7 invariants + cache regression test. |
| Upstream rebase silently drops the chord | Fork markers (`// fork: background-detach`) + canary E2E checklist. |
| Watcher Deferred never resolves | Architecturally impossible: `Effect.onExit` in `Runner.startRun` always resolves the Deferred. Documented; no timeout band-aid. |
| Detach during `Shell` state | v1 returns `false` and toasts — explicitly documented gap. |
| Race: detached set retained after server idle | TUI listens to `session.status` idle event to clear; defense-in-depth: also clear on user submit success. |
| User confusion: input enabled but submit blocked | Toast on submit explains; future v1.1 can add inline marker `↓ background` instead. |
| `finish` metadata of cancelled run leaks into model prompt bytes | Audit during impl; assert `finish` is metadata-only in serializer (C7). |
| Stale todo after app restart | `BackgroundJob` is in-memory only; on restart, `[bg]` todos are orphaned `in_progress`. v1: operator/agent cleans up manually. v1.1: startup scan re-labels as `[bg interrupted]`. |
| Todo id collision with user-created todo | `DetachedTodos.open` keys on `sessionID` (ULID-shaped). Vanishingly unlikely to collide with user-typed todo ids. Defensive: if collision, prefix id with `bg:`. |

---

## File map (delta summary)

| File | Action |
|------|--------|
| `packages/opencode/src/session/run-state.ts` | edit: append `peek` to Interface and Service.of (trailing position) |
| `packages/opencode/src/session/prompt.ts` | edit: add `background` to Interface, layer impl, and module-level `async function background` (siblings of `cancel`) |
| `packages/opencode/src/session/prompt-reminders.ts` | edit: append drain block before final return |
| `packages/opencode/src/session/detached-notes.ts` | new file |
| `packages/opencode/src/session/detached-todos.ts` | new file (parent-tracking adapter over existing todo store) |
| `packages/opencode/src/server/routes/session.ts` | edit: append `POST /:sessionID/background` route |
| `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` | edit: append `session.background` command entry; module-scope `detachedSet` signal; submit-gate; status-idle clear |
| `packages/opencode/src/cli/cmd/tui/context/keybind.tsx` (+ TuiConfig schema) | edit: append `session_background` key, default `<leader>+d` |
| `packages/opencode/src/cli/cmd/tui/event.ts` | edit: extend `BackgroundTaskUpdate.state` enum with `"cancelled"` (trailing position) |
| `packages/sdk/js/src/v2/gen/*` | regen |
| `packages/opencode/test/session/background-detach.test.ts` | new |
| `packages/opencode/test/session/background-detach-cache.test.ts` | new |

End of HLD.
