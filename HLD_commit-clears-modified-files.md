# HLD: Commit Clears Modified Files

## Tech Stack

| Category  | Technology          | Purpose                                          |
| --------- | ------------------- | ------------------------------------------------ |
| Language  | TypeScript          | Existing codebase language                       |
| Runtime   | Bun                 | Existing runtime                                 |
| Framework | Effect              | Async composition, service layers, event bus     |
| TUI       | Solid.js (Ink-like) | Sidebar already reacts to `session.diff` events  |

## Components

| Component          | Responsibility                                                    | Dependencies                              |
| ------------------ | ----------------------------------------------------------------- | ----------------------------------------- |
| BashTool           | Executes shell commands; detects git commit success post-execution | `Tool.Context` (sessionID, messages)      |
| SessionSummary     | Recomputes diff from message snapshots; publishes `Session.Event.Diff` | `Session.Service`, `Snapshot.Service`, `Bus.Service`, `Storage.Service` |
| Bus                | Event pub/sub; delivers `session.diff` to subscribers             | `InstanceState`                           |
| SyncStore (TUI)    | Holds `session_diff[sessionID]`; updates on `session.diff` events | `Bus`                                     |
| Sidebar (TUI)      | Renders modified files from sync store                            | `SyncStore`                               |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     AI Tool Execution                        │
│                                                              │
│  ┌──────────┐    ┌──────────────────┐    ┌───────────────┐  │
│  │ BashTool │───▶│ run() returns    │───▶│ execute()     │  │
│  │ execute  │    │ {output, exit}   │    │ post-run hook │  │
│  └──────────┘    └──────────────────┘    └───────┬───────┘  │
│                                                  │          │
│                              ┌────────────────────┘          │
│                              │ if git commit && exit === 0   │
│                              ▼                               │
│                   ┌─────────────────────┐                    │
│                   │ SessionSummary      │                    │
│                   │ .summarize()        │                    │
│                   │ (fire-and-forget)   │                    │
│                   └─────────┬───────────┘                    │
│                             │                                │
│                             ▼                                │
│                   ┌─────────────────────┐                    │
│                   │ Bus.publish(        │                    │
│                   │  Session.Event.Diff)│                    │
│                   └─────────┬───────────┘                    │
│                             │                                │
└─────────────────────────────┼────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                        TUI Layer                             │
│                                                              │
│  ┌──────────────┐    ┌──────────────────┐                   │
│  │ SyncStore    │◀───│ session.diff     │                   │
│  │ session_diff │    │ event listener   │                   │
│  └──────┬───────┘    └──────────────────┘                   │
│         │                                                    │
│         ▼                                                    │
│  ┌──────────────┐                                           │
│  │ Sidebar      │  (re-renders with updated diff)           │
│  │ files.tsx    │                                           │
│  └──────────────┘                                           │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

**Description**: After the bash tool's `run()` function completes, the `execute()` method inspects the command string and exit code. If a successful git commit is detected, it calls `SessionSummary.summarize()` fire-and-forget (matching the existing pattern at `prompt.ts:1579` and `processor.ts:305`). `summarize()` recomputes the diff from message snapshots and publishes `Session.Event.Diff`. The TUI's sync store already listens for this event and updates the sidebar — no TUI changes needed.

## Interfaces

### BashTool (modified)

| Method | Input | Output | Behavior | Errors |
|--------|-------|--------|----------|--------|
| `execute` (existing) | `{command: string, timeout?: number, workdir?: string, description: string}`, `Tool.Context` | `{title, metadata, output}` | After `run()` returns, checks if command is a git commit with exit code 0; if so, calls `SessionSummary.summarize()` fire-and-forget | No new errors — summarize failures are swallowed (existing pattern) |
| `isCommit` (new, module-level) | `command: string, exit: number \| null` | `boolean` | Returns `true` if command matches a git commit pattern AND exit code is 0 | None — pure function |

### SessionSummary (unchanged)

| Method | Input | Output | Behavior | Errors |
|--------|-------|--------|----------|--------|
| `summarize` (existing static) | `{sessionID: SessionID, messageID: MessageID}` | `void` (fire-and-forget) | Recomputes diff from snapshots, publishes `Session.Event.Diff`, updates storage | Swallowed via `.catch(() => {})` |

## Data Flow

| Step | Component | Action | Next |
|------|-----------|--------|------|
| 1 | BashTool `execute()` | Calls `run()` with command, shell, env, timeout | Step 2 |
| 2 | BashTool `run()` | Spawns child process, collects output, returns `{output, metadata, title}` with exit code | Step 3 |
| 3 | BashTool `execute()` | Calls `isCommit(params.command, result.metadata.exit)` | Step 4 or return |
| 4 | BashTool `execute()` | If `isCommit` returns true, calls `SessionSummary.summarize({sessionID: ctx.sessionID, messageID: ctx.messageID})` | Step 5 (async, non-blocking) |
| 5 | SessionSummary `summarize()` | Fetches all session messages, calls `computeDiff()` to diff first snapshot vs last snapshot | Step 6 |
| 6 | SessionSummary `summarize()` | Writes updated diff to storage, publishes `Bus.publish(Session.Event.Diff, {sessionID, diff})` | Step 7 |
| 7 | SyncStore | Receives `session.diff` event, updates `session_diff[sessionID]` in reactive store | Step 8 |
| 8 | Sidebar `files.tsx` | Re-renders with new diff data (cleared/reduced file list) | Done |

