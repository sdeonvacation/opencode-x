# Plan: --worktree CLI Option

## Overview

Replace the `/worktree` dialog-based create/switch flow with a `--worktree [name]` CLI option on the TUI command. At startup, creates or reuses a named worktree and switches the session into it. The `/worktree` slash command remains but simplified to list/remove only.

## Tech Stack

- TypeScript, Effect-ts
- yargs (CLI option parsing, already used in `thread.ts`)
- Existing `Worktree` service (`src/worktree/index.ts`)
- SDK client worktree endpoints (create, list, remove)
- Existing isolation patch logic (`src/orchestration/isolation.ts`)

## Testing Strategy

- Unit: worktree create-or-reuse logic, ephemeral cleanup patch generation
- Integration: TUI boot with --worktree flag, verify cwd switch
- Done when: `opencode --worktree feat` boots into worktree, `--ephemeral` cleans up on exit, `/worktree` list+remove still work

## Phases

### Phase 1: Add --worktree option to TUI command

- Add `.option('worktree', { type: 'string', describe: 'create or reuse a named worktree' })` to `thread.ts` builder
- Add `.option('ephemeral', { type: 'boolean', describe: 'auto-cleanup worktree on exit (patch changes back)' })` to `thread.ts` builder
- In handler: if `args.worktree` set, resolve worktree before spawning worker
- Pass resulting worktree directory as `cwd` to worker + TUI app
- Validate: error early if not a git project

### Phase 2: Create-or-reuse logic

- Add `Worktree.findByName(name: string)` to `src/worktree/index.ts`
- Checks existing worktrees via `git worktree list --porcelain` for matching `opencode/<name>` branch
- If found & directory exists: reuse that directory
- If not found: create new via existing `Worktree.create({ name })`
- If found but directory gone (stale): prune stale entry, create fresh
- Emit `worktree.ready` event on success, `worktree.failed` + process exit on failure

### Phase 3: Ephemeral cleanup

- When `--ephemeral` flag set alongside `--worktree`, register cleanup in `stop()` of `thread.ts`
- Cleanup sequence:
  1. Stage + commit all changes in worktree branch
  2. Generate diff patch vs parent branch
  3. Apply patch to parent via `git apply --3way`
  4. Remove worktree via existing `Worktree.remove()`
- Reuse existing `src/orchestration/isolation.ts` patch logic where applicable
- On conflict: preserve worktree branch (don't delete), warn user

### Phase 4: Simplify /worktree slash command

- Remove "Create" and "Switch to base" options from `worktree-command.tsx`
- Keep "List" and "Remove" only
- Remove `deps.sdk.changeDirectory` from deps type (no longer needed)
- Update test in `test/cli/cmd/tui/worktree-command.test.ts`

### Phase 5: Docs & README update

- Update README comparison table (line 69): `--worktree` + `/worktree list/remove`
- Update OPENCODE-X_GUIDE.md worktree section with new CLI usage

## Risks/Edge cases

- **Name collision**: create-or-reuse must handle stale worktrees (directory exists but git worktree pruned). Mitigation: validate via `git worktree list --porcelain` + prune.
- **Dirty worktree on ephemeral exit**: uncommitted changes during patch-back. Mitigation: auto-commit all changes in worktree branch before patching.
- **Non-git project**: `--worktree` on non-git project should error early with clear message.
- **Concurrent sessions**: Two TUI sessions with same `--worktree` name could collide. Mitigation: if worktree directory already exists, reuse it (user's responsibility to not run two sessions in same worktree).
- **--ephemeral without --worktree**: Should error with "requires --worktree" message.
- **Patch conflict on ephemeral exit**: Parent branch diverged. Mitigation: use `--3way` merge, preserve worktree on failure.
