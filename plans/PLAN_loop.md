# Plan: /loop — Background Recurring Prompt Scheduler

## Overview

Add a `/loop` slash command that schedules prompts to run on a fixed recurring interval as **background subagent sessions**. Loops run independently of the main session (non-blocking), their output is visible via TUI navigation, auto-expire after 7 days, and support a `loop.md` default prompt. Multiple loops per session (up to 20). Session-scoped only — loops die when parent session ends. Uses a **small/cheap model** by default to minimize cost.

## Requirements

1. Loops run in background — do NOT block the main session
2. User can see what is happening inside each loop iteration (navigable output)
3. Dedicated keybind for terminating loops: `<leader>p` opens loop management panel
4. Loops use `small_model` config by default (configurable per-loop)
5. Fixed interval only (no dynamic self-pacing in v1)
6. Multiple loops per session (up to 20)
7. Auto-expiry after 7 days
8. `loop.md` support for bare `/loop` default prompt
9. **Token budget per loop** — cumulative across all iterations; loop terminates when total tokens exceeded

## Tech Stack

- TypeScript + Effect-ts 4.0-beta (Schedule, Clock, Effect.forkScoped)
- SQLite + Drizzle ORM (loop metadata, session-scoped lifecycle)
- Background subagent sessions (reuse existing Task tool / BackgroundJob infrastructure)
- @opentui Solid TUI (slash command, status display, loop output navigation)
- Bun runtime

## Testing Strategy

- Unit: Loop CRUD operations, interval parsing, scheduler tick logic, expiry, model selection
- Integration: full lifecycle — create loop → wait interval → verify background session spawned → view output → cancel via keybind
- Done when: `/loop 5m run tests` creates a loop, spawns background session after 5m, output viewable in TUI, cancels via dedicated keybind, uses small model

## Phases

### Phase 1: Core Loop Module (`src/loop/`)

- Step 1: Define `LoopTable` schema (id, session_id, prompt, interval_ms, model, status, iteration_count, token_budget, tokens_used, created_at, next_run_at, last_run_at, expires_at, last_subagent_session_id)
- Step 2: Implement `Loop` namespace — create, get, list, tick, pause, resume, cancel, expire
- Step 3: Implement `LoopScheduler` service — Effect fiber that ticks every 1s, checks due loops, spawns background subagent
- Step 4: Integrate scheduler startup into session lifecycle (create on first loop, teardown on session end)
- Step 5: Scheduler spawns loop iterations as **background subagent sessions** (not main-session injections)

### Phase 2: Interval Parsing & Prompt Resolution

- Step 1: Parse interval syntax (`Ns`, `Nm`, `Nh`, `Nd`) → milliseconds (minimum 60s)
- Step 2: Parse `/loop [interval] [prompt]` — separate interval from prompt text
- Step 3: `loop.md` resolution — look in `.opencode/loop.md` project-level, fallback to `~/.config/opencode/loop.md` global
- Step 4: When prompt empty + no loop.md → show usage help, don't create

### Phase 3: Background Execution (Subagent Integration)