**Error Flows**:
- **Step 2 fails** (process crash/timeout/abort): `run()` returns null exit code → `isCommit` returns false → no refresh triggered. Stale data remains correct since no commit occurred.
- **Step 5-6 fails** (summarize errors): Swallowed by `.catch(() => {})` in the static `summarize` wrapper (`summary.ts:167`). Sidebar keeps showing previous data — acceptable degradation.
- **Step 3, `isCommit` false positive**: Mitigated by regex requiring `git` as the first command token and exit code 0 check.

## Data Model

No new entities or schema changes. Existing models used:

| Entity | Fields | Relationships | Constraints |
|--------|--------|---------------|-------------|
| `Session.Event.Diff` (existing) | `sessionID: SessionID, diff: Snapshot.FileDiff[]` | Published on bus, consumed by sync store | `sessionID` must be valid |
| `Snapshot.FileDiff` (existing) | `file: string, additions: number, deletions: number, ...` | Part of diff array | None |

## Decisions

| Decision | Choice | Reason | Alternatives | Tradeoffs |
|----------|--------|--------|--------------|-----------|
| Detection location | Inside `BashTool.execute()`, after `run()` returns | Simplest integration point; has access to command string, exit code, and `Tool.Context` with sessionID/messageID | (1) Plugin hook `tool.execute.after` — adds indirection, plugin system not designed for core behavior. (2) FileWatcher-based detection — unreliable timing, no commit semantics | Tight coupling to bash tool, but this is the only tool that runs git commit |
| Detection method | Regex on command string + exit code 0 | Simple, deterministic, no external dependencies | (1) Parse git output for commit confirmation — fragile across git versions/locales. (2) Check `.git/HEAD` changes — race conditions with concurrent operations | Regex may miss exotic commit invocations (e.g., aliased), but covers all practical cases |
| Refresh mechanism | Reuse `SessionSummary.summarize()` fire-and-forget | Matches existing pattern used in `prompt.ts:1579` and `processor.ts:305`; recomputes full session diff and publishes event | (1) Directly publish empty diff — incorrect, unstaged changes should still show. (2) New dedicated diff-only function — unnecessary duplication | `summarize()` does slightly more work than needed (also updates summary stats), but cost is negligible and keeps code DRY |
| Async execution | Fire-and-forget (non-blocking) | Commit detection should not delay tool result delivery to the AI model | (1) Await summarize before returning — adds latency to tool response | Sidebar update is slightly delayed (milliseconds); acceptable UX |
| Git commit regex | `/^\s*git\s+commit\b/` on the raw command string | Catches `git commit`, `git commit -m "msg"`, `git commit --amend`, etc. Requires `git` as the leading command token to avoid matching `echo "git commit"` | (1) Tree-sitter AST parsing of command — overkill for this check. (2) Substring match — too many false positives | Won't match piped commands like `echo y \| git commit` — acceptable limitation; covers 99% of real usage |

## Risks

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| False positive: command matches regex but isn't a real git commit (e.g., `git commit-graph`) | Unnecessary diff recomputation; no user-visible harm since summarize produces correct data | Low | Regex uses `\b` word boundary after `commit`; exit code 0 required |
| False negative: exotic git commit invocation not matched (aliases, scripts wrapping git) | Sidebar stays stale until next AI step completes (existing behavior) | Low | Acceptable — same as current behavior; can expand regex later |
| Race condition: summarize runs concurrently with next AI tool execution | Diff could briefly show intermediate state | Low | `summarize()` is idempotent; next AI step will trigger its own summarize anyway |
| Performance: redundant summarize if AI step immediately follows commit | Two summarize calls in quick succession | Medium | Negligible cost — `computeDiff` is fast (snapshot-based); no user-visible impact |
| Chained commands: `git add . && git commit -m "msg" && git push` | Single `run()` call with compound command; regex must match `git commit` within chain | Medium | Regex matches `git\s+commit\b` anywhere in command after splitting on `&&`, `\|\|`, or `;` |

## Test Plan

### Unit Tests

**`isCommit` function** (`src/tool/bash.ts`):

| Scenario | Input | Expected |
|----------|-------|----------|
| Simple commit, success | `("git commit -m 'msg'", 0)` | `true` |
| Commit with amend | `("git commit --amend", 0)` | `true` |
| Commit failed | `("git commit -m 'msg'", 1)` | `false` |
| Commit with null exit | `("git commit -m 'msg'", null)` | `false` |
| Non-git command | `("npm install", 0)` | `false` |
| Echo containing git commit | `("echo 'git commit'", 0)` | `false` |
| Chained with commit | `("git add . && git commit -m 'msg'", 0)` | `true` |
| git commit-graph (not commit) | `("git commit-graph write", 0)` | `false` |
| Leading whitespace | `("  git commit -m 'x'", 0)` | `true` |
| Pipe before git commit | `("echo y \| git commit", 0)` | `true` |
| Only `git` without commit | `("git status", 0)` | `false` |
| Empty command | `("", 0)` | `false` |

### Integration Tests

**Bash tool execute → summarize trigger**:

- Mock `SessionSummary.summarize` to track calls
- Execute bash tool with `git commit -m "test"` command and mock a successful exit (code 0)
- Assert `summarize` was called with correct `sessionID` and `messageID`
- Execute bash tool with `ls -la` and assert `summarize` was NOT called

### End-to-End Tests

**Full flow: edit → commit → sidebar refresh**:

- Start a session, make a file edit (triggers initial diff)
- Verify sidebar shows modified file
- Execute `git add . && git commit -m "test"` via bash tool
- Verify `Session.Event.Diff` is published with updated (reduced) diff
- Verify sidebar no longer shows the committed file

### Non-Functional Tests

- **Performance**: Verify `summarize()` call does not block bash tool result return (fire-and-forget pattern)
- **Idempotency**: Verify multiple rapid commits produce correct final diff state
