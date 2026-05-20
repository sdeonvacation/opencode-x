# Plan: Claurst Feature Ports

## Overview

Port 7 high-value features from claurst (Rust terminal coding agent) to opencode-x. All features are additive modules with 1-2 line integration points, ensuring upstream-rebase safety. Every feature is gated behind `experimental.*` flags. All context management features are provider-agnostic (work with OpenAI, Anthropic, and OpenAI-compatible APIs). Plugin hooks are Claude Code compatible out of the box.

## Tech Stack

- TypeScript 5.8 on Bun
- Effect-ts 4.0 (services, ScopedCache, Effect.fn)
- SQLite via drizzle-orm (goal system)
- Existing session loop (`session/index.ts`, `session/llm.ts`)
- Existing provider layer (`provider/transform.ts`)
- Existing tool runner (`tool/registry.ts`)
- Vercel AI SDK 6.x (provider-agnostic streaming)

## Provider Caching Constraints

All features MUST preserve existing caching behavior. Current `applyCaching()` runs for: Anthropic, Claude-via-OpenRouter, Bedrock, Alibaba, and OpenAI-compatible providers.

| Provider              | Cache Mechanism                              | Breakpoint Budget                         | Constraint                                                                                       |
| --------------------- | -------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Anthropic**         | Explicit `cacheControl: {type: "ephemeral"}` | **4 max** (3 message + 1 tool def)        | Do NOT add breakpoints — budget is full. System[0] + first non-system + last msg + last tool def |
| **Bedrock**           | `cachePoint: {type: "default"}`              | 4 max (same as Anthropic)                 | Same allocation as Anthropic                                                                     |
| **Alibaba**           | `cacheControl: {type: "ephemeral"}`          | Unknown limit (treat as 4)                | Same marker format as Anthropic. Applied via same `applyCaching()` path                          |
| **OpenRouter**        | `cacheControl: {type: "ephemeral"}` with TTL | Varies by upstream                        | Routes to Anthropic/OpenAI — breakpoints forwarded                                               |
| **OpenAI**            | Automatic server-side prefix caching         | No explicit markers (prefix ≥1024 tokens) | Keep system prompt prefix STABLE across turns — any reordering destroys cache                    |
| **OpenAI-compatible** | `cache_control: {type: "ephemeral"}`         | Provider-dependent                        | Treat like Anthropic for explicit caching                                                        |
| **Copilot**           | `copilot_cache_control: {type: "ephemeral"}` | Unknown                                   | Same pattern                                                                                     |

### Critical Anthropic/Alibaba Constraint (4-breakpoint budget)

Current allocation (transform.ts:227-254):

```
Slot 1: system[0]                    ← system prompt (largest stable block)
Slot 2: first non-system message     ← compaction summary (stable after compact)
Slot 3: last message                 ← most recent turn (rolling)
Slot 4: last tool definition         ← tool defs (stable, 3000-8000 tokens)
```

**Rule**: No feature may ADD breakpoints. The budget is FULL. Phase 2 (prompt split) must NOT create a second system message with its own breakpoint — it must split WITHIN the single system message's content array (both parts share Slot 1's breakpoint).

### General Rules

1. Context management features (tool budget, compaction, collapse) operate on MESSAGE HISTORY only — never touch system prompt structure, tool definitions, or providerOptions
2. All history mutations happen BEFORE `applyCaching()` runs (line 385) — so cache markers are computed on the final message set
3. Prompt caching enhancement (Phase 2) must NOT consume an additional breakpoint slot
4. Features must not reorder messages in ways that change which message is "first non-system" (Slot 2 target)

## Feature Flags

All features gated under `experimental` in config schema:

```typescript
// config.ts additions to experimental object:
tool_result_budget: z.number().int().positive().optional()
  .describe("Global char budget for tool results in history (default: disabled, set to 50000 to enable)"),
context_collapse: z.boolean().optional()
  .describe("Enable emergency context collapse at 97% utilization"),
microcompact: z.boolean().optional()
  .describe("Enable gradual MicroCompact at 75% context utilization"),
prompt_split_caching: z.boolean().optional()
  .describe("Split system prompt into cached/dynamic sections for improved provider caching"),
goal_system: z.boolean().optional()
  .describe("Enable autonomous goal system with /goal command"),
worktree_isolation: z.boolean().optional()
  .describe("Enable git worktree isolation for parallel subagents"),
hooks: z.boolean().optional()
  .describe("Enable plugin hooks system (Claude Code compatible)"),
persistent_memory: z.boolean().optional()
  .describe("Enable cross-session persistent memory"),
```