- Step 1: Each loop iteration spawns a background subagent session (reuse Task tool's BackgroundJob infra)
- Step 2: Subagent uses configurable small model (default: cheapest available, e.g. gpt-4.1-mini or haiku)
- Step 3: Subagent has full tool access (bash, read, edit) — same as parent session permissions
- Step 4: On iteration complete — update Loop metadata (last_run_at, iteration_count, tokens_used += iteration tokens, last_subagent_session_id), schedule next
- Step 5: Budget check — after each iteration, if tokens_used >= token_budget → terminate loop with "budget_exhausted" status
- Step 6: Overlap skip — if previous iteration still running when next fires, skip (don't stack)
- Step 7: Auto-expiry check — if created_at + 7 days passed, fire final time then mark expired

### Phase 4: TUI Commands & UX

- Step 1: `createLoopCommand()` — `/loop [interval] [prompt]` creates directly; bare `/loop` opens combined panel
- Step 2: Combined loop panel (shared by `/loop` bare + `<leader>p`): lists active loops + "Create new" option
- Step 3: **Dedicated keybind** (`<leader>p`) — opens same combined loop panel
- Step 4: Loop iteration output viewable by navigating to subagent session (like existing background task navigation)
- Step 5: Status indicator — show active loop count + next fire countdown in TUI footer
- Step 6: Toast notifications — "Loop created", "Loop #N iteration started", "Loop expired"
- Step 7: Bus event `loop.iteration.complete` triggers TUI update with result summary

### Phase 5: Server Routes & SDK

- Step 1: `POST /:sessionID/loop` — create loop (interval_ms, prompt, model?)
- Step 2: `GET /:sessionID/loops` — list active loops with metadata
- Step 3: `DELETE /:sessionID/loop/:loopID` — cancel specific loop
- Step 4: `GET /:sessionID/loop/:loopID/iterations` — list iteration history (subagent session IDs)
- Step 5: SDK types for loop CRUD
- Step 6: Bus events — `loop.created`, `loop.iteration.started`, `loop.iteration.complete`, `loop.cancelled`, `loop.expired`

### Phase 6: Config & Feature Flag

- Step 1: Add `experimental.loop` boolean flag (default: true — ship enabled)
- Step 2: Config tunables:
  - `loop.max_concurrent` (default 20)
  - `loop.max_expiry_days` (default 7)
  - `loop.min_interval_ms` (default 60000)
  - `loop.model` (default: uses `small_model` from provider config)
  - `loop.token_budget` (default: none — unlimited unless specified per-loop)
  - `loop.keybind` (default: "leader+p")
- Step 3: Gate loop registration behind feature flag in tool/registry and TUI command list

## Risks/Edge cases

- **Background cost**: Loops spawn full subagent sessions — mitigate with small model default + iteration cost tracking
- **Stacking**: If loop iteration takes longer than interval → overlap skip (skip next if previous still running)
- **Memory leak**: Forgotten loops accumulate → 7-day auto-expiry + max 20 cap
- **Session resume**: Loops are session-scoped, NOT restored on resume (simplifies v1; can add later)
- **Cost runaway**: Loop with expensive prompt burns tokens overnight → log cumulative cost per loop, warn at thresholds, show in `/loops`
- **Jitter**: Add up to 10% of interval (capped at 5min) to prevent thundering herd if multiple loops share interval
- **Keybind conflict**: `<leader>+l` — document in help, ensure leader key system supports it
- **Model availability**: If `small_model` not configured, fallback to parent session model with warning
- **Token tracking**: Must aggregate token usage from subagent session back to loop metadata after each iteration

## Code References

| Reference                       | URL/Path                                                                          | What to learn                                             |
| ------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Claude Code /loop source        | `emanuelcasco/claude-code` `src/skills/bundled/loop.ts`                           | Registration pattern, interval→cron, immediate exec       |
| Claude Code scheduler internals | [gist analysis](https://gist.github.com/sorrycc/1b2166228413234928039e84a26a3b8f) | Tick function, idle gating, jitter algorithm, auto-expiry |
| opencode-x Goal system          | `src/goal/`                                                                       | DB schema pattern, lifecycle, prompt.ts integration       |
| opencode-x Background Tasks     | `src/orchestration/` + `src/tool/task.ts`                                         | BackgroundJob spawning, TUI session navigation            |
| openloop framework              | `github.com/thu-nmrc/openloop`                                                    | Heartbeat.json, stall detection, circuit breakers         |
| Martin-Loop                     | `github.com/Keesan12/Martin-Loop`                                                 | Budget caps, audit trails for loops                       |

## Architecture Notes (for HLD)

```
User: /loop 5m check deploy status
         │
         ▼
┌─────────────────────────┐
│  Interval Parser        │  "5m" → 300000ms
│  Prompt Parser          │  "check deploy status"
└──────────┬──────────────┘
           ▼
┌─────────────────────────┐
│  Loop.create()          │  Insert into LoopTable
│  LoopScheduler.start()  │  Ensure scheduler fiber running
└──────────┬──────────────┘
           ▼
┌───────────────────────────────────────────────────────┐
│  LoopScheduler (Effect fiber, ticks every 1s)         │
│                                                       │
│  for each loop:                                       │
│    if now >= next_run_at:                             │
│      if loop.last_iteration_running: skip             │
│      else:                                            │
│        spawn BackgroundSubagent(                       │
│          prompt: loop.prompt,                          │
│          model: loop.model ?? config.loop.model,       │
│          parentSessionID: loop.session_id             │
│        )                                              │
│        loop.next_run_at = now + interval + jitter     │
│        loop.iteration_count++                         │
│    if now >= loop.expires_at:                         │
│      fire final + mark expired                        │
└───────────────────────────────────────────────────────┘
           ▼
┌─────────────────────────────────────────┐
│  Background Subagent Session            │
│  (independent session, small model)     │
│  - Full tool access                     │
│  - Output visible in TUI via navigate   │
│  - Reports result back via Bus event    │
└─────────────────────────────────────────┘
           ▼
┌─────────────────────────────────────────┐
│  TUI: Ctrl+L → Loop Panel              │
│  - List active loops                    │
│  - View iteration output (navigate)    │
│  - Terminate loop                       │
│  - Show next fire countdown             │
└─────────────────────────────────────────┘
```
