# Plan: Fork Merge Sync — Feature Branch Decomposition

## Overview

Decompose the 50 local commits on `devlocal` into isolated `feat/*` branches, each rebased independently against `upstream/dev`. A throwaway integration branch (`devlocal-next`) merges all feature branches together. `devlocal` remains untouched as a reference/fallback.

## Tech Stack

- Git (branching, cherry-pick, rebase, merge)
- Shell script (`rebuild.sh`) for integration branch automation
- `git rerere` for conflict resolution caching

## Testing Strategy

- **Unit**: After each `feat/*` branch is created, verify `bun --cwd packages/opencode typecheck` + `bun --cwd packages/opencode test` pass on that branch merged with `upstream/dev`
- **Integration**: After `rebuild.sh` produces `devlocal-next`, full test suite + build must pass
- **Regression**: Diff `devlocal-next` against `devlocal` — feature parity (no lost functionality)
- **Done when**: Each `feat/*` branch rebases onto latest `upstream/dev` with ≤2 conflicts; `rebuild.sh` produces a green integration branch

## Phases

### Phase 1: Enable Git Tooling

- Step 1: Enable `git rerere` (`git config rerere.enabled true && git config rerere.autoupdate true`)
- Step 2: Identify patch-equivalent commits already upstream (`git log --cherry-pick --left-right upstream/dev...devlocal`)
- Step 3: Document commits to DROP (already upstream) vs KEEP (local-only)

### Phase 2: Classify Local Commits into Feature Groups

- Step 1: Assign each of the 50 local commits to a feature group:

| #   | Feature Branch             | Description                                                        | Likely Scope                              |
| --- | -------------------------- | ------------------------------------------------------------------ | ----------------------------------------- |
| 1   | `feat/sliding-window`      | Sliding window context compaction + metrics                        | session/, provider/                       |
| 2   | `feat/doom-loop`           | Doom loop detection + hard cap                                     | orchestration/, session/                  |
| 3   | `feat/session-memory`      | Persistent session memory + slash commands                         | memory/, session/, tool/                  |
| 4   | `feat/status-dialog`       | Show/copy session ID in /status                                    | cli/cmd/tui/command/                      |
| 5   | `feat/clear-commands`      | /clear and /clear-compact slash commands                           | cli/cmd/tui/command/                      |
| 6   | `feat/btw-command`         | /btw slash command (context injection)                             | cli/cmd/tui/command/, session/            |
| 7   | `feat/lsp-improvements`    | LSP server improvements (orphan cleanup, stale diagnostics, etc.)  | lsp/                                      |
| 8   | `feat/tui-logo-sound`      | TUI logo + startup sound                                           | cli/cmd/tui/                              |
| 9   | `feat/hybrid-routing`      | Hybrid model routing (tiered pricing, category routing)            | orchestration/, provider/                 |
| 10  | `feat/token-consumption`   | Token consumption improvements (pre-computed cost/totals, display) | session/, cli/cmd/tui/                    |
| 11  | `feat/memory-consumption`  | Memory consumption improvements (caching, retention, limits)       | session/, storage/                        |
| 12  | `feat/permission-flag`     | Improve OPENCODE_PERMISSION flag handling                          | permission/                               |
| 13  | `feat/question-tool`       | Improvements to question tool UX                                   | tool/, cli/cmd/tui/                       |
| 14  | `feat/right-pane-bleed`    | Prevent right pane bleed in TUI                                    | cli/cmd/tui/                              |
| 15  | `feat/spinner-verbs`       | Spinner verbs (contextual action labels)                           | cli/cmd/tui/util/, cli/cmd/tui/component/ |
| 16  | `feat/subagent-navigation` | Subagent session navigation fixes (click routing, sort order)      | cli/cmd/tui/routes/session/               |
| 17  | `feat/parallel-tools`      | Parallel tool calls execution                                      | tool/, session/                           |

- Step 2: Remaining commits (fixes, chores, docs) — assign to nearest feature branch or a `fix/misc` catch-all branch

### Phase 3: Create Feature Branches

- Step 1: For each feature group, create branch from `upstream/dev`:
  ```
  git checkout upstream/dev
  git checkout -b feat/<name>
  git cherry-pick <commits in order>
  ```
- Step 2: Resolve conflicts per-branch (small scope: 1–7 commits, isolated files)
- Step 3: Verify each branch independently: typecheck + test on `upstream/dev + feat/<name>`
- Step 4: Record any rerere resolutions for future use

### Phase 4: Build Integration Branch

- Step 1: Create `rebuild.sh` script:
  ```bash
  #!/bin/bash
  set -e
  BRANCHES=(
    feat/sliding-window
    feat/doom-loop
    feat/parallel-tools
    feat/hybrid-routing
    feat/token-consumption
    feat/memory-consumption
    feat/session-memory
    feat/permission-flag
    feat/question-tool
    feat/lsp-improvements
    feat/spinner-verbs
    feat/subagent-navigation
    feat/right-pane-bleed
    feat/status-dialog
    feat/clear-commands
    feat/btw-command
    feat/tui-logo-sound
  )
  git checkout upstream/dev
  git checkout -B devlocal-next
  for branch in "${BRANCHES[@]}"; do
    git merge --no-ff "$branch" -m "merge: $branch"
  done
  ```
- Step 2: Run `rebuild.sh` → produces `devlocal-next`
- Step 3: Full verification: test + typecheck + build on `devlocal-next`
- Step 4: Diff `devlocal-next` vs `devlocal` to confirm feature parity

### Phase 5: Establish Ongoing Sync Ritual

- Step 1: When upstream moves:
  ```bash
  git fetch upstream
  # Rebase each feature branch independently
  for branch in feat/*; do
    git checkout "$branch"
    git rebase upstream/dev
  done
  # Rebuild integration
  ./rebuild.sh
  ```
- Step 2: Conflict policy: **local wins** (`-X ours` on conflicting hunks), then manually review what upstream changes were skipped
- Step 3: Weekly cadence: fetch + rebase all feat branches + rebuild
- Step 4: `devlocal` stays frozen as historical reference — never modified

## Risks

| Risk                                               | Impact                             | Mitigation                                                                           |
| -------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------ |
| Cherry-pick into feat/\* still conflicts           | Blocks Phase 3                     | Small scope (1–7 commits) makes manual resolution tractable; rerere caches solutions |
| Feature branches have hidden interdependencies     | Merge of feat/A + feat/B breaks    | Verify each pair merges cleanly; reorder merge sequence if needed                    |
| `devlocal-next` diverges from `devlocal` behavior  | Subtle regressions                 | Diff final state; run full test suite; keep `devlocal` as fallback                   |
| Upstream rewrites files entirely                   | Feature branch can't rebase        | Accept upstream version, reimplement local feature on new model                      |
| `rebuild.sh` merge order matters                   | Conflicts between feature branches | Establish stable merge order; put independent branches first, overlapping ones last  |
| 17 branches = maintenance burden                   | Weekly sync takes longer           | Most are 1–3 commits; only sliding-window is large (7+)                              |
| Commit-to-feature mapping unclear for some commits | Wrong branch assignment            | Phase 2 audit with `git show --stat` per commit; ambiguous → fix/misc                |
