# Plan: Commit Clears Modified Files

## Overview

After a successful `git commit` executed via bash tool in a session, the right-pane "Modified Files" sidebar continues showing stale diff data. The fix: detect commit completion and re-compute + publish `Session.Event.Diff` so the sidebar reflects actual post-commit git status.

## Tech Stack

- TypeScript, Effect, Solid.js (TUI)
- Existing bus/event system, `SessionSummary.computeDiff`, `FileWatcher`

## Testing Strategy

- Unit: verify `SessionSummary.summarize` is triggered after bash tool runs a git commit command
- Integration: end-to-end flow — edit file → commit → assert `Session.Event.Diff` published with cleared/updated diff
- Done when: sidebar shows accurate post-commit state; stale entries removed; edge cases (failed commit, hooks, partial staging) handled correctly

## Phases

### Phase 1: Detect git commit in bash tool output

- Step 1: After bash tool execution completes, inspect command string and exit code
- Step 2: If command matches a git commit pattern and exit code is 0, publish a new event or trigger diff recomputation

### Phase 2: Re-compute and publish session diff

- Step 1: Call `SessionSummary.computeDiff` for the active session after commit detection
- Step 2: Publish `Session.Event.Diff` with updated diff data
- Step 3: Sidebar already listens on `session.diff` event — no TUI changes needed

### Phase 3: Edge cases

- Step 1: Failed commit (non-zero exit) — do NOT refresh (stale data is still correct)
- Step 2: Pre-commit hooks that modify files — diff recomputation will pick up hook-modified files naturally since it runs after commit completes
- Step 3: Partial staging (`git add -p` then commit) — diff recomputation reflects actual git status post-commit, so unstaged changes remain visible

## Risks

- **False positive detection**: Bash command string matching could misfire on `echo "git commit"` — mitigate by checking exit code + requiring command starts with `git`
- **Performance**: `computeDiff` on every commit adds latency — mitigate by running async/non-blocking after tool result is returned
- **Race condition**: FileWatcher events from commit may arrive before/after diff recomputation — mitigate by debouncing or running diff after a short delay
