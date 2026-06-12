# HLD: Fork Merge Sync — Feature Branch Decomposition

## Tech Stack

| Category     | Technology      | Purpose                                         |
| ------------ | --------------- | ----------------------------------------------- |
| VCS          | Git 2.x         | Branching, cherry-pick, rebase, merge, rerere   |
| Automation   | Shell (bash)    | `rebuild.sh`, `sync.sh` scripts                 |
| Conflict     | git rerere      | Cache conflict resolutions across rebases       |
| Verification | Bun 1.3.11 + TS | typecheck + test after each branch/rebuild      |
| Runtime      | TypeScript 5.8  | Codebase under management (not modified by HLD) |

## Components

| Component         | Responsibility                                                            | Dependencies                        |
| ----------------- | ------------------------------------------------------------------------- | ----------------------------------- |
| `rebuild.sh`      | Destroy+recreate `devlocal-next` by merging all feat/\* into upstream/dev | upstream/dev, all feat/\* branches  |
| `sync.sh`         | Fetch upstream, rebase each feat/\* branch, run rebuild                   | upstream remote, rebuild.sh, rerere |
| `verify.sh`       | Run typecheck + test + build on current branch                            | Bun, packages/opencode              |
| `diff-check.sh`   | Compare `devlocal-next` tree against `devlocal` for parity                | devlocal (frozen), devlocal-next    |
| `git rerere` DB   | Persist conflict resolutions for reuse across rebases                     | .git/rr-cache                       |
| `devlocal`        | Frozen reference branch — never modified                                  | None                                |
| `devlocal-next`   | Throwaway integration branch — rebuilt from scratch each time             | rebuild.sh                          |
| `feat/*` branches | Isolated feature units, each independently rebaseable                     | upstream/dev (base)                 |

## Architecture

```
                          upstream/dev (moves forward)
                               │
          ┌────────────────────┼────────────────────────────────┐
          │                    │                                 │
          ▼                    ▼                                 ▼
   feat/sliding-window   feat/doom-loop   ...   feat/tui-logo-sound
          │                    │                         │
          │                    │                         │
          └────────────┬───────┴─────────────────────────┘
                       │
                       ▼
              rebuild.sh (merge --no-ff each, 17 branches)
                       │
                       ▼
              devlocal-next (throwaway integration)
                       │
                       ▼
              verify.sh (typecheck + test + build)
                       │
                       ▼
              diff-check.sh (compare vs devlocal)


   ┌─────────────────────────────────────────────────────┐
   │  devlocal (FROZEN — historical reference, 50 commits)│
   └─────────────────────────────────────────────────────┘
```

**Branch Topology**:

```
  merge-base (180ded6a2)
       │
       ├──────── upstream/dev ──────────────▶ (moves forward)
       │              │
       │              ├─ feat/sliding-window      (session/, provider/)
       │              ├─ feat/doom-loop            (orchestration/, session/)
       │              ├─ feat/parallel-tools       (tool/, session/)
       │              ├─ feat/hybrid-routing       (orchestration/, provider/)
       │              ├─ feat/token-consumption    (session/, cli/cmd/tui/)
       │              ├─ feat/memory-consumption   (session/, storage/)
       │              ├─ feat/session-memory       (memory/, session/, tool/)
       │              ├─ feat/permission-flag      (permission/)
       │              ├─ feat/question-tool        (tool/, cli/cmd/tui/)
       │              ├─ feat/lsp-improvements     (lsp/)
       │              ├─ feat/spinner-verbs        (cli/cmd/tui/util/, cli/cmd/tui/component/)
       │              ├─ feat/subagent-navigation  (cli/cmd/tui/routes/session/)
       │              ├─ feat/right-pane-bleed     (cli/cmd/tui/)
       │              ├─ feat/status-dialog        (cli/cmd/tui/command/)
       │              ├─ feat/clear-commands       (cli/cmd/tui/command/)
       │              ├─ feat/btw-command          (cli/cmd/tui/command/, session/)
       │              └─ feat/tui-logo-sound       (cli/cmd/tui/)
       │
       └──────── devlocal (frozen, 50 commits ahead of merge-base)
```

**Rebuild Flow**:

