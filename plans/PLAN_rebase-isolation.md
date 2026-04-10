# Plan: Rebase Isolation — Make Local Branch Upstream-Rebase-Safe

## Overview

The local `dev` branch has 67 commits ahead of `upstream/dev`, touching 177 files with heavy inline edits in 5 core files (`prompt.ts`, `registry.ts`, `processor.ts`, `app.tsx`, `task.ts`). Every rebase attempt triggers cascading conflicts because local feature logic is woven directly into upstream code. This plan extracts local features into isolated modules with minimal upstream touch points, then reorganizes the git history into clean, independently-rebaseable feature commits.

## Tech Stack

- TypeScript 5.8.2 + Bun 1.3.11 (existing)
- Effect 4.0.0-beta.43 service/layer pattern (existing)
- No new dependencies required — purely structural refactoring

## Testing Strategy

- **Unit**: Each extracted module gets its own test file (many already exist under `test/`)
- **Integration**: After each phase, run `bun --cwd packages/opencode test` + `bun --cwd packages/opencode typecheck` + `bun --cwd packages/opencode run build`
- **Regression**: Existing 37 local test files serve as regression suite
- **Done when**: `git rebase upstream/dev` completes with ≤5 trivially-resolvable conflicts (down from current ~30+), AND all tests/typecheck/build pass

## Phases

### Phase 1: Extract Inline Logic from Core Files (Code Restructuring)

**Goal**: Reduce inline edits in the 5 most conflict-prone files to ≤10 lines each.

#### 1A: Extract from `prompt.ts` (~350 lines extractable)

| Extract             | Target Module                 | Lines | Hook in `prompt.ts` |
| ------------------- | ----------------------------- | ----- | ------------------- |
| `insertReminders()` | `session/prompt-reminders.ts` | ~142  | 1 import + 1 call   |
| `handleSubtask()`   | `session/subtask-handler.ts`  | ~207  | 1 import + 1 call   |

- After extraction: `prompt.ts` local diff drops from +271 to ~30 lines (imports + hook calls)

#### 1B: Extract from `app.tsx` (~260 lines extractable)

| Extract                     | Target Module                       | Lines | Hook in `app.tsx` |
| --------------------------- | ----------------------------------- | ----- | ----------------- |
| Event listeners setup       | `tui/effect/app-event-listeners.ts` | ~77   | 1 import + 1 call |
| `/btw` command              | `tui/command/btw-command.tsx`       | ~76   | 1 array entry     |
| Terminal title effect       | `tui/component/terminal-title.tsx`  | ~24   | 1 component       |
| Copy-on-select handler      | `tui/util/copy-handler.ts`          | ~34   | 1 function call   |
| `/goto` command logic       | `tui/command/goto-command.tsx`      | ~25   | 1 array entry     |
| `/clear` + `/clear-compact` | `tui/command/clear-commands.tsx`    | ~30   | 2 array entries   |

- After extraction: `app.tsx` local diff drops from +434 to ~45 lines (imports + registrations)

#### 1B-extra: Subagent Click Navigation Fix (PRESERVE AS-IS)

The subagent click navigation fix (`routes/session/index.tsx`) sorts child sessions by `time.created` instead of session ID to match task-part ordering. This was a hard-won fix across multiple attempts. The extracted `task-session-id.ts` module handles session ID resolution via cache + time-ordered fallback. Both the module (new file) and the inline sort fix (~5 lines in `index.tsx`) must be preserved exactly.

#### 1C: Extract from `registry.ts` (~46 lines extractable)

| Extract                       | Target Module               | Lines | Hook in `registry.ts` |
| ----------------------------- | --------------------------- | ----- | --------------------- |
| `pluginDefinitionSignature()` | `tool/plugin-signature.ts`  | ~22   | 1 import + 1 call     |
| Plugin hook WeakMap cache     | `tool/plugin-hook-cache.ts` | ~10   | 1 import + init       |
| Tool filter rules             | `tool/tool-filter.ts`       | ~14   | 1 import + 1 call     |

