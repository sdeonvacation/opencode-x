# HLD: --worktree CLI Option

## Summary

Replace the `/worktree` dialog-based create/switch flow with a `--worktree [name]` CLI option on the TUI command. At startup, creates or reuses a named worktree and boots the session into it. An optional `--ephemeral` flag patches changes back to the parent branch on exit and removes the worktree. The `/worktree` slash command is simplified to list/remove only.

## Tech Stack

| Category  | Technology | Purpose                                      |
| --------- | ---------- | -------------------------------------------- |
| Language  | TypeScript | Existing codebase language                   |
| Framework | Effect-ts  | Worktree service layer composition           |
| CLI       | yargs      | Already used in thread.ts for option parsing |
| VCS       | git CLI    | Worktree operations, patch generation        |
| Runtime   | Bun        | Process spawning, worker creation            |

## Components

| Component           | Responsibility                                     | Dependencies                          |
| ------------------- | -------------------------------------------------- | ------------------------------------- |
| TuiThreadCommand    | Parse --worktree/--ephemeral, resolve cwd, cleanup | Worktree service, isolation utilities |
| Worktree.findByName | Locate existing worktree by opencode/<name> branch | git CLI, parseWorktreeList (existing) |
| EphemeralCleanup    | Patch changes back to parent on exit               | isolation.ts gitDiff/gitApply pattern |
| WorktreeCommand     | Simplified slash command (list + remove only)      | SDK client worktree endpoints         |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    CLI Startup (thread.ts)                        │
│                                                                   │
│  yargs parse ──► --worktree "feat" ──┐                           │
│                  --ephemeral          │                           │
│                                       ▼                           │
│                          ┌───────────────────────┐               │
│                          │  resolveWorktree()    │               │
│                          │  (create-or-reuse)    │               │
│                          └───────────┬───────────┘               │
│                                      │                           │
│                    ┌─────────────────┼─────────────────┐         │
│                    │ found           │ not found        │         │
│                    ▼                 ▼                  │         │
│              reuse directory    Worktree.create()       │         │
│                    │                 │                  │         │
│                    └────────┬────────┘                  │         │
│                             ▼                           │         │
│                    process.chdir(worktreeDir)           │         │
│                             │                           │         │
│                             ▼                           │         │
│                    spawn Worker (existing flow)         │         │
│                             │                           │         │
│                             ▼                           │         │
│                    tui() renders normally               │         │
│                             │                           │         │
│                    [on exit / signal]                   │         │
│                             │                           │         │
│              ephemeral?     │                           │         │
│              ┌──────────────┼──────────────┐           │         │
│              │ yes          │ no           │           │         │
│              ▼              ▼              │           │         │
│    ephemeralCleanup()   normal exit        │           │         │
│    (diff → apply → rm)                    │           │         │
│                                            │           │         │
└────────────────────────────────────────────────────────┘

Worktree Service (existing):
┌──────────────────────────────────────┐
│  src/worktree/index.ts               │
│                                      │
│  + findByName(name) ──────────┐      │
│  │ git worktree list --porcelain     │
│  │ parseWorktreeList()               │
│  │ match branch "opencode/<name>"    │
│  │ validate directory exists         │
│  └───► Info | null                   │
│                                      │
│  create(input)    [existing]         │
│  remove(input)    [existing]         │
│  reset(input)     [existing]         │
└──────────────────────────────────────┘

