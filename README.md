# OpenCode X

Built on top of [opencode](https://github.com/anomalyco/opencode) — adds Claude Code-grade features on top of an open, provider-agnostic foundation. Natively supports claude code hooks and plugins.

**For full configuration, checkout [OPENCODE-X_GUIDE.md](./OPENCODE-X_GUIDE.md).**

## Demo

![OpenCode X Demo](./assets/opencode-x-demo.gif)

---

## Install

### npm (Recommended)

```bash
npm install -g @sdeonvacation/opencode-x
opencode
```

### Download Binary

Download from [Releases](https://github.com/sdeonvacation/opencode-x/releases/latest):

| Asset                          | Platform                  |
| ------------------------------ | ------------------------- |
| `opencode-x-darwin-arm64`      | macOS Apple Silicon       |
| `opencode-x-darwin-x64`        | macOS Intel               |
| `opencode-x-linux-arm64`       | Linux arm64 (glibc)       |
| `opencode-x-linux-x64`         | Linux x64 (glibc)         |
| `opencode-x-linux-arm64-musl`  | Linux arm64 (Alpine/musl) |
| `opencode-x-linux-x64-musl`    | Linux x64 (Alpine/musl)   |
| `opencode-x-windows-arm64.exe` | Windows arm64             |
| `opencode-x-windows-x64.exe`   | Windows x64               |

```bash
# macOS / Linux
chmod +x opencode-x-<platform>
sudo mv opencode-x-<platform> /usr/local/bin/opencode-x

# Windows (PowerShell as Admin)
move opencode-x-windows-x64.exe C:\Windows\opencode-x.exe

# Run
opencode-x
```

### Build from Source

```bash
git clone https://github.com/sdeonvacation/opencode-x
cd opencode-x && bun install
./packages/opencode/script/build.ts --single
# Binary at: packages/opencode/dist/opencode-$(uname -s | tr A-Z a-z)-$(uname -m)/bin/opencode
```

## What OpenCode X Adds (vs. Upstream + Claude Code)

| Feature                                     | **OpenCode X**                                                                                                                                          | **Upstream OpenCode**                         | **Claude Code**                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------- |
| **Claude Code hooks + plugins**             | Native — reads `~/.claude/settings.json` hooks, `~/.claude/plugins/installed_plugins.json`, `~/.claude/hooks/commands.json`; same events, same env vars | Plugin system only (no hook lifecycle events) | Native                                              |
| **Push agent to background**                | `Leader+D` chord detaches running session to background; TUI unblocks for new prompts, toast on completion                                              | Background subagents (spawn only)             | Native                                              |
| **Spinner verbs**                           | Claude Code-style creative random pool ("Sherlocking…", "Conjuring…") with mood-based color cycling                                                     | Generic spinner                               | Native                                              |
| **Cache stability (prompt split)**          | System prompt split into stable prefix + dynamic suffix; sub-part `cacheControl` on Anthropic/Bedrock/Alibaba; stable ordering for OpenAI auto-cache    | No optimization                               | Unknown                                             |
| **Tool output compression**                 | LLM-powered compression (3 templates: EXTRACT, SUMMARIZE, FILTER) before outputs hit cloud model; anti-hallucination + fallback                         | None                                          | Unknown                                             |
| **MCP tool filtering**                      | Native per-provider/model tool filtering; ApplyPatch swap for GPT-4.1; WebSearch gating; route-based filtering (cloud vs local)                         | None                                          | Tool allowlists per agent                           |
| **Persistent memory**                       | Cross-session file-based memory (`~/.local/share/opencode/memory/`); `memory_persist` tool; types: user/project/feedback; injected into system prompt   | None                                          | Native                                              |
| **Session memory**                          | SQLite-backed per-session entries; survive `/clear` and `/clear-compact`; `/memory_add`, `/memory_edit`, `/memory_delete`                               | None                                          | Session memory (markdown file, subagent extraction) |
| **Goal tracking**                           | `/goal` command sets autonomous objective; `goal_complete` tool; auto-continuation loop (200-turn cap + token budget); status in prompt                 | None                                          | Native                                              |
| **Context safety net**                      | 3-tier: tool result budget (50K cap) → MicroCompact (75% threshold) → Context Collapse (97% emergency)                                                  | Basic overflow handling                       | Auto-compact + micro-compact                        |
| **Experimental: Sliding window compaction** | Rolling head summary + verbatim tail; cached per boundary; inflight dedup; configurable threshold/ratio                                                 | Hard truncation                               | Forked subagent compaction                          |
| **Doom loop detection**                     | Ring-buffer hash detector (configurable threshold); aborts repeated identical tool calls                                                                | None                                          | Unknown                                             |
| **Snapshot gate**                           | Skips git snapshot track/patch when no FS-mutating tool fired; saves IO per non-edit turn                                                               | None                                          | Unknown                                             |
| **Part coalescer**                          | Batches rapid streaming part updates (300ms window); flushes terminal states immediately; reduces DB writes                                             | None                                          | Unknown                                             |
| **Parallel tool execution**                 | Safe concurrent read/glob/grep within single LLM round-trip                                                                                             | None                                          | Native                                              |
| **Hybrid model routing**                    | Per-task-category model routing + ultrawork override; configurable per provider/model                                                                   | None                                          | Fast mode (single toggle)                           |
| **Configurable subagent timeout**           | `experimental.subagent_timeout` in config                                                                                                               | Hardcoded                                     | Hardcoded                                           |
| **Orchestration guardrails**                | Configurable spawn depth limits, descendant caps, per-model concurrency limiter, doom loop + hard cap                                                   | Basic                                         | Coordinator mode (feature-gated)                    |
| **`/clear`**                                | Clear session messages (keeps session alive)                                                                                                            | None                                          | `/clear` equivalent                                 |
| **`/clear-compact`**                        | Clear + trigger compaction of history                                                                                                                   | None                                          | Native - /compact                                   |
| **`/btw`**                                  | Inject context without starting new turn (no LLM call)                                                                                                  | None                                          | Native                                              |
| **`/goto`**                                 | Switch project directory                                                                                                                                | None                                          | None                                                |
| **`/status` (improved)**                    | Shows session ID, model, provider, token counts, cost; copyable session ID for debugging                                                                | Basic status                                  | Native                                              |
| **Per-tool token usage**                    | Streaming token count displayed per tool call during execution                                                                                          | None                                          | None                                                |
| **`/config`**                               | Shows all merged config key-values in a toast (mirrors Claude Code `/status` config section)                                                            | None                                          | Part of `/status`                                   |
| **`/usage`**                                | Per-model cost/tokens/duration breakdown + subagent costs (mirrors Claude Code `/status` usage section)                                                 | None                                          | Part of `/status`                                   |
| **Read tool safe default**                  | 300-line limit with head+tail summary; prevents context floods                                                                                          | Unbounded                                     | Bounded (configurable)                              |
| **Session cost tracking**                   | Per-session totals, tiered pricing, streaming token count during execution, cache-aware (no double-count)                                               | Basic                                         | Full cost tracker                                   |
| **LSP efficiency**                          | Orphan prevention, stale diagnostics cleanup, idle shutdown, nearest-package resolution                                                                 | Accumulates servers                           | LSP with diagnostic registry                        |
| **Provider lock-in**                        | None — 75+ providers via Vercel AI SDK                                                                                                                  | None (same)                                   | Anthropic-only                                      |
| **Pricing**                                 | Free/OSS, bring your own keys                                                                                                                           | Free/OSS, bring your own keys                 | $200/mo subscription or API usage                   |

---

## Key Differentiators

### vs. Upstream OpenCode

OpenCode X is upstream + 280 commits of fork-only features. Everything above marked "None" in the upstream column is exclusive to this fork. The fork maintains rebase compatibility — features are isolated in new files behind feature flags.

### vs. Claude Code

OpenCode X ports the _best ideas_ from Claude Code (hooks, spinner verbs, session memory, background agents, context management, usage tracking) into an open, provider-agnostic system. Key advantages:

- **No vendor lock-in** — use Claude, GPT, Gemini, Mistral, local models, or any OpenAI-compatible endpoint
- **Claude Code hooks work natively** — existing `~/.claude/settings.json` hook configs are auto-detected and run without modification
- **LLM compression** — Claude Code sends raw tool output to the model; OpenCode X pre-compresses, saving 30-60% tokens on large outputs
- **Goal system** — autonomous multi-turn execution toward an objective (Claude Code lacks this)
- **Fully open source** — MIT license, no telemetry, no account requirement

---

## Feature Details

### Claude Code Hook + Plugin Compatibility

Hooks and plugins loaded from multiple Claude Code paths:

1. Project `.claude/settings.json` → hooks section
2. Global `~/.claude/settings.json` → hooks section
3. `~/.claude/hooks/commands.json` → custom slash commands
4. `~/.claude/plugins/installed_plugins.json` → installed plugin skills auto-discovered and registered

Events: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `Stop`, `SessionStart`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`

Env vars match Claude Code exactly: `CLAUDE_TOOL_NAME`, `CLAUDE_TOOL_INPUT`, `CLAUDE_TOOL_RESULT`, `CLAUDE_SESSION_ID`, `CLAUDE_MODEL`, `CLAUDE_USER_PROMPT`. Event JSON also passed on stdin. Timeout spec in seconds (Claude Code convention).

### Push to Background (Leader+D)

Detaches a running session to background without killing it. TUI immediately accepts new input. When the background session completes, a toast notification fires. Similar to Claude Code's background tasks but user-initiated (push any running agent to background on demand).

### Tool Output Compression

```json
{
  "hybrid": {
    "enabled": true,
    "cheap_model": { "providerID": "anthropic", "modelID": "claude-haiku-4-5" },
    "compression_timeout_ms": 8000
  }
}
```

Three templates selected per tool type:

- **EXTRACT** — key lines, file/line refs (`grep`, `glob`, `bash`)
- **SUMMARIZE** — 3–6 bullets (`read`, large output)
- **FILTER** — matching items only, noise dropped (logs, diffs)

Falls back to raw output on any error. Validates compression preserves key facts.

### Goal System

```
/goal Implement feature X with tests passing
```

- Agent works autonomously toward objective
- Auto-injects continuation messages between turns
- `goal_complete` tool called by agent with evidence when done
- Guards: 200-turn hard limit, optional token budget, pause on budget exceeded
- Status injected into system prompt dynamic section (cache-safe)

### Persistent Memory

Cross-session memory in `~/.local/share/opencode/memory/` as markdown files with YAML frontmatter:

```markdown
---
name: prefers-effect-ts
type: user
created: 2026-05-20
---

User always wants Effect-ts patterns, no raw Promises.
```

Model uses `memory_persist` tool to save facts automatically. Injected into system prompt on session start.

### Cache Stability (Prompt Split)

System prompt restructured: stable prefix (identity, tools, skills, AGENTS.md) cached via provider-specific breakpoints; dynamic suffix (env, memory, goals) changes freely without invalidating the cached prefix.

| Provider                  | Mechanism                                                       |
| ------------------------- | --------------------------------------------------------------- |
| Anthropic/Bedrock/Alibaba | Sub-part `cacheControl` on stable prefix within existing Slot 1 |
| OpenAI                    | Longer stable prefix = more tokens match auto-cache (≥1024)     |
| OpenRouter                | Inherits upstream provider behavior                             |

### Context Safety Net (3-Tier)

1. **Tool Result Budget** — global char budget; oldest tool outputs truncated first
2. **MicroCompact** (75% context used) — summarize old messages, keep 10 most recent verbatim
3. **Context Collapse** (97% context used) — emergency: backup full history to file, replace with structured summary + last user message

### Sliding Window Compaction

```json
{
  "compaction": {
    "sliding_window": { "threshold": 50000, "tail_ratio": 0.5 }
  }
}
```

Rolling head+tail split. Summary cached by boundary position. Only re-summarizes when head grows.

### Performance Optimizations

- **Snapshot Gate** — skips git track/patch when no FS tool fired (saves IO)
- **Part Coalescer** — batches streaming updates (300ms), reduces SQLite writes
- **Doom Loop Detector** — ring-buffer hash; aborts after N identical consecutive tool calls
- **Per-model Concurrency** — prevents thundering-herd on rate-limited endpoints

### Slash Commands

| Command          | Description                                                |
| ---------------- | ---------------------------------------------------------- |
| `/btw`           | Inject context without starting a new turn (no LLM call)   |
| `/clear`         | Clear session messages                                     |
| `/clear-compact` | Clear messages and compact history                         |
| `/config`        | Show all merged config key-values in toast                 |
| `/usage`         | Per-model cost/tokens/duration + subagent costs            |
| `/goto`          | Jump to a file or symbol                                   |
| `/goal`          | Set autonomous objective                                   |
| `/memory_add`    | Add session memory entry                                   |
| `/memory_edit`   | Edit existing memory entry                                 |
| `/memory_delete` | Remove memory entry                                        |
| `/status`        | Session info with copyable session ID, model, cost, tokens |

### Spinner Verbs

A creative random pool for global spinner rotation ("Sherlocking…", "Overthinking…", "Vibecoding…") with mood-based color cycling.

### Easter Egg

Clicking the opencode logo plays 3 variations of the _faaaaah_ sound.

### Development

```bash
bun install
bun run dev                              # TUI
bun run --cwd packages/opencode dev      # CLI
bun --cwd packages/opencode run build
bun --cwd packages/opencode test --timeout 30000
```

### Requirements

- Any LLM API key (Anthropic, OpenAI, Google, etc.)
- Bun 1.3.11+ (for building from source only)

---

## Resources

- **Upstream**: https://github.com/anomalyco/opencode
- **Docs**: https://opencode.ai/docs
- **Repository**: https://github.com/sdeonvacation/opencode-x

---

## Tech Stack

- **Runtime**: Bun 1.3.11
- **Language**: TypeScript 5.8
- **Framework**: Effect-ts 4.0.0-beta
- **TUI**: Solid.js + @opentui
- **Database**: SQLite + Drizzle
- **AI**: Vercel AI SDK + 75+ providers

---

## License

See [LICENSE](./LICENSE).
