# OpenCode X

[![npm version](https://img.shields.io/npm/v/@sdeonvacation/opencode-x?color=blue)](https://www.npmjs.com/package/@sdeonvacation/opencode-x)
[![GitHub release](https://img.shields.io/github/v/release/sdeonvacation/opencode-x)](https://github.com/sdeonvacation/opencode-x/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/sdeonvacation/opencode-x)](https://github.com/sdeonvacation/opencode-x/stargazers)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Built with Effect](https://img.shields.io/badge/Built%20with-Effect--TS-purple)](https://effect.website/)

A terminal-based AI coding agent that works with **any LLM provider**. Built on [opencode](https://github.com/anomalyco/opencode), adding production-grade features: swarm execution, global LSP sharing, persistent memory, autonomous goals, and cost-aware context management.

Think Claude Code, but open source, provider-agnostic, and free.

## Demo

<p align="center">
  <img src="./assets/opencode-x-demo.gif" alt="OpenCode X — terminal AI agent with swarm execution and multi-provider support" width="800">
  <br>
  <em>Autonomous multi-turn task execution with real-time cost tracking</em>
</p>

---

## Why OpenCode X?

Native support for claude code plugins and hooks. Bundles several claude code features like /btw, /goal, push-to-background subagents, memory and detailed usage tracking. All of this, while giving you the provider-agnostic flavour of opencode. Best of both worlds.

|                         | OpenCode X                                           | Claude Code           |
| ----------------------- | ---------------------------------------------------- | --------------------- |
| **Cost**                | Free + bring your own API keys                       | $200/mo subscription  |
| **Models**              | Any provider (Claude, GPT, Gemini, Mistral, local)   | Anthropic only        |
| **Swarm execution**     | Batch-parallel subagents with bounded concurrency    | Native                |
| **Worktree management** | `/worktree` command for user-initiated isolation     | `--worktree` CLI flag |
| **Global LSP**          | Single instance shared across all agents + worktrees | Unknown               |
| **Autonomous goals**    | `/goal` with 200-turn auto-continuation              | /goal but no configurable turn/token limits         |
| **Token savings**       | LLM compression saves 30-60% on tool output          | Raw output to model   |
| **Claude Code hooks**   | Native compatibility (same config, same env vars)    | Native                |
| **Open source**         | MIT, no telemetry, no account                        | Proprietary           |

vs. **upstream opencode**: OpenCode X adds 280+ fork-only commits — swarm, persistent memory, goal system, session memory, context safety net, push-to-background, tool compression, cache optimization, global LSP sharing, `/worktree` command, and more. Full comparison below.

---

## Install

### npm (Recommended)

```bash
npm install -g @sdeonvacation/opencode-x
opencode-x
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
```

### Build from Source

```bash
git clone https://github.com/sdeonvacation/opencode-x
cd opencode-x && bun install
./packages/opencode/script/build.ts --single
# Binary at: packages/opencode/dist/opencode-$(uname -s | tr A-Z a-z)-$(uname -m)/bin/opencode
```

---

## Quick Start

```bash
# 1. Set any API key
export ANTHROPIC_API_KEY=sk-...    # or OPENAI_API_KEY, GOOGLE_API_KEY, etc.

# 2. Run
opencode-x

# 3. Type a prompt. That's it.
```

Switch models anytime — no config migration, no lock-in.

---

## Configuration

For full configuration, agent setup, skills, hooks, and plugin details, see the **[OpenCode-X Guide](./OPENCODE-X_GUIDE.md)**.

---

## Feature Highlights

### Swarm Execution

Dispatch the same prompt template across N items in parallel. Review 10 files, lint 5 modules, translate 3 documents — all at once.

```json
{ "experimental": { "swarm": true, "swarm_concurrency": 5 } }
```

- Bounded concurrency (default 5, max 20)
- Per-item failure isolation (one failure doesn't abort the rest)
- Background mode: dispatch and continue working

### Global LSP/MCP Sharing

Single LSP/MCP server per project, shared across all agent types — primary, subagents, background sessions, isolated worktrees, swarms. No redundant spawns. Path translation maps worktree paths to parent-equivalent. Idle shutdown after 30 minutes.

### Worktree Isolation + `/worktree` Command

Upstream opencode isolates subagents in worktrees automatically. OpenCode X adds the `/worktree` (or `/wt`) slash command for **user-initiated** worktree management: create, list, remove, switch directory. Useful when you want to manually manage parallel workstreams.

### Autonomous Goals

```
/goal Implement feature X with tests passing
```

Agent works autonomously toward the objective. Auto-continuation between turns, 200-turn hard limit, optional token budget. `goal_complete` tool called with evidence when done.

### Tool Output Compression

LLM-powered compression before tool outputs reach the main model. Three strategies (EXTRACT, SUMMARIZE, FILTER) selected per tool type. Saves 30-60% tokens on large outputs.

### Persistent + Session Memory

- **Persistent**: cross-session facts in `~/.local/share/opencode/memory/` — preferences, project conventions, corrections
- **Session**: SQLite-backed entries that survive `/clear` and compaction

### Push to Background (Leader+D)

Detach any running session to background without killing it. TUI immediately accepts new input. Toast notification on completion.

### Context Safety Net (3-Tier)

1. **Tool Result Budget** (50K cap) — oldest outputs truncated first
2. **MicroCompact** (75% context) — summarize old messages, keep 10 recent
3. **Context Collapse** (97% context) — emergency backup + structured summary

### Cache Stability

System prompt split into stable prefix (cached) + dynamic suffix (changes freely). Saves cache invalidation costs on every turn.

---

## Full Comparison (vs. Upstream + Claude Code)

<details>
<summary><strong>Click to expand full feature matrix</strong></summary>

| Feature                                      | **OpenCode X**                                                                                                                                          | **Upstream OpenCode**                          | **Claude Code**                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------- |
| **Claude Code hooks + plugins**              | Native — reads `~/.claude/settings.json` hooks, `~/.claude/plugins/installed_plugins.json`, `~/.claude/hooks/commands.json`; same events, same env vars | Plugin system only (no hook lifecycle events)  | Native                                              |
| **Push agent to background**                 | `Leader+D` chord detaches running session to background; TUI unblocks for new prompts, toast on completion                                              | Background subagents (spawn only)              | Native                                              |
| **Cache stability (prompt split)**           | System prompt split into stable prefix + dynamic suffix; sub-part `cacheControl` on Anthropic/Bedrock/Alibaba; stable ordering for OpenAI auto-cache    | No optimization                                | Unknown                                             |
| **Tool output compression**                  | LLM-powered compression (3 templates: EXTRACT, SUMMARIZE, FILTER) before outputs hit cloud model; anti-hallucination + fallback                         | None                                           | Unknown                                             |
| **MCP tool filtering**                       | Native per-provider/model tool filtering; ApplyPatch swap for GPT-4.1; WebSearch gating; route-based filtering (cloud vs local)                         | None                                           | Tool allowlists per agent                           |
| **Persistent memory**                        | Cross-session file-based memory (`~/.local/share/opencode/memory/`); `memory_persist` tool; types: user/project/feedback; injected into system prompt   | None                                           | Native                                              |
| **Session memory**                           | SQLite-backed per-session entries; survive `/clear` and `/clear-compact`; `/memory_add`, `/memory_edit`, `/memory_delete`                               | None                                           | Session memory (markdown file, subagent extraction) |
| **Goal tracking**                            | `/goal` command sets autonomous objective; `goal_complete` tool; auto-continuation loop (200-turn cap + token budget); status in prompt                 | None                                           | Native                                              |
| **Context safety net**                       | 3-tier: tool result budget (50K cap) → MicroCompact (75% threshold) → Context Collapse (97% emergency)                                                  | Basic overflow handling                        | Auto-compact + micro-compact                        |
| **Sliding window compaction**                | Rolling head summary + verbatim tail; cached per boundary; inflight dedup; configurable threshold/ratio                                                 | Hard truncation                                | Forked subagent compaction                          |
| **Doom loop detection**                      | Ring-buffer hash detector (configurable threshold); aborts repeated identical tool calls                                                                | None                                           | Unknown                                             |
| **Snapshot gate**                            | Skips git snapshot track/patch when no FS-mutating tool fired; saves IO per non-edit turn                                                               | None                                           | Unknown                                             |
| **Part coalescer**                           | Batches rapid streaming part updates (300ms window); flushes terminal states immediately; reduces DB writes                                             | None                                           | Unknown                                             |
| **Parallel tool execution**                  | Safe concurrent read/glob/grep within single LLM round-trip                                                                                             | None                                           | Native                                              |
| **Swarm (batch parallel subagents)**         | `SwarmTool` — same prompt template dispatched across N items in parallel; foreground or background; bounded concurrency; per-item failure isolation     | None                                           | Native                                              |
| **Worktree isolation + `/worktree` command** | `isolation: true` on Task tool + `/worktree` slash command for user-initiated management (create, list, remove, switch)                                 | Subagent-only (automatic, no user command)     | `--worktree` flag + `isolation: worktree`           |
| **Global LSP/MCP sharing**                   | Single LSP/MCP instance shared across all agent types; path translation for worktree paths; idle shutdown after 30min                                   | Per-subagent spawn (not shared with worktrees) | Unknown                                             |
| **Hybrid model routing**                     | Per-task-category model routing + ultrawork override; configurable per provider/model                                                                   | None                                           | Fast mode (single toggle)                           |
| **Configurable subagent timeout**            | `experimental.subagent_timeout` in config                                                                                                               | Hardcoded                                      | Hardcoded                                           |
| **Orchestration guardrails**                 | Configurable spawn depth limits, descendant caps, per-model concurrency limiter, doom loop + hard cap                                                   | Basic                                          | Coordinator mode (feature-gated)                    |
| **`/clear`**                                 | Clear session messages (keeps session alive)                                                                                                            | None                                           | `/clear` equivalent                                 |
| **`/clear-compact`**                         | Clear + trigger compaction of history                                                                                                                   | None                                           | Native - /compact                                   |
| **`/btw`**                                   | Inject context without starting new turn (no LLM call)                                                                                                  | None                                           | Native                                              |
| **`/goto`**                                  | Switch project directory                                                                                                                                | None                                           | None                                                |
| **`/status` (improved)**                     | Shows session ID, model, provider, token counts, cost; copyable session ID for debugging                                                                | Basic status                                   | Native                                              |
| **Per-tool token usage**                     | Streaming token count displayed per tool call during execution                                                                                          | None                                           | None                                                |
| **`/config`**                                | Shows all merged config key-values in a toast                                                                                                           | None                                           | Part of `/status`                                   |
| **`/usage`**                                 | Per-model cost/tokens/duration breakdown + subagent costs                                                                                               | None                                           | Part of `/status`                                   |
| **Read tool safe default**                   | 300-line limit with head+tail summary; prevents context floods                                                                                          | Unbounded                                      | Bounded (configurable)                              |
| **Session cost tracking**                    | Per-session totals, tiered pricing, streaming token count during execution, cache-aware (no double-count)                                               | Basic                                          | Full cost tracker                                   |
| **LSP efficiency**                           | Orphan prevention, stale diagnostics cleanup, idle shutdown, nearest-package resolution                                                                 | Accumulates servers                            | LSP with diagnostic registry                        |
| **Provider lock-in**                         | None — 75+ providers via Vercel AI SDK                                                                                                                  | None (same)                                    | Anthropic-only                                      |
| **Pricing**                                  | Free/OSS, bring your own keys                                                                                                                           | Free/OSS, bring your own keys                  | $200/mo subscription or API usage                   |

</details>

---

## Featured Slash Commands

| Command          | Description                                                |
| ---------------- | ---------------------------------------------------------- |
| `/btw`           | Inject context without starting a new turn (no LLM call)   |
| `/clear`         | Clear session messages                                     |
| `/clear-compact` | Clear messages and compact history                         |
| `/config`        | Show all merged config key-values in toast                 |
| `/goal`          | Set autonomous objective                                   |
| `/goto`          | Jump to a file or symbol                                   |
| `/memory_add`    | Add session memory entry                                   |
| `/memory_edit`   | Edit existing memory entry                                 |
| `/memory_delete` | Remove memory entry                                        |
| `/status`        | Session info with copyable session ID, model, cost, tokens |
| `/usage`         | Per-model cost/tokens/duration + subagent costs            |
| `/worktree`      | Manage git worktrees (create, list, remove, switch)        |

---

## Tech Stack

- **Runtime**: Bun 1.3.11
- **Language**: TypeScript 5.8
- **Framework**: Effect-ts 4.0.0-beta
- **TUI**: Solid.js + @opentui
- **Database**: SQLite + Drizzle
- **AI**: Vercel AI SDK + 75+ providers

---

## Contributing

```bash
git clone https://github.com/sdeonvacation/opencode-x
cd opencode-x && bun install
bun run dev                              # TUI
bun run --cwd packages/opencode dev      # CLI
bun --cwd packages/opencode run build
bun --cwd packages/opencode test --timeout 30000
```

Requires Bun 1.3.11+.

---

## Resources

- **Upstream**: https://github.com/anomalyco/opencode
- **Docs**: https://opencode.ai/docs
- **Repository**: https://github.com/sdeonvacation/opencode-x

---

## License

See [LICENSE](./LICENSE).