- After extraction: `registry.ts` local diff drops from +319/-212 to ~40 lines

#### 1D: Extract from `processor.ts` (~25 lines extractable)

| Extract                | Target Module                  | Lines | Hook in `processor.ts` |
| ---------------------- | ------------------------------ | ----- | ---------------------- |
| Reasoning part handler | `session/reasoning-handler.ts` | ~25   | 1 import + 1 call      |

- `doom-loop.ts` and `part-coalescer.ts` already extracted — good pattern
- After extraction: `processor.ts` local diff drops from +123 to ~20 lines

#### 1E: Extract from `task.ts` (~55 lines extractable)

| Extract                  | Target Module                          | Lines | Hook in `task.ts` |
| ------------------------ | -------------------------------------- | ----- | ----------------- |
| Spawn reservation logic  | `orchestration/task-spawn.ts`          | ~40   | 1 import + 1 call |
| Model resolution compose | `orchestration/task-model-resolver.ts` | ~15   | 1 import + 1 call |

- After extraction: `task.ts` local diff drops from +326/-89 to ~30 lines

#### Phase 1 Verification

- `bun --cwd packages/opencode test` — all pass
- `bun --cwd packages/opencode typecheck` — clean
- `bun --cwd packages/opencode run build` — success
- `git diff --stat upstream/dev..dev` — conflict-prone files show ≤50 lines changed each

---

### Phase 2: Isolate Generated/Data Files

**Goal**: Ensure generated artifacts don't pollute rebase diffs.

- Step 1: Add `models-snapshot.js` to `.gitattributes` with `merge=ours` strategy (or regenerate post-rebase instead of carrying the diff)
- Step 2: Ensure `graphify-out/` is in `.gitignore` (already done) — verify no tracked files remain
- Step 3: Move any local-only config/data artifacts to clearly-separated paths if needed

---

### Phase 3: Reorganize Git History (Squash & Reorder)

**Goal**: Collapse 67 commits into ~12 clean, feature-scoped commits that rebase independently.

**Commit mapping audit**: All 67 original commits verified — 56 map directly, 9 are metadata/docs (folded in), 2 are infrastructure (merge commit + rebase marker, excluded).

**Proposed commit structure** (in dependency order):

| #   | Commit                                                                 | Scope                                                                                                                                                                                                                                             | Files             | Conflict Risk |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------- |
| 1   | `feat(orchestration): add task orchestration system`                   | New `orchestration/*.ts` (8 files)                                                                                                                                                                                                                | NEW only          | NONE          |
| 2   | `feat(session): add history cache, part coalescer, doom loop`          | New `session/history-cache.ts`, `part-coalescer.ts`, `doom-loop.ts`, `prompt-reminders.ts`, `subtask-handler.ts`, `reasoning-handler.ts`                                                                                                          | NEW only          | NONE          |
| 3   | `feat(tool): add batch tool and plugin utilities`                      | New `tool/batch.ts`, `tool/batch.txt`, `tool/plugin-signature.ts`, `tool/plugin-hook-cache.ts`, `tool/tool-filter.ts`, `orchestration/task-spawn.ts`, `orchestration/task-model-resolver.ts`                                                      | NEW only          | NONE          |
| 4   | `feat(tui): add /btw, /goto, /clear commands and UI utilities`         | New `tui/command/*.tsx`, `tui/effect/*.ts`, `tui/util/spinner-verbs.ts`, `tui/util/clipboard-image.ts`, `tui/util/selection-boundary.ts`, `tui/util/copy-handler.ts`, `tui/component/terminal-title.tsx`, `tui/routes/session/task-session-id.ts` | NEW only          | NONE          |
| 5   | `fix(core): integrate local modules into upstream hooks`               | Minimal edits to `prompt.ts`, `processor.ts`, `registry.ts`, `task.ts`, `app.tsx`                                                                                                                                                                 | ~10-20 lines each | LOW           |
| 6   | `fix(tui): subagent click navigation, token display, spinner, sidebar` | `routes/session/index.tsx` (child session sort by `time.created` for correct click routing), `routes/session/*.tsx`, `context/*.tsx`, `feature-plugins/*.tsx`, `component/spinner.tsx`, `component/prompt/index.tsx`                              | MODIFIED          | MEDIUM        |
| 7   | `fix(tool): bash heredoc, write non-blocking, todo enforcement`        | `bash.ts`, `write.ts`, tool fixes                                                                                                                                                                                                                 | MODIFIED          | LOW           |
| 8   | `fix(session): memory fixes, startup limits, cache retention`          | `llm.ts`, `summary.ts`, `config.ts`, subagent stall/retry hardening, startup limits, cache retention, workflow perf                                                                                                                               | MODIFIED          | LOW           |
| 9   | `fix(permission): stale prompt clearing, question dialog`              | `permission/index.ts`, `question/index.ts`                                                                                                                                                                                                        | MODIFIED          | LOW           |
| 10  | `chore(provider): refresh models snapshot`                             | `models-snapshot.js`, `models.ts`                                                                                                                                                                                                                 | GENERATED         | Regenerate    |
| 11  | `test: add local feature test coverage`                                | 37 new test files                                                                                                                                                                                                                                 | NEW only          | NONE          |
| 12  | `chore: docs, gitignore, metadata`                                     | `AGENTS.md` updates, `.gitignore` additions, graphify outputs, apply_patch docs                                                                                                                                                                   | META only         | NONE          |