```
  upstream/dev ─┐
                ├─ merge feat/sliding-window      (--no-ff)  [1]
                ├─ merge feat/doom-loop            (--no-ff)  [2]
                ├─ merge feat/parallel-tools       (--no-ff)  [3]
                ├─ merge feat/hybrid-routing       (--no-ff)  [4]
                ├─ merge feat/token-consumption    (--no-ff)  [5]
                ├─ merge feat/memory-consumption   (--no-ff)  [6]
                ├─ merge feat/session-memory       (--no-ff)  [7]
                ├─ merge feat/permission-flag      (--no-ff)  [8]
                ├─ merge feat/question-tool        (--no-ff)  [9]
                ├─ merge feat/lsp-improvements     (--no-ff)  [10]
                ├─ merge feat/spinner-verbs        (--no-ff)  [11]
                ├─ merge feat/subagent-navigation  (--no-ff)  [12]
                ├─ merge feat/right-pane-bleed     (--no-ff)  [13]
                ├─ merge feat/status-dialog        (--no-ff)  [14]
                ├─ merge feat/clear-commands       (--no-ff)  [15]
                ├─ merge feat/btw-command          (--no-ff)  [16]
                ├─ merge feat/tui-logo-sound       (--no-ff)  [17]
                └─▶ devlocal-next
```

**Description**: Each `feat/*` branch is cherry-picked from `devlocal` onto `upstream/dev`. Branches are independently rebaseable. The integration branch `devlocal-next` is ephemeral — destroyed and rebuilt from scratch by `rebuild.sh` on every sync. `devlocal` is never touched. `git rerere` caches conflict resolutions so repeated rebases don't require re-solving the same conflicts.

## Interfaces

### rebuild.sh

| Method   | Input                     | Output              | Behavior                                                     | Errors                          |
| -------- | ------------------------- | ------------------- | ------------------------------------------------------------ | ------------------------------- |
| `main()` | None (reads BRANCH_ORDER) | `devlocal-next` ref | Checkout upstream/dev, create devlocal-next, merge each feat | Merge conflict → abort + report |
| `--dry`  | None                      | stdout: merge plan  | Print merge order without executing                          | None                            |
| `--skip` | branch name               | `devlocal-next` ref | Skip named branch from merge sequence                        | Unknown branch name → exit 1    |

### sync.sh

| Method     | Input       | Output                                  | Behavior                                            | Errors                           |
| ---------- | ----------- | --------------------------------------- | --------------------------------------------------- | -------------------------------- |
| `main()`   | None        | Rebased feat/\* + rebuilt devlocal-next | Fetch upstream, rebase each feat/\*, run rebuild.sh | Rebase conflict → pause + prompt |
| `--branch` | branch name | Single branch rebased                   | Rebase only the named feat/\* branch                | Conflict → abort rebase, report  |
| `--force`  | None        | Same as main                            | Use `-X ours` on conflicts (local wins)             | None (conflicts auto-resolved)   |

### verify.sh

| Method   | Input                       | Output   | Behavior                     | Errors                       |
| -------- | --------------------------- | -------- | ---------------------------- | ---------------------------- |
| `main()` | None (runs on current HEAD) | exit 0/1 | Run typecheck + test + build | Non-zero exit on any failure |

### diff-check.sh

| Method   | Input | Output               | Behavior                                                   | Errors                           |
| -------- | ----- | -------------------- | ---------------------------------------------------------- | -------------------------------- |
| `main()` | None  | stdout: diff summary | `git diff --stat devlocal devlocal-next`; flag regressions | Non-zero if unexpected deletions |

## Data Flow

### Rebuild Flow

| Step | Component     | Action                                                                     | Next               |
| ---- | ------------- | -------------------------------------------------------------------------- | ------------------ |
| 1    | rebuild.sh    | `git checkout upstream/dev`                                                | Step 2             |
| 2    | rebuild.sh    | `git checkout -B devlocal-next`                                            | Step 3             |
| 3    | rebuild.sh    | `git merge --no-ff feat/<branch> -m "merge: <branch>"` (loop, 17 branches) | Step 4 or conflict |
| 4    | verify.sh     | typecheck + test + build                                                   | Step 5             |
| 5    | diff-check.sh | Compare tree vs devlocal                                                   | Done               |

