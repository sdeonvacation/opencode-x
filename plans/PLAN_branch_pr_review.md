# Plan: Branch PR Review

## Overview

Extend subagent orchestration with a new `isolation: "branch-pr"` mode where each subagent works in an isolated detached worktree. Instead of blind cherry-pick, the primary agent receives the diff for autonomous code review before applying. On approve, changes are applied as uncommitted file modifications in the user's working directory. No real git commits happen until the user explicitly commits.

## Tech Stack

- TypeScript / Effect-ts (existing orchestration patterns)
- Git CLI (detached worktree create, diff, cleanup)
- Bun subprocess (existing `exec` helper in worktree.ts)
- SQLite (track PR state metadata)

## Testing Strategy

- Unit: worktree creation, diff extraction, file-apply logic, review prompt assembly
- Integration: full task → worktree → review → apply cycle via test fixture
- Done when: `bun --cwd packages/opencode test` passes, new tests cover happy path + conflict + rejection

## Isolation Mode Selection (Per-Task, Not Global)

The primary agent decides per-task whether to use `isolation: "branch-pr"`. It is NOT a global toggle — it's a judgment call based on subagent type and task nature.

| Subagent Type         | Branch Isolation? | Rationale                                      |
| --------------------- | ----------------- | ---------------------------------------------- |
| Coder (parallel)      | ✅ Yes            | Avoids edit conflicts, enables review          |
| Coder (single)        | Optional          | Benefit is review gate, not conflict avoidance |
| Tester / Runner       | ❌ No             | Read-only, no file mutations to review         |
| Researcher / Explorer | ❌ No             | Read-only, no file changes                     |
| Documenter            | Optional          | Low-risk edits, review may be overkill         |

Agent system prompt instructs primary agent: "Use `isolation: 'branch-pr'` when spawning agents that write code, especially in parallel. Skip for read-only agents."

Config option `experimental.branch_pr_default_agents` can list agent types that always get branch isolation (override for the prompt-based heuristic).

## Parallel & Background Subagent Guarantees

- **One detached worktree per subagent**: Every subagent (foreground or background) that uses `isolation: "branch-pr"` gets its own detached worktree. Parallel subagents never share a worktree.
- **Background subagents**: When `background: true` + `isolation: "branch-pr"`, the worktree is created immediately but the PR review happens asynchronously. On completion, a `BranchPR.Ready` event fires. The primary agent is notified (toast + injected context) and reviews on next turn.
- **Apply ordering**: When multiple branch PRs are ready simultaneously, the primary agent reviews and applies sequentially (one at a time). Sequential applies with conflict detection per-file.
- **Conflict detection**: If applying subagent A's changes modifies files that subagent B also changed, B's apply reports per-file conflicts. Primary agent rejects conflicting PR and re-dispatches.

## Upstream Rebase Safety

Critical constraint: all changes must survive `git rebase` onto upstream `dev`.

**Principles:**

1. **New files over modifications** — maximize additive files, minimize edits to hot files
2. **task.ts**: Extract branch-pr execution logic into a separate handler module (`branch-pr-handler.ts`). task.ts gets a single-line call: `if (isolation === "branch-pr") return branchPRHandler(...)`. Minimal diff surface.
3. **config.ts**: Append new experimental fields at the END of the schema object (after all existing fields). Never intersperse.
4. **DO NOT TOUCH prompt.ts or detached-notes.ts** — these have `#FORK` markers (fork-specific cherry-picked code). Instead, hook push-to-background via Bus event subscription (`BranchPR` module subscribes to `OrchestrationEvent.Complete` or child session end event).
5. **No restructuring** — no renaming, no moving existing code, no refactoring existing functions
6. **Feature-gated** — entire feature behind `experimental.branch_pr_review`. Zero impact when disabled.

**File Touch Budget:**

| File                       | Allowed Change                                       | Max Lines |
| -------------------------- | ---------------------------------------------------- | --------- |
| `task.ts`                  | Add `"branch-pr"` to isolation enum + 1 handler call | ~5 lines  |
| `config.ts`                | Append experimental fields at end of schema          | ~15 lines |
| `prompt.ts`                | ❌ DO NOT MODIFY                                     | 0         |
| `detached-notes.ts`        | ❌ DO NOT MODIFY                                     | 0         |
| New files (orchestration/) | Full implementation                                  | Unlimited |

