# Plan: Reduce LLM Turns in OpenCode Sessions

## Baseline

Typical session: user asks to implement a feature → ~15-30 tool calls over ~10-20 LLM turns.
Each turn = full `runLoop` iteration: DB fetch, system prompt rebuild, sliding window check, tool resolution, reminder insertion, new assistant message, `streamText()`.

---

## Ranked Optimizations

### 1. Enable `parallel_tool_calls` for Primary Agent (Config)

| Metric       | Value              |
| ------------ | ------------------ |
| Turn savings | 2-4 per session    |
| Complexity   | Config change only |
| Risk         | Low                |

**Current state**: `parallelToolCalls` defaults to `agent.mode === "subagent"`. Primary agent has it disabled. The `parallelGate()` already enforces safety: only enables parallel if ALL tools in that streamText call are `parallelSafe` (read, grep, glob) and ALL have "allow" permission.

**What changes**: Set `experimental.parallel_tool_calls: true` in default config (or per-agent). The model can then issue multiple read/grep/glob in one response, and the SDK processes them concurrently instead of sequentially.

**Implementation**:

1. Change default in config schema: `parallel_tool_calls` → `true`
2. Also set `experimental.parallel_read: true` (currently gated separately at llm.ts:104)
3. Optionally add `parallelSafe: true` to additional read-only tools (e.g., `file_search` MCP tools)

**Risk**: Minimal. parallelGate already rejects unsafe combinations. If ANY tool in the batch is not `parallelSafe` or requires permission, gate returns false → falls back to sequential.

**Dependencies**: None.

---

### 2. Batch System Prompt Instruction for Primary Agent

| Metric       | Value                        |
| ------------ | ---------------------------- |
| Turn savings | 2-5 per session              |
| Complexity   | Trivial (system prompt edit) |
| Risk         | Very low                     |

**Current state**: Subagent system prompts explicitly say "call multiple tools in a single response." Primary agent prompts don't emphasize this.

**What changes**: Add instruction to primary agent's system prompt encouraging batched read/grep/glob calls when investigating code.

**Implementation**:

1. In the agent prompt (or `SystemPrompt.environment()`), add: "When investigating code, batch multiple read/grep/glob calls in a single response to minimize round-trips."
2. This works WITH optimization #1 — model batches calls, parallel execution handles them.

**Risk**: None. The model may ignore it, but won't cause harm.

**Dependencies**: Most effective with #1 enabled.

---

### 3. Enable `continue_loop_on_deny` by Default

| Metric       | Value                                |
| ------------ | ------------------------------------ |
| Turn savings | 0-2 per session (highly situational) |
| Complexity   | Config change only                   |
| Risk         | Low-Medium                           |

**Current state**: `experimental.continue_loop_on_deny` defaults to `false`. When a tool is denied → `ctx.shouldBreak = true` → loop stops. User must re-prompt.

**What changes**: Default to `true`. When permission denied, model continues with remaining tools and adapts its plan without requiring a new user message.

**Implementation**:

1. Change default at processor.ts:635 from `!== true` to check `?? true`
2. Or: change config schema default

**Risk**: Model might retry denied action or take unexpected path. Mitigated by the deny message being fed back as tool result, so model sees the denial.

**Dependencies**: None.

---

### 4. Raise Hybrid Compression Thresholds / Use Heuristic Fallback

| Metric       | Value                                                         |
| ------------ | ------------------------------------------------------------- |
| Turn savings | 0-1 LLM turn, but saves ~3-8 `generateText` calls per session |
| Complexity   | Low (config + minor code)                                     |
| Risk         | Low                                                           |

**Current state**: When `hybrid.enabled`, EACH large tool output triggers a separate `generateText()` call to a local model for compression. These aren't loop turns but add latency and cost.

**What changes**:

- Option A: Raise compression threshold (default seems ~1000 chars based on route-classifier). Compress only outputs >5000 chars.
- Option B: Replace LLM compression with heuristic truncation (head+tail) for known-structure tools (grep, glob return structured output that compresses well with head/tail).
- Option C: Batch multiple tool outputs into a single compression call.

**Implementation**:

1. In `shouldCompress()` (processor.ts), increase threshold for tools with structured output
2. For `grep`/`glob`: always use heuristic (head N lines + "..." + tail N lines)
3. Keep LLM compression only for `bash` and `read` outputs where semantic summarization helps

**Risk**: Slightly more context consumed per tool output. Mitigated by existing prune mechanism (compaction.ts:329-380) which aggressively removes old tool outputs.

**Dependencies**: None.

---

### 5. Proactive Context Pruning to Delay Compaction

| Metric       | Value                                        |
| ------------ | -------------------------------------------- |
| Turn savings | 1-2 per session (avoids compaction LLM call) |
| Complexity   | Medium                                       |
| Risk         | Medium                                       |

**Current state**: When `isOverflow` detects context exceeded → creates compaction task → full LLM call to summarize. The `prune()` function already exists (erases old tool outputs) but runs AFTER overflow is detected, not before.