## Testing Strategy

- Unit: Each feature module tested in isolation (pure functions, no mocks)
- Integration: Token budget + compaction interaction, goal lifecycle, hook dispatch
- Provider tests: Verify caching behavior unchanged for Anthropic + OpenAI after each feature
- Done when: All features work independently, no regressions in `bun --cwd packages/opencode test`, provider cache hit rates unchanged

## Phases

### Phase 1: Context Safety Net (no dependencies, parallelizable)

These three features are independent — can be implemented in parallel. All are provider-agnostic (operate on message history, not provider-specific structures).

#### 1A. Tool Result Budget (Global 50K cap)

**Feature flag**: `experimental.tool_result_budget` (number, default: disabled)

- Step 1: Create `src/session/tool-budget.ts` — export `applyToolResultBudget(msgs, budget)`
- Step 2: Function iterates messages oldest-first, sums tool result char lengths
- Step 3: If over budget, replace oldest tool results with `"[tool result truncated to save context]"` until under
- Step 4: Call in `session/llm.ts` before `streamText()` dispatch, BEFORE `applyCaching()` runs (so cache breakpoints are computed on final message set)
- Step 5: Provider-safe: only modifies tool result CONTENT, not message structure/metadata/providerOptions
- Step 6: Add test in `test/session/tool-budget.test.ts`

**Caching impact**: None — truncation happens before cache markers are applied. Cache breakpoint positions unchanged.

#### 1B. Context Collapse (97% Emergency Fallback)

**Feature flag**: `experimental.context_collapse` (boolean, default: false)

- Step 1: Create `src/session/context-collapse.ts` — export `contextCollapse(sessionID, model)`
- Step 2: Uses cheap/fast model call (respects category routing if available — route to `task_categories.compaction` model) with emergency prompt (max 500 words, 4 bullet points)
- Step 3: Emergency prompt template works with any model (OpenAI, Anthropic, local) — no provider-specific formatting
- Step 4: Replaces entire history with `[emergency-summary-as-user-msg, last-user-message]`
- Step 5: Guard in session loop: if token ratio >= 0.97 AFTER sliding window runs, invoke collapse
- Step 6: Log full pre-collapse history to `~/.local/share/opencode/log/collapse/<sessionID>-<timestamp>.json` for recovery
- Step 7: Add test in `test/session/context-collapse.test.ts`

**Caching impact**: After collapse, history is 2 messages — cache invalidated (unavoidable in emergency). New prefix starts fresh cache.

#### 1C. MicroCompact (75% Gradual Compaction)

**Feature flag**: `experimental.microcompact` (boolean, default: false)

- Step 1: Create `src/session/microcompact.ts` — export `microCompact(sessionID, model, config)`
- Step 2: Config: `{ threshold: 0.75, keepRecent: 10, summaryTokens: 2048 }`
- Step 3: Only summarizes oldest N messages (excluding last 10) into tiny 2048-token summary
- Step 4: Summary model call: uses same compaction model as existing system (provider-agnostic)
- Step 5: Produces single synthetic user message `<context-summary>...</context-summary>` replacing the old messages
- Step 6: Mutual exclusion with `proactive_prune`: if both enabled, `microcompact` takes priority (lighter touch)
- Step 7: Check before API call: if `inputTokens / contextWindow >= 0.75`, run microcompact
- Step 8: Add test in `test/session/microcompact.test.ts`

**Caching impact**: Minimal — oldest messages replaced with summary. Existing sliding window cache key pattern (`sessionID + lastMsgID`) still works. Provider cache on system prompt unaffected.

### Phase 2: Prompt Caching Enhancement (depends on nothing)

**Feature flag**: `experimental.prompt_split_caching` (boolean, default: false)

This optimizes cache HIT RATES for ALL providers without consuming additional breakpoints.

**Key insight**: The current system already caches system[0] (Slot 1). The optimization is making that cached content LARGER and MORE STABLE by ensuring volatile content is at the END of the same message (not a separate message).

- Step 1: Define `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` constant in `session/prompt.ts`
- Step 2: Restructure `buildSystemPrompt()` content ordering WITHIN the single system message:
  - **Stable prefix** (before boundary): core identity, capabilities, tool guidelines, skills, safety rules, custom instructions from AGENTS.md
  - **Volatile suffix** (after boundary): env info (cwd, platform, date), session memory, active goal, runtime state