## Phases

### Phase 1: Worktree Lifecycle Module

- Step 1: Create `src/orchestration/branch-pr.ts` — detached worktree create, diff extraction, file-apply, cleanup
- Step 2: Worktree naming convention: worktree in `os.tmpdir()` as `opencode-<session-id-short>-<slug>` (unique per subagent)
- Step 3: Diff extraction: compare worktree state vs base (`git diff` of uncommitted changes), return structured diff (files changed, insertions, deletions, raw patch)
- Step 4: File-apply logic: copy changed files from worktree to real working directory as uncommitted modifications
- Step 5: Conflict detection: before applying each file, verify target file in real directory matches base version (detect intervening modifications)
- Step 6: Cleanup: remove worktree (`git worktree remove`)

### Phase 2: PR Metadata & State

- Step 1: Define `BranchPR` type — worktree path, base ref, session ID, diff summary, state (open/applied/rejected/conflict)
- Step 2: Store PR state in session metadata or dedicated table (lightweight — worktree path + state + review notes)
- Step 3: Bus events: `BranchPR.Created`, `BranchPR.Reviewed`, `BranchPR.Applied`, `BranchPR.Rejected`

### Phase 3: Task Tool Integration

- Step 1: Add `"branch-pr"` to `isolation` enum in task.ts parameters
- Step 2: When `isolation === "branch-pr"`: create detached worktree (via Phase 1 module), run subagent in it
- Step 3: After subagent completes: extract diff from worktree state (no commit needed), return PR metadata to primary agent instead of applying immediately
- Step 4: Output format: structured diff summary + worktree reference so primary agent can review
- Step 5: **Background path**: when `background: true` + `isolation: "branch-pr"`, worktree created at spawn, PR metadata emitted via `BranchPR.Ready` bus event on completion. Toast notifies primary agent. Review happens on next primary agent turn (injected as pending review context).
- Step 6: **Parallel foreground**: multiple foreground subagents each get own worktree. All diffs returned to primary agent in single response. Primary reviews sequentially.

### Phase 4: Autonomous Review Flow

- Step 1: New tool or internal function: `review_branch_pr` — accepts branch PR metadata, generates review prompt
- Step 2: Review prompt assembly: include diff patch, file list, subagent's summary
- Step 3: Primary agent receives review context in tool output, decides: approve (apply) or reject (cleanup)
- Step 4: If approved: apply files (copy changed files from worktree to working directory as uncommitted modifications), cleanup worktree
- Step 5: If rejected: cleanup worktree, optionally re-invoke subagent with review feedback in a fresh worktree

### Phase 5: Configuration & Feature Flag

- Step 1: Add `experimental.branch_pr_review` config flag (enables the feature)
- Step 2: Add `experimental.branch_pr_auto_apply` — if true, skip review and auto-apply (escape hatch for trusted subagents)
- Step 3: Agent system prompt update: instruct primary agent how to use `isolation: "branch-pr"` and handle review results
- Step 4: Add `experimental.branch_pr_default_agents` — list of agent types that always get branch isolation

## Risks

- **Diff size**: Large diffs may exceed context window → Mitigation: truncate to changed files summary + first N lines, let agent request full file diffs
- **Apply conflicts**: Another subagent's apply modified the same file → Mitigation: per-file conflict detection before overwrite, report to primary agent
- **Review quality**: AI may rubber-stamp everything → Mitigation: configurable review strictness, option to escalate to user on large changes
- **Performance**: Extra git operations add latency → Mitigation: git operations are fast locally, diff extraction is single command
- **Background race**: Multiple background subagents complete simultaneously → Mitigation: sequential apply queue, conflict detection on each apply
- **Worktree disk usage**: Detached worktrees share git objects but duplicate working files → Mitigation: TTL-based cleanup sweep, worktrees in tmpdir (OS helps)
- **Stale worktrees from crashes**: Process dies mid-work → Mitigation: startup cleanup sweep for orphaned worktrees with no active session, TTL-based removal