**What changes**: Run prune more aggressively BEFORE overflow. Use the existing `PRUNE_PROTECT = 40_000` budget but trigger prune earlier (e.g., at 80% context utilization instead of 100%).

**Implementation**:

1. In `runLoop` iteration, after `compaction.prune()` at line 1224, add early-warning check:
   - If last assistant's tokens indicate >80% context used AND prune hasn't been exhaustive, prune harder
2. Reduce `PRUNE_PROTECT` threshold dynamically based on remaining context budget
3. Add more aggressive `TOOL_OUTPUT_MAX_CHARS` for older turns (currently 2000 chars only during compaction prompt building)

**Risk**: Might discard information the model needs. Mitigated by keeping recent turns intact (PRUNE_PROTECT only touches turns beyond the 2nd-most-recent).

**Dependencies**: None.

---

### 6. Use `maxSteps` in streamText for Safe Tool Chains

| Metric       | Value           |
| ------------ | --------------- |
| Turn savings | 3-6 per session |
| Complexity   | High            |
| Risk         | High            |

**Current state**: `streamText()` is called with NO `maxSteps`. Each call = 1 model inference + tool execution. Outer `runLoop` handles continuation.

**What changes**: When all resolved tools are `parallelSafe` AND pre-approved, pass `maxSteps: N` to streamText. SDK auto-continues within same stream: model → tools → model → tools... without outer loop overhead.

**Implementation**:

1. In prompt.ts, after resolving tools, check if ALL tools are parallelSafe + fully allowed
2. If yes: pass `maxSteps: 5` to streamText (via LLM.stream)
3. Modify LLM.stream to accept and pass through maxSteps
4. Handle events from multi-step stream (tool-call events come in sequence)
5. After stream completes, sync final state to DB

**What's saved per skipped outer iteration**:

- `MessageV2.filterCompactedEffect(sessionID)` — DB read
- System prompt rebuild (partially cached after step 1)
- `SlidingWindow.compact()` — token estimation
- `resolveTools()` — tool resolution
- `insertReminders()` — reminder check
- `sessions.updateMessage()` — new assistant message creation

**Risk**:

- Loses per-step overflow detection → could exceed context in multi-step
- Loses per-step permission re-evaluation (acceptable since we pre-checked "allow")
- Intermediate persistence: events still stream so TUI updates, but DB message isn't created per-step
- If model switches from safe tools (read) to unsafe (bash/edit) mid-stream, maxSteps won't stop it — but toolChoice/activeTools still constrain what's callable

**Mitigation**:

- Only enable when ALL tools are safe (read/grep/glob)
- Cap maxSteps at 3-5 to limit blast radius
- Retain overflow check in stream event handler (stop stream if tokens approach limit)

**Dependencies**: #1 (parallel_tool_calls must be enabled for this to be meaningful).

---

### 7. Optimize Subagent Context Transfer

| Metric       | Value                             |
| ------------ | --------------------------------- |
| Turn savings | 1-3 per subagent spawn (indirect) |
| Complexity   | Medium                            |
| Risk         | Low                               |

**Current state**: `task` tool spawns new session with only the instruction text. Subagent starts from scratch — often re-reads files parent already read.

**What changes**: Pass relevant context (recent file contents, grep results, project structure) from parent session to subagent's initial message.

**Implementation**:

1. In `task.ts`, when building subagent message, include summaries of recent tool results from parent
2. Filter to only include results relevant to the subagent's task (file paths mentioned in instruction)
3. Cap context transfer at ~4000 tokens

**Risk**: Stale context if files changed between parent read and subagent execution. Low risk since subagent verifies via its own reads.

**Dependencies**: None.

---

### 8. Smart Exit on Empty/Noop Iterations

| Metric       | Value           |
| ------------ | --------------- |
| Turn savings | 0-1 per session |
| Complexity   | Low             |
| Risk         | Low             |

**Current state**: Loop can produce iterations with no meaningful output (empty text, no tool calls, finish="stop" but `lastUser.id < lastAssistant.id` not yet met).

**What changes**: Add detection for "noop" iterations — if model produced no text and no tool calls, and finish is "stop" or "end_turn", break immediately.

**Implementation**:

1. After `handle.process()` completes, check: if `handle.message.finish` indicates done AND no parts were added AND no text was generated → break
2. This is mostly already handled by the exit condition at line 1253, but edge cases exist with "unknown" finish reason

**Risk**: Minimal. Already mostly covered.

**Dependencies**: None.

---

### 9. Pre-Resolve Permissions at Agent Level

| Metric       | Value                          |
| ------------ | ------------------------------ |
| Turn savings | 0 (reduces latency, not turns) |
| Complexity   | Medium                         |
| Risk         | Low                            |

**Current state**: Each tool call resolves permissions at execution time. For pre-approved tools this is fast (ruleset lookup), but for "ask" tools it blocks the loop.

**What changes**: At loop start, batch-resolve all permissions for the session's tool set. Cache the effective ruleset. Avoid per-call re-evaluation for tools that haven't changed.

**Implementation**:

1. Compute `Permission.effective()` once at start of step, pass resolved decisions to tool context
2. Already partially done (permission is passed to LLM.StreamInput), but individual tool execute() still calls `permission.ask()`