### Sync Flow (upstream moved)

| Step | Component  | Action                                                    | Next               |
| ---- | ---------- | --------------------------------------------------------- | ------------------ |
| 1    | sync.sh    | `git fetch upstream`                                      | Step 2             |
| 2    | sync.sh    | For each feat/\* (17 branches): `git rebase upstream/dev` | Step 3 or conflict |
| 3    | git rerere | Auto-apply cached resolutions                             | Step 4             |
| 4    | sync.sh    | Call `rebuild.sh`                                         | Step 5             |
| 5    | verify.sh  | Full verification on devlocal-next                        | Done               |

### Conflict Flow

| Step | Component  | Action                                          | Next          |
| ---- | ---------- | ----------------------------------------------- | ------------- |
| 1    | git rebase | Conflict detected                               | Step 2        |
| 2    | git rerere | Check rr-cache for known resolution             | Step 3a or 3b |
| 3a   | git rerere | Resolution found → auto-apply → continue rebase | Done          |
| 3b   | operator   | Manual resolution → `git rerere` records it     | Step 4        |
| 4    | git rebase | `git rebase --continue`                         | Done          |

**Error Flows**:

- Merge conflict in rebuild.sh → script aborts, prints failing branch + conflicting files, exits non-zero
- Rebase conflict in sync.sh → pauses, prints instructions, operator resolves manually (rerere assists)
- verify.sh failure → devlocal-next is NOT promoted; operator investigates failing branch
- Unresolvable conflict → branch flagged for "port needed" (see Rollback Strategy)

## Data Model

| Entity             | Fields                                                         | Relationships                      | Constraints                               |
| ------------------ | -------------------------------------------------------------- | ---------------------------------- | ----------------------------------------- |
| Feature Branch     | name: string, commits: sha[], status: active\|dropped\|porting | Based on upstream/dev              | Each commit belongs to exactly one branch |
| Merge Order        | position: int (1–17), branch: string, depends_on: string[]     | References Feature Branches        | Position determines rebuild sequence      |
| Rerere Resolution  | conflict_id: hash, resolution: patch                           | Tied to file path + conflict       | Auto-applied on matching conflict         |
| Integration Branch | name: "devlocal-next", base: upstream/dev sha                  | Merges all active Feature Branches | Ephemeral — rebuilt from scratch          |

## Merge Ordering & Dependency Graph

### Merge Order (rebuild.sh sequence)

| Position | Branch                   | Depends On          | Rationale                                                                                 |
| -------- | ------------------------ | ------------------- | ----------------------------------------------------------------------------------------- |
| 1        | feat/sliding-window      | None                | Core infra change (context compaction); many branches depend                              |
| 2        | feat/doom-loop           | None                | Touches orchestration/ + session/; independent but foundational                           |
| 3        | feat/parallel-tools      | None                | Touches tool/ + session/; may interact with orchestration                                 |
| 4        | feat/hybrid-routing      | None                | Touches orchestration/ + provider/; after parallel-tools to avoid orchestration conflicts |
| 5        | feat/token-consumption   | None                | Touches session/ + cli/; after core session changes                                       |
| 6        | feat/memory-consumption  | None                | Touches session/ + storage/; after token-consumption                                      |
| 7        | feat/session-memory      | feat/sliding-window | Memory interacts with compaction window API                                               |
| 8        | feat/permission-flag     | None                | Isolated (permission/); no overlap                                                        |
| 9        | feat/question-tool       | None                | Touches tool/ + cli/; after parallel-tools (tool/ overlap)                                |
| 10       | feat/lsp-improvements    | None                | Isolated (lsp/); no overlap                                                               |
| 11       | feat/spinner-verbs       | None                | Isolated TUI util/component change                                                        |
| 12       | feat/subagent-navigation | None                | Isolated TUI routes/session change                                                        |
| 13       | feat/right-pane-bleed    | None                | Isolated TUI layout fix                                                                   |
| 14       | feat/status-dialog       | None                | Isolated TUI command                                                                      |
| 15       | feat/clear-commands      | None                | Isolated TUI command                                                                      |
| 16       | feat/btw-command         | None                | TUI command + session/; after session changes settled                                     |
| 17       | feat/tui-logo-sound      | None                | Isolated TUI cosmetic; last (lowest risk)                                                 |