Isolation (existing, reused for ephemeral):
┌──────────────────────────────────────┐
│  src/orchestration/isolation.ts      │
│                                      │
│  gitDiff(cwd)     → patch string     │
│  gitApply(patch, target) → result    │
│  cleanup(directory) → Worktree.remove│
└──────────────────────────────────────┘
```

**Description**: The TUI command handler gains two options. When `--worktree` is present, the handler calls `resolveWorktree()` which uses `Worktree.findByName` to check for an existing worktree or creates a new one. The resolved directory replaces `cwd` before the worker is spawned. When `--ephemeral` is set, the `stop()` closure runs the patch-back flow before terminating. The slash command loses create/switch since those are now CLI-driven.

## Interfaces

### Worktree Service (additions)

| Method     | Input        | Output                  | Behavior                                                                                         | Errors      |
| ---------- | ------------ | ----------------------- | ------------------------------------------------------------------------------------------------ | ----------- |
| findByName | name: string | `Promise<Info \| null>` | Parse `git worktree list --porcelain`, match `opencode/<name>` branch, validate directory exists | NotGitError |

### resolveWorktree (new helper in thread.ts)

| Method          | Input                     | Output          | Behavior                                                   | Errors                         |
| --------------- | ------------------------- | --------------- | ---------------------------------------------------------- | ------------------------------ |
| resolveWorktree | name: string, cwd: string | `Promise<Info>` | findByName → reuse if found, create if not, prune if stale | NotGitError, CreateFailedError |

### ephemeralCleanup (new helper in thread.ts)

| Method           | Input                      | Output                 | Behavior                                                               | Errors               |
| ---------------- | -------------------------- | ---------------------- | ---------------------------------------------------------------------- | -------------------- |
| ephemeralCleanup | info: Info, parent: string | `Promise<PatchResult>` | git add -A, git diff HEAD, git apply --3way to parent, Worktree.remove | Conflict (non-fatal) |

## Data Flow

### Startup with --worktree

| Step | Component       | Action                                                 | Next            |
| ---- | --------------- | ------------------------------------------------------ | --------------- |
| 1    | yargs           | Parse `--worktree feat --ephemeral`                    | handler         |
| 2    | handler         | Validate: not combining --ephemeral without --worktree | resolveWorktree |
| 3    | resolveWorktree | Call `Worktree.findByName("feat")`                     | branch          |
| 4a   | findByName      | Found + directory exists → return Info                 | step 5          |
| 4b   | findByName      | Found but stale → `git worktree prune`, create fresh   | step 5          |
| 4c   | findByName      | Not found → `Worktree.create({ name: "feat" })`        | step 5          |
| 5    | handler         | `process.chdir(info.directory)`                        | worker spawn    |
| 6    | handler         | `new Worker(file, { env })` — inherits new cwd         | tui()           |
| 7    | tui             | Renders normally in worktree directory                 | user session    |

### Ephemeral Cleanup on Exit

| Step | Component        | Action                                           | Next             |
| ---- | ---------------- | ------------------------------------------------ | ---------------- |
| 1    | stop()           | Check ephemeral flag + stored worktree info      | ephemeralCleanup |
| 2    | ephemeralCleanup | `git add -A` in worktree directory               | step 3           |
| 3    | ephemeralCleanup | `git diff HEAD --binary --staged` → patch string | step 4           |
| 4    | ephemeralCleanup | If patch empty → skip apply, remove worktree     | done             |
| 5    | ephemeralCleanup | `git apply --3way -` patch to parent directory   | step 6           |
| 6a   | ephemeralCleanup | Apply success → `Worktree.remove({ directory })` | done             |
| 6b   | ephemeralCleanup | Apply conflict → log warning, preserve branch    | done             |

**Error Flows**:

- Non-git project: `--worktree` errors immediately with "Worktrees require a git project" before worker spawn.
- `--ephemeral` without `--worktree`: error immediately with "requires --worktree".
- Worktree creation failure: log error, exit with code 1.
- Patch conflict on cleanup: warn user via stderr, keep worktree branch intact for manual recovery.
- Worker shutdown timeout: ephemeral cleanup still runs in `stop()` (cleanup is after worker.terminate).

## Data Model

No new database entities. Uses existing `Worktree.Info` schema:

| Entity        | Fields                                          | Relationships              | Constraints                      |
| ------------- | ----------------------------------------------- | -------------------------- | -------------------------------- |
| Worktree.Info | name: string, branch: string, directory: string | ProjectTable (via sandbox) | branch format: `opencode/<name>` |

## Decisions

| Decision                   | Choice                            | Reason                                   | Alternatives                        | Tradeoffs                                                       |
| -------------------------- | --------------------------------- | ---------------------------------------- | ----------------------------------- | --------------------------------------------------------------- |
| Resolve before worker      | Call findByName/create in handler | Worker inherits correct cwd via chdir    | Pass flag to worker, resolve there  | Simpler; error exits before UI renders                          |
| Reuse isolation.ts pattern | Copy gitDiff/gitApply as helpers  | Proven pattern, handles --3way conflicts | Import directly from isolation.ts   | isolation.ts functions are module-private; extract or duplicate |
| Preserve on conflict       | Don't delete worktree branch      | User can manually resolve or cherry-pick | Force-apply, lose conflicts         | Safety over convenience                                         |
| findByName in service      | Add to Worktree.Interface + layer | Consistent with existing service pattern | Standalone function outside service | Service has git/path deps already wired                         |
| Slash command simplify     | Remove create + switch-to-base    | CLI replaces these; reduce UI complexity | Keep all, deprecation warnings      | Breaking change for TUI-only users                              |

## Risks

| Risk                            | Impact                                     | Likelihood | Mitigation                                        |
| ------------------------------- | ------------------------------------------ | ---------- | ------------------------------------------------- |
| Stale worktree entry            | findByName returns path that doesn't exist | Med        | Check directory exists + `git worktree prune`     |
| Concurrent --worktree same name | Two sessions in same worktree              | Low        | Reuse is by design; user responsibility           |
| Patch conflict on exit          | Changes stuck in worktree branch           | Med        | Warn user, print branch name for manual recovery  |
| Large binary diffs              | Patch application slow/fails               | Low        | Use `--binary` flag (already in isolation.ts)     |
| Non-git directory               | Crash before meaningful error              | Low        | Check `Project.fromDirectory` vcs === "git" early |
| Worker already running          | chdir after resolve races with other I/O   | Low        | Resolve is synchronous-sequential before spawn    |

## Test Plan

### Unit Tests

**Worktree.findByName**:

- Happy path: existing worktree with `opencode/feat` branch → returns Info
- Not found: no matching branch in worktree list → returns null
- Stale: branch exists but directory missing → returns null (triggers prune path)
- Non-git project: throws NotGitError

**resolveWorktree**:

- Name exists → reuses existing directory (no create called)
- Name doesn't exist → calls Worktree.create with name
- Stale entry → prunes then creates fresh

**ephemeralCleanup**:

- Empty diff → removes worktree, returns "empty"
- Clean apply → removes worktree, returns "applied"
- Conflict → preserves worktree, returns "conflict" with branch name

### Integration Tests

**TUI boot with --worktree**:

- `opencode --worktree feat` in git project → worker spawns with cwd in `.worktrees/feat`
- `opencode --worktree feat` second time → reuses same directory
- `opencode --ephemeral` without --worktree → exits with error message
- `opencode --worktree feat` in non-git dir → exits with error

**Ephemeral lifecycle**:

- Boot with --worktree test --ephemeral → make change → exit → changes appear in parent, worktree removed
- Boot with --worktree test --ephemeral → make conflicting change → exit → worktree preserved, warning shown

### End-to-End Tests

- Full flow: `opencode --worktree feature-x` → create file → exit → relaunch same flag → file still there
- Full flow: `opencode --worktree temp --ephemeral` → create file → exit → file exists in parent dir, no worktree remains

### Non-Functional Tests

- Startup latency: resolveWorktree adds < 500ms to boot (git worktree list is fast)
- Cleanup timeout: ephemeral cleanup completes within the existing 15s shutdown timeout
- No orphan worktrees: test that signal handlers (SIGTERM, SIGINT) still trigger cleanup

## File Changes Summary

| File                                           | Change Type | Description                                                                             |
| ---------------------------------------------- | ----------- | --------------------------------------------------------------------------------------- |
| `src/cli/cmd/tui/thread.ts`                    | Modify      | Add --worktree/--ephemeral options, resolveWorktree helper, ephemeral cleanup in stop() |
| `src/worktree/index.ts`                        | Modify      | Add findByName to Interface, implement in layer, export async wrapper                   |
| `src/cli/cmd/tui/command/worktree-command.tsx` | Modify      | Remove create/switch-to-base options, simplify deps type                                |
| `test/cli/cmd/tui/worktree-command.test.ts`    | Modify      | Update tests for simplified command                                                     |
| `test/worktree/find-by-name.test.ts`           | New         | Unit tests for findByName                                                               |
| `test/cli/cmd/tui/worktree-flag.test.ts`       | New         | Integration tests for --worktree boot flow                                              |

## Implementation Notes

### findByName Implementation Strategy

Uses existing `parseWorktreeList` (already in worktree service layer) to parse `git worktree list --porcelain` output. Matches entries where `branch` equals `refs/heads/opencode/<name>`. Validates the directory path exists on disk.

```
findByName("feat")
  → git worktree list --porcelain
  → parseWorktreeList(output)
  → find entry where branch === "refs/heads/opencode/feat"
  → if found + fs.exists(entry.path) → return { name: "feat", branch: "opencode/feat", directory: entry.path }
  → if found + !exists → return null (caller handles prune)
  → if not found → return null