**Risk**: Permissions could change mid-session (user grants "always allow"). Current system handles this; caching must invalidate on permission events.

**Dependencies**: None, but pairs well with #3.

---

### 10. Reduce SlidingWindow Recomputation

| Metric       | Value                                     |
| ------------ | ----------------------------------------- |
| Turn savings | 0 (reduces per-turn latency by ~50-100ms) |
| Complexity   | Medium                                    |
| Risk         | Low                                       |

**Current state**: Every loop iteration calls `SlidingWindow.compact()` which estimates tokens for the entire message history.

**What changes**: Cache the sliding window result and only recompute when messages actually change (new tool results added). Use a generation counter.

**Implementation**:

1. Track message count + last message ID. If unchanged from previous iteration, skip compact
2. Already partially implemented (`SlidingWindow.invalidate(sessionID)` exists) but compact still runs every iteration

**Risk**: None if invalidation is correct.

**Dependencies**: None.

---

## Summary Table

| #   | Optimization                       | Turns Saved           | Type          | Complexity | Risk     | Priority |
| --- | ---------------------------------- | --------------------- | ------------- | ---------- | -------- | -------- |
| 1   | Enable parallel_tool_calls         | 2-4                   | Config        | Trivial    | Low      | P0       |
| 2   | Batch instruction in system prompt | 2-5                   | Config/Prompt | Trivial    | Very Low | P0       |
| 3   | continue_loop_on_deny default true | 0-2                   | Config        | Trivial    | Low-Med  | P1       |
| 4   | Raise compression thresholds       | 0-1 turns + 3-8 calls | Code          | Low        | Low      | P1       |
| 5   | Proactive pruning before overflow  | 1-2                   | Code          | Medium     | Medium   | P2       |
| 6   | maxSteps in streamText             | 3-6                   | Code          | High       | High     | P2       |
| 7   | Subagent context transfer          | 1-3 (indirect)        | Code          | Medium     | Low      | P2       |
| 8   | Smart exit on noop                 | 0-1                   | Code          | Low        | Low      | P1       |
| 9   | Pre-resolve permissions            | 0 (latency)           | Code          | Medium     | Low      | P3       |
| 10  | Cache SlidingWindow                | 0 (latency)           | Code          | Medium     | Low      | P3       |

---

## Recommended Implementation Order

### Phase 1: Config-only (immediate, zero risk)

1. **#1** — Set `experimental.parallel_tool_calls: true` + `experimental.parallel_read: true`
2. **#2** — Add batching instruction to primary agent system prompt
3. **#3** — Set `experimental.continue_loop_on_deny: true` as default

**Expected impact**: 4-9 fewer turns per session. Zero code changes to core loop.

### Phase 2: Low-complexity code changes

4. **#4** — Heuristic compression for structured tools, raise thresholds
5. **#8** — Smart exit on noop iterations

**Expected impact**: 1-2 fewer turns + 3-8 fewer compression calls.

### Phase 3: Medium-complexity improvements

6. **#5** — Proactive pruning to delay compaction
7. **#7** — Subagent context transfer

**Expected impact**: 2-5 fewer turns across sessions with compaction or subagents.

### Phase 4: High-complexity, high-reward

8. **#6** — maxSteps integration (requires careful testing, rollback plan)

**Expected impact**: 3-6 fewer turns for read-heavy exploration phases.

### Phase 5: Latency optimizations (non-turn-saving)

9. **#9** — Pre-resolve permissions
10. **#10** — Cache SlidingWindow

---

## Dependency Graph

```
#2 (batch prompt) ──enhances──→ #1 (parallel_tool_calls)
#6 (maxSteps) ─────requires───→ #1 (parallel_tool_calls)
#3 (continue on deny) ─pairs──→ #9 (pre-resolve permissions)
#5 (proactive prune) ─reduces─→ compaction frequency → fewer turns
#4 (compression) ───────────── → independent
#7 (subagent ctx) ──────────── → independent
#8 (noop exit) ─────────────── → independent
```

---

## Total Estimated Savings

| Scenario                        | Before      | After (Phase 1-3) | After (All) |
| ------------------------------- | ----------- | ----------------- | ----------- |
| Simple feature (15 tool calls)  | 10-12 turns | 7-9 turns         | 5-7 turns   |
| Complex feature (30 tool calls) | 18-22 turns | 13-16 turns       | 9-13 turns  |
| Read-heavy exploration          | 8-10 turns  | 5-7 turns         | 3-5 turns   |

---

## Risk Mitigations

| Risk                                      | Mitigation                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| Parallel tool calls cause race conditions | parallelGate already prevents unsafe combinations                               |
| maxSteps exceeds context                  | Cap at 3-5 steps; add token check in stream handler                             |
| continue_on_deny causes infinite loops    | Model sees deny feedback; existing step limit (agent.steps) caps iterations     |
| Aggressive pruning loses needed context   | Only prune beyond PRUNE_PROTECT boundary (most recent 2 turns always preserved) |
| Subagent context stale                    | Subagent still reads files independently; transferred context is advisory       |