**Ordering Principle**: Core infrastructure branches first (positions 1–6) — these touch `session/`, `orchestration/`, `provider/`, `tool/` and establish the base for dependent branches. Dependent branches follow their dependencies (position 7: session-memory after sliding-window). Isolated branches (positions 8–17) are ordered to minimize conflict surface: non-overlapping directories first, TUI-only changes last. `feat/sliding-window` is first because it's the largest change and most likely to conflict with others.

### Dependency Graph

```
  feat/sliding-window ◀──── feat/session-memory (depends: compaction API)
         │
         │ (soft ordering dependency — shared session/ files)
         ▼
  feat/doom-loop ──────── independent (orchestration/ + session/)
         │
         ▼
  feat/parallel-tools ─── independent (tool/ + session/)
         │
         │ (ordering: orchestration/ overlap with hybrid-routing)
         ▼
  feat/hybrid-routing ─── independent (orchestration/ + provider/)

  feat/token-consumption ── independent (session/ + cli/)
  feat/memory-consumption ─ independent (session/ + storage/)
  feat/permission-flag ──── independent (permission/)
  feat/question-tool ────── independent (tool/ + cli/)
  feat/lsp-improvements ─── independent (lsp/)
  feat/spinner-verbs ────── independent (cli/cmd/tui/util/ + component/)
  feat/subagent-navigation ─ independent (cli/cmd/tui/routes/session/)
  feat/right-pane-bleed ─── independent (cli/cmd/tui/)
  feat/status-dialog ────── independent (cli/cmd/tui/command/)
  feat/clear-commands ───── independent (cli/cmd/tui/command/)
  feat/btw-command ──────── independent (cli/cmd/tui/command/ + session/)
  feat/tui-logo-sound ───── independent (cli/cmd/tui/)
```

**Hard dependency**: session-memory → sliding-window (compaction API).
**Soft ordering**: doom-loop, parallel-tools, hybrid-routing share orchestration/ files — merging in sequence reduces conflict surface.
**Soft ordering**: token-consumption, memory-consumption, btw-command share session/ files — merging after core session branches reduces conflicts.

## Conflict Surface Map

| Feature Branch             | Directories Touched                       | Files (key)                                         | Overlap Risk         |
| -------------------------- | ----------------------------------------- | --------------------------------------------------- | -------------------- |
| `feat/sliding-window`      | session/, provider/                       | session/prompt.ts, session/processor.ts             | HIGH (session/)      |
| `feat/doom-loop`           | orchestration/, session/                  | orchestration/index.ts, session/index.ts            | MED (session/)       |
| `feat/parallel-tools`      | tool/, session/                           | tool/registry.ts, session/processor.ts              | MED (session/)       |
| `feat/hybrid-routing`      | orchestration/, provider/                 | orchestration/index.ts, provider/index.ts           | MED (orchestration/) |
| `feat/token-consumption`   | session/, cli/cmd/tui/                    | session/index.ts, cli/cmd/tui/component/            | MED (session/)       |
| `feat/memory-consumption`  | session/, storage/                        | session/index.ts, storage/index.ts                  | MED (session/)       |
| `feat/session-memory`      | memory/, session/, tool/                  | memory/index.ts, session/prompt.ts                  | HIGH (session/)      |
| `feat/permission-flag`     | permission/                               | permission/index.ts                                 | LOW                  |
| `feat/question-tool`       | tool/, cli/cmd/tui/                       | tool/question.ts, cli/cmd/tui/component/            | LOW                  |
| `feat/lsp-improvements`    | lsp/                                      | lsp/index.ts                                        | LOW                  |
| `feat/spinner-verbs`       | cli/cmd/tui/util/, cli/cmd/tui/component/ | cli/cmd/tui/util/spinner.ts, cli/cmd/tui/component/ | LOW                  |
| `feat/subagent-navigation` | cli/cmd/tui/routes/session/               | cli/cmd/tui/routes/session/index.ts                 | LOW                  |
| `feat/right-pane-bleed`    | cli/cmd/tui/                              | cli/cmd/tui/component/                              | LOW                  |
| `feat/status-dialog`       | cli/cmd/tui/command/                      | cli/cmd/tui/command/status.ts                       | LOW                  |
| `feat/clear-commands`      | cli/cmd/tui/command/                      | cli/cmd/tui/command/clear.ts                        | LOW                  |
| `feat/btw-command`         | cli/cmd/tui/command/, session/            | cli/cmd/tui/command/btw.ts, session/index.ts        | MED (session/)       |
| `feat/tui-logo-sound`      | cli/cmd/tui/                              | cli/cmd/tui/app.tsx                                 | LOW                  |