**Special handling for multi-spanning commits** (must be split during cherry-pick):

- `34ea177ea` (btw flow): prompt.ts changes → Commit 2, TUI → Commit 4, server → Commit 8
- `c58fb7382` (btw streaming): session → Commit 2, TUI context → Commit 6
- `2dc28f3b5` (stalled runs): write tool → Commit 7, TUI → Commit 6

**Key insight**: Commits 1-4, 11-12 are **pure additions** (new files / metadata only) — they NEVER conflict on rebase. Commit 5 is the **only integration commit** touching upstream files, kept to ~50-100 lines total. Commits 6-9 are small, focused fixes. Commit 10 is regenerated post-rebase.

#### Phase 3 Execution

- Step 1: Create a fresh branch from `upstream/dev`
- Step 2: Cherry-pick/apply changes in the order above (new files first, then minimal integration, then fixes)
- Step 3: Verify each commit independently builds/typechecks
- Step 4: Run full test suite on final state
- Step 5: Replace `dev` with the new clean branch

---

### Phase 4: Rebase onto Current `upstream/dev`

**Goal**: Prove the new structure rebases cleanly.

- Step 1: `git fetch upstream`
- Step 2: `git rebase upstream/dev`
- Step 3: Resolve any remaining conflicts (expected: ≤5, all trivial)
- Step 4: Full verification: test + typecheck + build
- Step 5: Validate feature parity with pre-restructure branch

---

### Phase 5: Establish Ongoing Rebase Hygiene

**Goal**: Prevent future drift from becoming conflict-heavy.

- Step 1: Document the "new file first, minimal hook" pattern in `AGENTS.md`
- Step 2: Add `.gitattributes` merge strategies for generated files
- Step 3: Establish convention: local features live in dedicated modules, upstream files get ≤10 lines of hook code
- Step 4: Regular rebase cadence — rebase onto `upstream/dev` weekly (or after every upstream release)

## Risks

| Risk                                  | Impact                         | Mitigation                                                                                    |
| ------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------- |
| Extraction breaks subtle coupling     | Tests fail after Phase 1       | Run full test suite after each extraction; existing 37 test files provide regression coverage |
| History rewrite loses bisect-ability  | Can't `git bisect` old commits | Keep a backup branch `dev-pre-restructure` before Phase 3                                     |
| Upstream changes during restructuring | New conflicts appear           | Fetch + rebase after Phase 3 completes, before Phase 4                                        |
| `models-snapshot.js` always conflicts | Blocks clean rebase            | Regenerate post-rebase instead of carrying in history; add to `.gitattributes`                |
| Phase 3 cherry-pick misses a change   | Feature regression             | Diff final state against original branch; must be identical except for file organization      |
