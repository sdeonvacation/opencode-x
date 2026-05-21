# Requirement: Background Agent Push (Ctrl+B)

User-triggered "push-to-background" capability for in-flight agent runs in opencode. Frees primary agent to take new work while detached run continues. Detached run notifies primary on completion.

UX reference: claude-code's `Ctrl+B`.

## Findings

### opencode current state

- `BackgroundJob.Service` already exists: `packages/opencode/src/background/job.ts` — `list/get/start/wait/cancel`, jobs are `{info, done: Deferred, fiber: Fiber}` in `SynchronizedRef<Map>`. Process-scoped, no restart persistence.
- Tool `task` has `background:true` branch behind `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`: `tool/task.ts`. Returns immediately, advises parent to call `task_status`.
- Tool `task_status` polls/waits via `BackgroundJob.wait` (Deferred-backed): `tool/task_status.ts`.
- Bus events already defined: `TuiEvent.BackgroundTaskUpdate {sessionID, taskID, title, state}`, `TuiEvent.ToastShow` — `cli/cmd/tui/event.ts:54-66`.
- TUI chord pattern (model for Ctrl+B): `cli/cmd/tui/component/prompt/index.tsx:262-378` — `store.interrupt` counter, double-press `session_interrupt` keybind, decays after timeout. Calls `sdk.client.session.abort({sessionID})`.

### claude-code hints (`~/.claude/cache/changelog.md`)

- Ctrl+B fires only when foreground task can be backgrounded (line 1409).
- `/bg` slash command + `←←`/`Esc-Esc` chord both detach (lines 129, 171).
- Killing bg agent preserves partial results (line 1629).
- Double-Esc within 3s kills all bg agents; `Ctrl+X Ctrl+K` stops all bg (lines 1431, 2064, 2107).
- Completion notification carries output file path so parent recovers after compaction (line 1778).
- Polling-based; "task completed between polling intervals" race (line 1465) — same as opencode.

## Recommended Architecture: Option B (Detach-by-Rewrap)

### Trigger

- New `session_background` keybind (default `ctrl+b`).
- Handler in `prompt/index.tsx` mirrors interrupt counter pattern.
- Calls new RPC `sdk.client.session.background({sessionID})`.
- Active only when `status !== "idle"`.

### Detach

RPC does NOT touch the running fiber. It:

1. Marks session `detached:true` in `SessionStatus`.
2. Registers a `BackgroundJob` handle wrapping the existing fiber via `Fiber.fromEffect` of `Fiber.await(runLoopFiber)`.
3. Returns immediately.

TUI immediately renders idle, prompt unblocks.

### Wakeup

- Watcher's `done: Deferred` resolves when runLoop fiber completes.
- `BackgroundJob.finish` publishes `TuiEvent.BackgroundTaskUpdate {state: "completed" | "error"}` + `ToastShow`.
- TUI consumes via SSE/Bus subscription, shows toast.
- Next user prompt prepends `<system-reminder>Background task <id> completed: <one-line summary></system-reminder>` via existing `prompt-reminders.ts` injection.

### State

In-memory `BackgroundJob` map only. No new persistence layer.

### Failure modes

| Failure | Handling |
| --- | --- |
| Bg agent errors after detach | Existing `Session.Event.Error` → watcher converts to `BackgroundTaskUpdate {state: "error"}` |
| Primary `/quit` before bg done | Fiber interrupted; final assistant message persisted via `Effect.onInterrupt` (pattern already in `subtask-handler.ts`) |
| Two bg at once | Distinct `jobID`s, supported (Map keyed by jobID, existing `model_concurrency` guards apply) |

### Implementation cost

S / M.

### Pros

- Reuses every existing primitive (`BackgroundJob.Service`, `TuiEvent.BackgroundTaskUpdate`, `ToastShow`, `Session.Event.Error`, chord-counter pattern).
- Keeps perf-tuned `processor.ts` untouched.
- Shippable as one PR.

### Cons

- Two code paths remain (fg/bg).
- Detach mid-run requires care that processor.ts's `aborted` semantics aren't tripped by UI disconnect.

## Files to change

| File | Change |
| --- | --- |
| `cli/cmd/tui/component/prompt/index.tsx` | Add `session_background` chord handler next to `session_interrupt` block (lines 262–378) |
| `cli/cmd/tui/context/keybind.tsx` | Register `session_background` default `ctrl+b` |
| `cli/cmd/tui/event.ts` | Add `BackgroundTaskUpdate` listener wiring (event already defined) |
| `server/` (wherever `session.abort` RPC lives) | Add `session.background` RPC wrapping active fiber as `BackgroundJob` |
| `session/status.ts` | Optional `detached` flag |
| `session/prompt.ts` and/or `processor.ts` | Expose runLoop fiber so RPC can wrap it |
| `session/prompt-reminders.ts` | Inject "bg task complete" reminder into next user turn |
| SDK (`sdks/typescript`) | Add `client.session.background()` method |

## Config keys

- `keybind.session_background` (default `ctrl+b`).
- `experimental.background_session_detach` (rollout gate; can reuse existing `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`).
- Optional: `experimental.background_completion_reminder_strategy: "toast" | "reminder" | "both"`.

## Implementation constraints

- Match double-press decay pattern from `prompt/index.tsx:368-378` so Ctrl+B at idle is a no-op (claude-code changelog line 1409).
- Use `BackgroundJob.wait` (Deferred) — avoid polling race (claude-code changelog line 1465).
- Persist final assistant message in `Effect.onInterrupt` (pattern already in `subtask-handler.ts`) so detach + parent-quit doesn't lose work (claude-code changelog lines 1629, 1778).

## Alternative: Option A (In-Process Always-BG)

ALL runs start as `BackgroundJob`. Foreground vs background becomes purely a "is SSE stream attached?" decision.

- Larger refactor of run path.
- Promotes existing experimental flag to GA.
- Pros: bg/fg unified, single code path, replayability/persistence enabled later.
- Cons: invasive; touches perf-sensitive `processor.ts`.

**Defer**. Migrate Option B → Option A later if persistence / replay becomes desirable.

## Out of scope (v1)

- Persistence across process restart (Option A territory).
- `Ctrl+X Ctrl+K` stop-all-bg chord (claude-code parity, future).
- Result file path propagation for post-compaction recovery (claude-code line 1778; future).
- Slash command `/bg` alias for the chord.