- Step 3: Provider-specific behavior in `provider/transform.ts`:
  - **Anthropic/Bedrock/Alibaba**: The existing Slot 1 breakpoint already covers system[0]. By moving stable content to the front, MORE of the system message is covered by the prefix cache (Anthropic caches from start of message up to breakpoint). NO ADDITIONAL BREAKPOINT NEEDED — reuse existing Slot 1.
  - **OpenAI/OpenAI-compatible**: OpenAI auto-caches matching prefixes ≥1024 tokens. By making the system prompt prefix stable (same content, same order every turn), cache hit rate improves automatically. Dynamic content at the end means only the suffix changes turn-to-turn.
  - **Alibaba**: Same as Anthropic — explicit breakpoint on system[0] already exists, stable prefix maximizes cached portion.
  - **OpenRouter**: Forwards caching to upstream provider (Anthropic or OpenAI) — benefits from either mechanism.
- Step 4: DO NOT split into two system messages (would consume Slot 2). Keep as single system message with ordered content parts.
- Step 5: Measure: expose `cache_read_input_tokens` / `cached_tokens` in usage metrics per session to verify improvement
- Step 6: For Anthropic specifically: if system message has `content: [{type: "text", text: stablePrefix}, {type: "text", text: dynamicSuffix}]`, place `cacheControl` on the first text part only (sub-message-level caching). This is supported by Anthropic's API and does NOT consume an additional top-level breakpoint.
- Step 7: No-op when disabled — system prompt builds identically to current behavior

**Caching impact per provider**:
| Provider | Impact | Mechanism |
|----------|--------|-----------|
| Anthropic | ↑ cache hits | Stable prefix = more tokens cached under Slot 1. Optional sub-part `cacheControl` for finer granularity |
| Bedrock | ↑ cache hits | Same as Anthropic |
| Alibaba | ↑ cache hits | Same as Anthropic |
| OpenAI | ↑ cache hits | Longer stable prefix = more tokens match auto-cache |
| OpenRouter | ↑ cache hits | Inherits from upstream |
| Local (Ollama) | No effect | No caching mechanism — degrades gracefully |

### Phase 3: Goal System (depends on Phase 1 for context safety)

**Feature flag**: `experimental.goal_system` (boolean, default: false)

- Step 1: Create `src/goal/goal.sql.ts` — GoalTable schema:
  ```
  id: text PK
  session_id: text FK → session.id (cascade delete)
  objective: text NOT NULL
  status: text NOT NULL (active|paused|budget_limited|complete)
  token_budget: integer (nullable, optional cap)
  tokens_used: integer DEFAULT 0
  turns_used: integer DEFAULT 0
  time_used_secs: integer DEFAULT 0
  created_at: integer NOT NULL
  completed_at: integer (nullable)
  ```
- Step 2: Generate migration: `bun run db generate --name add-goals`
- Step 3: Create `src/goal/goal.ts` — CRUD service (create, get, update, complete, pause) via `Database.use()`
- Step 4: Create `src/tool/goal-complete.ts` — GoalComplete tool (model calls when objective met, must provide evidence string)
- Step 5: Create `src/goal/goal-loop.ts` — after each turn, check: if goal active + under budget + under MAX_TURNS → inject continuation user message → auto-dispatch next turn
- Step 6: Goal addendum injected into system prompt DYNAMIC section (after boundary) — does not affect cached prefix
- Step 7: Add `/goal` slash command in TUI (accepts objective text)
- Step 8: Goal status shows in status bar (turns/budget remaining)
- Step 9: Guards: MAX_TURNS=200 (runaway), optional token budget, pause on budget_limited
- Step 10: Works with any provider — continuation is a plain user message, no provider-specific API
- Step 11: Add tests: goal lifecycle, runaway guard, budget limiting

**Caching impact**: Goal addendum is in DYNAMIC section — cached prefix unaffected. Continuation messages are standard user messages.

### Phase 4: Worktree Isolation for Parallel Agents (depends on nothing, parallelizable with Phase 3)

**Feature flag**: `experimental.worktree_isolation` (boolean, default: false)