### Conflict Hotspots (files touched by multiple branches)

| File                     | Branches                                                                              | Risk Level           |
| ------------------------ | ------------------------------------------------------------------------------------- | -------------------- |
| `session/prompt.ts`      | feat/sliding-window, feat/session-memory                                              | HIGH                 |
| `session/index.ts`       | feat/doom-loop, feat/token-consumption, feat/memory-consumption, feat/btw-command     | HIGH                 |
| `session/processor.ts`   | feat/sliding-window, feat/parallel-tools                                              | MED                  |
| `orchestration/index.ts` | feat/doom-loop, feat/hybrid-routing                                                   | MED                  |
| `cli/cmd/tui/component/` | feat/token-consumption, feat/question-tool, feat/spinner-verbs, feat/right-pane-bleed | MED                  |
| `cli/cmd/tui/command/`   | feat/status-dialog, feat/clear-commands, feat/btw-command                             | LOW (separate files) |
| `tool/`                  | feat/parallel-tools, feat/question-tool, feat/session-memory                          | MED                  |

## Sync Workflow (When Upstream Moves)

### Step-by-Step Sync Ritual

```
┌─────────────────────────────────────────────────────────────┐
│  WEEKLY SYNC RITUAL (or on-demand when upstream has changes) │
└─────────────────────────────────────────────────────────────┘

Step 1: Fetch
    $ git fetch upstream

Step 2: Check divergence
    $ git log --oneline upstream/dev..devlocal-next | wc -l
    (Understand how much upstream moved)

Step 3: Rebase each feat/* branch (17 branches)
    For each branch in MERGE_ORDER:
        $ git checkout feat/<name>
        $ git rebase upstream/dev
        IF conflict:
            → git rerere attempts auto-resolution
            → If auto-resolved: git rebase --continue
            → If manual needed: resolve, git add, git rebase --continue
            → rerere records new resolution for future
        $ ./verify.sh  (quick typecheck on branch alone)

Step 4: Rebuild integration
    $ ./rebuild.sh

Step 5: Verify integration
    $ ./verify.sh
    $ ./diff-check.sh

Step 6: Record state
    $ git log --oneline devlocal-next | head -30
    (Confirm all 17 feat/* merged successfully)
```

### Cadence

| Trigger                       | Action                                    |
| ----------------------------- | ----------------------------------------- |
| Weekly (scheduled)            | Full sync: fetch + rebase all + rebuild   |
| Upstream major refactor       | Immediate sync of affected feat/\* branch |
| Before submitting PR          | Sync target feat/\* branch only           |
| After feat/\* branch accepted | Remove from MERGE_ORDER, rebuild          |

## Rollback Strategy

### If a feat/\* branch becomes unmergeable

```
Decision Tree:
                    ┌─ feat/* rebase fails ─┐
                    │                        │
              ┌─────▼──────┐          ┌─────▼──────┐
              │ rerere has  │          │ rerere has  │
              │ resolution? │          │ NO match    │
              └──────┬──────┘          └──────┬──────┘
                     │ YES                    │
                     ▼                        ▼
              Auto-resolve              Manual resolution
              continue rebase           attempt (≤30 min)
                                              │
                                    ┌─────────┼──────────┐
                                    │         │          │
                                    ▼         ▼          ▼
                              Resolved   Too complex   Upstream
                              (record    (>30 min)     rewrote
                               rerere)                  entirely
                                              │          │
                                              ▼          ▼
                                    ┌─────────────────────────┐
                                    │  ROLLBACK OPTIONS:       │
                                    │                          │
                                    │  A) --skip from rebuild  │
                                    │     (rebuild.sh --skip   │
                                    │      feat/<name>)        │
                                    │                          │
                                    │  B) Park branch          │
                                    │     (mark status=porting │
                                    │      reimplement later   │
                                    │      on new upstream)    │
                                    │                          │
                                    │  C) Squash + force-adapt │
                                    │     (squash feat/* into  │
                                    │      1 commit, manually  │
                                    │      rewrite on new base)│
                                    └─────────────────────────┘
```