```

### thread.ts Handler Changes (pseudocode)

```
// After resolving `next` (line ~131), before process.chdir:
if (args.worktree) {
  if (args.ephemeral && !args.worktree) → error + return
  const info = await resolveWorktree(args.worktree, next)
  // info.directory becomes the new cwd
  next = info.directory
  // Store for cleanup
  worktreeInfo = info
}
// existing: process.chdir(next)
```

### stop() Cleanup Addition (pseudocode)

```
const stop = async () => {
  if (stopped) return
  stopped = true
  // ... existing signal/handler cleanup ...

  // Ephemeral cleanup before worker shutdown
  if (args.ephemeral && worktreeInfo) {
    const result = await ephemeralCleanup(worktreeInfo, originalCwd)
    if (result.status === "conflict") {
      process.stderr.write(`Warning: patch conflict, branch ${result.branch} preserved\n`)
    }
  }

  // ... existing: withTimeout(client.call("shutdown")) ...
  worker.terminate()
}
```

### ephemeralCleanup Reuse of isolation.ts

The `gitDiff` and `gitApply` functions in isolation.ts are module-private. Two options:

1. **Extract to shared utility** (preferred): Move `gitDiff`/`gitApply` to `src/orchestration/patch.ts`, import from both isolation.ts and thread.ts
2. **Duplicate**: Copy the ~25 lines into thread.ts ephemeral helper

Decision: Extract. Both callers need identical git-diff-then-apply semantics. Keeps the codebase DRY.