- Step 1: Create `src/orchestration/worktree.ts` — helpers: `createWorktree(sessionID)`, `mergeWorktree(sessionID)`, `cleanupWorktree(sessionID)`
- Step 2: `createWorktree`: `git worktree add /tmp/opencode-worker-<id> HEAD` → returns isolated path
- Step 3: `mergeWorktree`: create temp branch in worktree → commit changes → switch back to main → cherry-pick/merge → cleanup
- Step 4: Add `isolation?: "worktree"` option to task tool schema (`tool/task.ts`)
- Step 5: When `isolation: "worktree"`, set spawned session's cwd to worktree path
- Step 6: On task completion, merge worktree changes back to main working directory
- Step 7: On merge conflict: leave branch intact, report conflict to parent (don't force-apply)
- Step 8: Cleanup on failure/abort via `Effect.addFinalizer` (removes worktree + temp branch)
- Step 9: Add test in `test/orchestration/worktree.test.ts`

**Caching impact**: None — operates at filesystem/git level, orthogonal to provider caching.

### Phase 5: Plugin Hooks — Claude Code Compatible (PreToolUse/PostToolUse Lifecycle)

**Feature flag**: `experimental.hooks` (boolean, default: false)

#### Claude Code Plugin Compatibility

Hooks use **identical format** to Claude Code's `settings.json` hooks. Any existing Claude Code hook config works without modification.

#### Hook Config Format (Claude Code compatible)

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "my-validator $TOOL_INPUT" }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "my-logger", "timeout": 5000 }]
      }
    ]
  }
}
```

#### Implementation

- Step 1: Create `src/hook/hook.ts` — HookRegistry Effect service
- Step 2: Load hooks from THREE sources (priority order):
  1. Project `.opencode/hooks.json` (project-specific)
  2. Global config `hooks` key in opencode config (user-global)
  3. **Claude Code import**: Auto-detect `~/.claude/settings.json` hooks section → load if present and no opencode hooks configured (seamless migration)
- Step 3: Define events (Claude Code compatible names):
  - `PreToolUse` — before tool execution (blocking: can deny)
  - `PostToolUse` — after successful tool execution
  - `PostToolUseFailure` — after failed tool execution
  - `Notification` — on agent notification/output
  - `Stop` — on session end/agent stop
  - `SubagentStart` — when subagent spawns
  - `SubagentStop` — when subagent completes
- Step 4: Matcher: glob pattern on tool name (micromatch syntax: `"Bash"`, `"*"`, `"File*"`, `"!Glob"`)
- Step 5: Dispatch: shell command with Claude Code compatible env vars:
  - `CLAUDE_TOOL_NAME` — tool being invoked
  - `CLAUDE_TOOL_INPUT` — JSON string of tool input
  - `CLAUDE_TOOL_RESULT` — JSON string of tool result (PostToolUse only)
  - `CLAUDE_SESSION_ID` — current session ID
  - `CLAUDE_MODEL` — current model ID
  - Event JSON also passed on **stdin** for richer processing
- Step 6: Blocking semantics: `blocking: true` (default for PreToolUse) — non-zero exit = deny with stderr as reason. `blocking: false` (default for Post\*) — fire-and-forget
- Step 7: Non-blocking hooks: run via `Effect.fork`, timeout default 10s, log failures to debug
- Step 8: Integration: 2 dispatch calls in tool execution path:
  - Before: `yield* HookRegistry.dispatch("PreToolUse", { tool, input })` → if denied, return error
  - After: `Effect.fork(HookRegistry.dispatch("PostToolUse", { tool, input, result }))` → non-blocking
- Step 9: Config schema: add `hooks` key to config (outside experimental — it's the hook definitions. The experimental flag enables/disables the engine)
- Step 10: Add test in `test/hook/hook.test.ts`

#### Installing Claude Code Plugins (Seamless Path)

Claude Code plugins that use hooks work automatically:

1. **Existing `~/.claude/settings.json` hooks** → Auto-loaded on first run if no opencode hooks configured
2. **Project-level `.claude/settings.json`** → Hook section read as fallback if `.opencode/hooks.json` absent
3. **Manual migration**: Copy `hooks` section from Claude Code settings.json to opencode config — format identical, no translation needed
4. **MCP servers from Claude Code**: Already supported by opencode-x's existing MCP config (same `mcpServers` format) — no changes needed here

**Documentation** (in-config help):

```
// To use Claude Code plugins:
// 1. Hooks: Copy the "hooks" section from ~/.claude/settings.json
//    to your opencode config. Format is identical.
//    OR: opencode auto-imports from ~/.claude/settings.json if no
//    local hooks are configured.
// 2. MCP servers: Add to "mcpServers" in opencode config (same format).
// 3. CLAUDE.md: Already loaded automatically if present in project root.
```

**Caching impact**: None — hooks execute at tool layer, orthogonal to provider message caching.

### Phase 6: Cross-Session Memory (extends existing session-memory plan)

**Feature flag**: `experimental.persistent_memory` (boolean, default: false)

- Step 1: Create `src/memory/persistent.ts` — file-based memory in `~/.local/share/opencode/memory/`
- Step 2: Format: markdown files with YAML frontmatter:

  ```markdown
  ---
  name: user-prefers-effect-ts
  type: user
  created: 2026-05-20
  ---

  User always wants Effect-ts patterns, no raw Promises.
  ```

- Step 3: Types: `user` (preferences), `project` (codebase facts), `feedback` (corrections)
- Step 4: Scan on prompt build → inject into system prompt DYNAMIC section (after boundary) as `<persistent-memory>` block
- Step 5: Limits: max 200 files, max 500 lines total injected, newest-first priority
- Step 6: Tool: `memory_persist` — model can write persistent memories across sessions
- Step 7: Separate from session memory (per-session, DB-backed) — this is cross-session, file-backed, user-editable
- Step 8: Provider-agnostic: injected as plain text in system prompt, works with any model
- Step 9: Add test in `test/memory/persistent.test.ts`

**Caching impact**: Memory content is in DYNAMIC section → cached prefix unaffected. Changes between sessions invalidate only the dynamic suffix (expected behavior).

## Risks

| Risk                                    | Severity | Mitigation                                                                                                                                            |
| --------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Anthropic 4-breakpoint overflow**     | Critical | Phase 2 reuses existing Slot 1 — does NOT create new system message. Sub-part caching stays within same slot. Anti-regression test counts breakpoints |
| **Alibaba cache invalidation**          | High     | Same `cacheControl` format as Anthropic — same constraints apply. Prefix stability rule enforced. Explicit test                                       |
| **OpenAI prefix cache miss**            | High     | All history mutations happen BEFORE system prompt assembly. Stable prefix ordering guaranteed. Volatile content at end only                           |
| **Bedrock cachePoint regression**       | High     | Same allocation as Anthropic (3 msg + 1 tool). No additional `cachePoint` markers introduced                                                          |
| Provider cache degradation (general)    | High     | All history operations happen BEFORE `applyCaching()` (line 385). Prompt split preserves prefix stability. Test cache hit rates per provider          |
| MicroCompact vs proactive_prune overlap | Low      | Mutual exclusion: if both enabled, microcompact wins. Document difference                                                                             |
| Context collapse data loss              | Medium   | Log full history to file before collapse. User can inspect/recover                                                                                    |
| Goal system runaway                     | Medium   | 200-turn hard limit + token budget + pause state. Never infinite                                                                                      |
| Worktree merge conflicts                | Medium   | Don't force-apply. Leave branch, report conflict to parent agent                                                                                      |
| Hook injection attacks                  | Medium   | Hooks only from user config (model cannot write hooks). Command timeout 10s. No shell expansion of model output                                       |
| Upstream rebase conflicts               | Low      | All features are new files. Integration = single-line insertions. Feature-gated = dead code when disabled                                             |
| Feature interaction                     | Low      | Each feature independently testable and toggleable. No feature depends on another being enabled                                                       |

## Provider-Specific Verification Checklist

Before shipping each phase, verify:

- [ ] **Anthropic**: `cache_read_input_tokens` in usage response remains >0 after feature enabled. Confirm exactly 4 breakpoints used (not 5+)
- [ ] **Bedrock**: Same as Anthropic — `cachePoint` markers still present, cache read tokens stable
- [ ] **Alibaba**: `cacheControl` markers preserved. Verify via `cache_read_input_tokens` if exposed in response
- [ ] **OpenAI**: `cached_tokens` in usage response remains >0 (requires ≥1024 token matching prefix). System prompt prefix byte-for-byte identical across turns
- [ ] **OpenRouter**: No regression in response latency (proxy caching varies by upstream)
- [ ] **Copilot**: `copilot_cache_control` markers preserved on same messages as before
- [ ] **Local models (Ollama/LM Studio)**: Features degrade gracefully (no cache metrics, just skip caching logic)

### Anti-regression test pattern

```typescript
// test/provider/cache-invariant.test.ts
// For each provider type:
// 1. Build messages with feature ON
// 2. Run through transform.message()
// 3. Count providerOptions with cache markers
// 4. Assert count === expected (3 msg + 1 tool for Anthropic-like, 0 for OpenAI)
// 5. Assert system[0] is first target (stable prefix cached)
```