### Rollback Guarantees

| Scenario                         | Recovery                                            | Data Loss    |
| -------------------------------- | --------------------------------------------------- | ------------ |
| feat/\* rebase fails mid-way     | `git rebase --abort` → branch unchanged             | None         |
| rebuild.sh merge conflict        | Script aborts → devlocal-next at last good merge    | None         |
| devlocal-next verification fails | Previous devlocal-next still exists as reflog entry | None         |
| Feature branch abandoned         | Remove from MERGE_ORDER → rebuild without it        | Feature only |
| All branches unmergeable         | `devlocal` still frozen as complete fallback        | None         |

## Decision Tree: Upstream Rewrote a File My Feature Touches

```
Upstream changed file F that feat/<X> also modifies
                    │
                    ▼
        ┌───────────────────────┐
        │ What kind of change?  │
        └───────────┬───────────┘
                    │
        ┌───────────┼────────────────────┐
        │           │                    │
        ▼           ▼                    ▼
   Additive      Refactor/Move       Complete Rewrite
   (new code,    (rename, extract,   (file deleted/replaced,
    new exports)  restructure)        new API surface)
        │           │                    │
        ▼           ▼                    ▼
   EASY:         MODERATE:            HARD:
   Rebase will   Conflicts likely     Cannot rebase.
   auto-merge    but resolvable       Must reimplement.
        │           │                    │
        ▼           ▼                    ▼
   Action:       Action:              Action:
   Normal sync   1. Rebase feat/<X>   1. Mark feat/<X>
   (no special      on new upstream      status=porting
    handling)    2. Resolve conflicts  2. Remove from
                 3. Record rerere         MERGE_ORDER
                 4. Verify             3. Reimplement
                                          feature on new
                                          upstream code
                                       4. Create new
                                          feat/<X>-v2
                                       5. Add to
                                          MERGE_ORDER
```

### Specific Scenarios

| Upstream Change                     | Affected Branch(es)                                                                   | Action                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| session/prompt.ts refactored        | feat/sliding-window, feat/session-memory                                              | Rebase sliding-window first (largest); session-memory after |
| session/index.ts refactored         | feat/doom-loop, feat/token-consumption, feat/memory-consumption, feat/btw-command     | Rebase in merge-order sequence; rerere assists              |
| session/processor.ts refactored     | feat/sliding-window, feat/parallel-tools                                              | Rebase sliding-window first; parallel-tools adapts          |
| orchestration/index.ts restructured | feat/doom-loop, feat/hybrid-routing                                                   | Rebase doom-loop first; hybrid-routing adapts               |
| provider/ pricing model changed     | feat/sliding-window, feat/hybrid-routing                                              | Rebase; adapt to new model                                  |
| cli/cmd/tui/component/ restructured | feat/token-consumption, feat/question-tool, feat/spinner-verbs, feat/right-pane-bleed | Rebase in order; isolated files reduce cross-conflict       |
| tool/ API changed                   | feat/parallel-tools, feat/question-tool, feat/session-memory                          | Rebase parallel-tools first; others adapt                   |
| lsp/ rewritten                      | feat/lsp-improvements                                                                 | Evaluate: fixes may be obsolete → drop branch               |
| memory/ introduced upstream         | feat/session-memory                                                                   | Port: reimplement on upstream's memory model                |
| cli/cmd/tui/app.tsx restructured    | feat/tui-logo-sound                                                                   | Rebase; re-apply TUI changes to new structure               |
| permission/ refactored              | feat/permission-flag                                                                  | Small scope; likely trivial rebase                          |
| storage/ refactored                 | feat/memory-consumption                                                               | Rebase; adapt caching to new storage API                    |

## Decisions

| Decision                     | Choice                            | Reason                                                           | Alternatives                  | Tradeoffs                                                  |
| ---------------------------- | --------------------------------- | ---------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------- |
| Integration strategy         | Merge (not rebase)                | Preserves individual branch identity; easy to drop/add           | Single rebase onto upstream   | Merge commits add noise; but rebuild-from-scratch negates  |
| Integration branch lifecycle | Throwaway (rebuild each time)     | No accumulated merge debt; always clean                          | Long-lived integration branch | Slower rebuild; but 17 merges still fast (<60s)            |
| Conflict policy              | Local wins (`-X ours`)            | Preserves local features; upstream ported later                  | Upstream wins                 | May miss upstream improvements; mitigated by weekly review |
| Merge order                  | Independent first, dependent last | Reduces cascading conflicts                                      | Alphabetical / random         | Requires manual dependency tracking                        |
| devlocal disposition         | Frozen forever                    | Guaranteed rollback; diff baseline                               | Delete after validation       | Uses branch namespace; negligible cost                     |
| rerere                       | Enabled + autoupdate              | Eliminates repeated manual conflict resolution                   | Manual resolution each time   | rr-cache grows; can prune periodically                     |
| Branch count (17)            | All features as separate branches | Maximum isolation; any branch can be dropped/added independently | Fewer larger branches         | More branches = longer sync; but most are 1–3 commits      |
| Verification granularity     | Per-branch + integration          | Catches issues early (per-branch) and late (integration)         | Integration-only              | Slower overall; but prevents cascading failures            |

## Risks

| Risk                                              | Impact                                                                                                          | Likelihood | Mitigation                                                      |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------- |
| Cherry-pick conflicts during branch creation      | Blocks branch creation                                                                                          | Med        | Small scope (1–7 commits); rerere caches solutions              |
| Hidden inter-branch dependencies                  | feat/A + feat/B merge breaks build                                                                              | Med        | Verify pairwise merges; stable merge order; integration tests   |
| devlocal-next diverges from devlocal behavior     | Subtle regressions                                                                                              | Med        | diff-check.sh; full test suite; keep devlocal as fallback       |
| Upstream rewrites session/ entirely               | feat/sliding-window + session-memory + doom-loop + parallel-tools + token/memory-consumption + btw-command dead | Low        | Accept upstream, reimplement (flag as "port needed")            |
| rebuild.sh merge order matters                    | Order change → different conflict set                                                                           | Med        | Document + enforce order; independent branches first            |
| rerere applies stale resolution                   | Silent wrong merge                                                                                              | Low        | verify.sh after every rebuild; prune old rr-cache entries       |
| 17 branches = maintenance burden                  | Weekly sync takes longer (~15-20 min)                                                                           | Med        | Most are 1–3 commits; only sliding-window is large (7+)         |
| Operator forgets weekly sync                      | Large divergence → painful rebase                                                                               | Med        | Calendar reminder; consider CI automation                       |
| Too many conflicts across branches simultaneously | Sync takes hours                                                                                                | Low        | Prioritize: sync critical branches first; park others           |
| session/ hotspot (6 branches touch it)            | Cascading conflicts during rebuild                                                                              | Med        | Strict merge order; session-touching branches early in sequence |
| cli/cmd/tui/ has 10 branches touching it          | TUI component conflicts                                                                                         | Low        | Most touch different subdirs/files; low actual overlap          |

## Test Plan

### Unit Tests (Per Feature Branch)

For each `feat/*` branch independently:

| Branch                   | Verification                                                                | Pass Criteria               |
| ------------------------ | --------------------------------------------------------------------------- | --------------------------- |
| feat/sliding-window      | `bun --cwd packages/opencode typecheck && bun --cwd packages/opencode test` | Zero errors, all tests pass |
| feat/doom-loop           | Same                                                                        | Same                        |
| feat/parallel-tools      | Same                                                                        | Same                        |
| feat/hybrid-routing      | Same                                                                        | Same                        |
| feat/token-consumption   | Same                                                                        | Same                        |
| feat/memory-consumption  | Same                                                                        | Same                        |
| feat/session-memory      | Same                                                                        | Same                        |
| feat/permission-flag     | Same                                                                        | Same                        |
| feat/question-tool       | Same                                                                        | Same                        |
| feat/lsp-improvements    | Same                                                                        | Same                        |
| feat/spinner-verbs       | Same                                                                        | Same                        |
| feat/subagent-navigation | Same                                                                        | Same                        |
| feat/right-pane-bleed    | Same                                                                        | Same                        |
| feat/status-dialog       | Same                                                                        | Same                        |
| feat/clear-commands      | Same                                                                        | Same                        |
| feat/btw-command         | Same                                                                        | Same                        |
| feat/tui-logo-sound      | Same                                                                        | Same                        |

**Method**: Merge feat/\* into upstream/dev (temp branch), run verify.sh, delete temp branch.

### Integration Tests (devlocal-next)

| Test                  | Method                                             | Pass Criteria                          |
| --------------------- | -------------------------------------------------- | -------------------------------------- |
| Full build            | `bun --cwd packages/opencode run build`            | Exit 0                                 |
| Full typecheck        | `bun --cwd packages/opencode typecheck`            | Zero errors                            |
| Full test suite       | `bun --cwd packages/opencode test --timeout 30000` | All tests pass                         |
| Feature parity        | `./diff-check.sh` (diff vs devlocal)               | No unexpected deletions/regressions    |
| Pairwise merge sanity | For conflict-hotspot pairs: merge A+B, verify      | No build breaks from pair interactions |

#### Pairwise Conflict Hotspot Pairs to Verify

| Pair                                         | Shared Surface         | Priority |
| -------------------------------------------- | ---------------------- | -------- |
| sliding-window + session-memory              | session/prompt.ts      | HIGH     |
| sliding-window + parallel-tools              | session/processor.ts   | HIGH     |
| doom-loop + hybrid-routing                   | orchestration/index.ts | MED      |
| doom-loop + token-consumption                | session/index.ts       | MED      |
| token-consumption + memory-consumption       | session/index.ts       | MED      |
| token-consumption + btw-command              | session/index.ts       | MED      |
| parallel-tools + question-tool               | tool/                  | LOW      |
| spinner-verbs + right-pane-bleed             | cli/cmd/tui/component/ | LOW      |
| status-dialog + clear-commands + btw-command | cli/cmd/tui/command/   | LOW      |

### End-to-End Tests

| Workflow                    | Steps                                        | Success Criteria                            |
| --------------------------- | -------------------------------------------- | ------------------------------------------- |
| Full rebuild from scratch   | Run `rebuild.sh` on clean upstream/dev       | devlocal-next created, verify.sh passes     |
| Sync after upstream advance | Advance upstream 5 commits, run `sync.sh`    | All 17 feat/\* rebase clean, rebuild passes |
| Drop a branch               | Remove any feat/\* from order, rebuild       | devlocal-next builds without it             |
| Add new branch              | Create feat/new-thing, add to order, rebuild | Merges cleanly into devlocal-next           |
| Rollback scenario           | Force-fail one branch, use --skip, rebuild   | devlocal-next builds without failed branch  |
| Skip multiple branches      | --skip 3 branches simultaneously, rebuild    | devlocal-next builds with remaining 14      |

### Non-Functional Tests

| Requirement         | Target                                  | Verification                        |
| ------------------- | --------------------------------------- | ----------------------------------- |
| Rebuild speed       | `rebuild.sh` completes in <60s          | Time the script                     |
| Sync speed          | Full sync (17 branches) in <20min       | Time sync.sh end-to-end             |
| Conflict resolution | ≤2 manual conflicts per branch per sync | Count during sync ritual            |
| Recovery time       | Rollback to working state in <5min      | Test `git rebase --abort` + rebuild |

### Done Criteria (from PLAN)

- Each `feat/*` branch rebases onto latest `upstream/dev` with ≤2 conflicts
- `rebuild.sh` produces a green integration branch (typecheck + test + build pass)
- `diff-check.sh` shows feature parity with `devlocal`
- All 17 branches merge cleanly in defined order
- `devlocal` remains frozen and untouched
