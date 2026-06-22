# OpenCode X

[![npm version](https://img.shields.io/npm/v/@sdeonvacation/opencode-x?color=blue)](https://www.npmjs.com/package/@sdeonvacation/opencode-x)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/sdeonvacation/opencode-x)](https://github.com/sdeonvacation/opencode-x/stargazers)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Built with Effect](https://img.shields.io/badge/Built%20with-Effect--TS-purple)](https://effect.website/)

**Everything Claude Code does and more. Any model. Zero subscription. Smarter with your tokens.**

OpenCode X is a terminal AI coding agent forked from [opencode](https://github.com/anomalyco/opencode) with 280+ commits. It matches Claude Code's headline features (autonomous goals, background execution, parallel subagents, hooks) while adding what Claude Code can't offer: provider freedom, intelligent token compression, 3-tier context safety, configurable orchestration guardrails, and an open-source MIT codebase you actually own.

Your existing claude code hooks, plugins, agents and skills work immediately. Zero migration.

<p align="center">
  <img src="./assets/opencode-x-demo.gif" alt="OpenCode X — terminal AI agent with swarm execution and multi-provider support" width="800">
  <br>
  <em>Autonomous multi-turn execution with real-time cost tracking</em>
</p>

---

## Why Switch?

### Coming from Claude Code?

You're paying $200+/month per developer for a single-provider tool. OpenCode X gives you the same workflow with genuine advantages:

- **$0/month** — bring your own API keys, pay only for tokens you use
- **Any model** — Claude, GPT, Gemini, Mistral, Llama, DeepSeek, or any of 75+ providers
- **30-60% token savings** — LLM compression on tool outputs before they reach your model (Claude Code sends raw output)
- **Never lose context** — 3-tier safety net auto-recovers at 75%, 97%, and 413 overflow (Claude Code only has auto-compact)
- **Your hooks already work** — same config, same env vars, same lifecycle events
- **Configurable guardrails** — doom loop detection, spawn limits, per-model concurrency (Claude Code doesn't expose these)
- **Hybrid routing** — automatically route compression/titles to cheap models, reasoning to premium ones
- **Open source** — MIT, no telemetry, no account, fork and extend freely

### Coming from opencode?

Same foundation you love. 280 commits of production-grade additions:

- **Swarm execution** — batch-parallel subagents with bounded concurrency using `/swarm`
- **Autonomous goals** — `/goal` with judge validation and 200-turn auto-continuation
- **Persistent + session memory** — agent learns across sessions, remembers across `/clear`
- **Push to background** — `Leader+D` detaches running session, keeps working
- **Token intelligence** — LLM compression, improved cache stability
- **Context safety net** — 3-layer auto-recovery, sessions never crash from overflow
- **Doom loop detection** — catches infinite tool loops before they burn tokens
- **Parallel tool calls** — concurrent read/grep/glob within single LLM round-trip
- **Hybrid model routing** — cheap model for lightweight work, premium for reasoning
- **Claude Code compatibility** — hooks, plugins, agents, skills, CLAUDE.md all work out of the box
- **Orchestration guardrails** — spawn depth limits, descendant caps, concurrency controls

---

## Honest Comparison

OpenCode X doesn't pretend to replace everything Claude Code offers. Here's what's the same, what's better, and what's different:

### What OpenCode X matches

| Capability               | Claude Code                                       | OpenCode X                                         |
| ------------------------ | ------------------------------------------------- | -------------------------------------------------- |
| **Autonomous goals**     | `/goal` + Haiku evaluator, `--tokens` budget      | `/goal` + judge model, 200-turn cap + token budget |
| **Background execution** | `Ctrl+B`, `/background`, `claude agents` daemon   | `Leader+D` push-to-background, toast on completion |
| **Parallel subagents**   | Task tool, subagent spawning, worktree isolation  | Task tool, swarm mode, worktree isolation          |
| **Hooks system**         | PreToolUse, PostToolUse, SessionStart, Stop, etc. | Same events + same env vars (native compatible)    |
| **Persistent memory**    | CLAUDE.md + auto-memory (MEMORY.md)               | AGENTS.md + persistent memory + session memory     |
| **Worktree isolation**   | `--worktree`, per-session isolation               | `isolation: true` on tasks + `/worktree` command   |
| **Skills system**        | On-demand skill loading                           | Same (compatible with `~/.claude/skills/`)         |

### Where OpenCode X is genuinely better

| Advantage                    | Detail                                                                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cost**                     | $0 subscription. You pay only API tokens at provider rates. Claude Code averages $150-250/mo per developer.                                              |
| **Provider freedom**         | 75+ providers via Vercel AI SDK. Switch models mid-session. No lock-in.                                                                                  |
| **Token compression**        | LLM-powered compression (EXTRACT/SUMMARIZE/FILTER) reduces tool output 30-60% before it hits your model. Claude Code passes raw output.                  |
| **Context safety**           | 3-tier auto-recovery: Tool Result Budget (always) → MicroCompact (75%) → Context Collapse (97%) + reactive 413 retry. Claude Code has auto-compact only. |
| **Cache stability**          | System prompt split into stable prefix (cached) + dynamic suffix. Memory/goals change without cache invalidation.                                        |
| **Doom loop detection**      | Ring-buffer catches repeated identical tool calls. Configurable threshold. Claude Code doesn't expose this.                                              |
| **Orchestration guardrails** | Spawn depth (3), descendant caps (50), per-model concurrency semaphore, configurable loop threshold. All tunable.                                        |
| **Hybrid routing**           | Automatic cloud/local model split. Compression, titles, compaction routed to cheap model. Reasoning stays on premium.                                    |
| **Global LSP sharing**       | Single LSP instance across all agents + worktrees. Path translation, idle shutdown. No redundant spawns.                                                 |
| **MCP tool filtering**       | Per-server `tools` allowlist removes unused tools from prompt. Saves 2-8K tokens/call. Claude Code sends all tools always.                               |
| **Snapshot gate**            | Skips git diff tracking on read-only turns. Zero overhead for non-edit steps.                                                                            |
| **Part coalescer**           | Batches rapid streaming updates (300ms). Eliminates per-token DB writes.                                                                                 |
| **Open source**              | MIT license. No telemetry. No account. Full source. Fork, modify, self-host.                                                                             |

### What Claude Code has that OpenCode X doesn't - yet :)

| Claude Code exclusive      | What it is                                                              |
| -------------------------- | ----------------------------------------------------------------------- |
| **Agent teams**            | Multiple sessions with peer-to-peer communication and shared task lists |
| **Dynamic workflows**      | JS orchestration scripts, up to 1000 agents per run, 16 concurrent      |
| **`/batch`**               | Auto-splits codebase changes into worktree-isolated PRs                 |
| **Multi-surface**          | Desktop app, VS Code, JetBrains, web interface                          |
| **Agent view dashboard**   | Visual monitoring and dispatch for background sessions                  |
| **Managed infrastructure** | Background daemon, `claude agents`                                      |

---

## Install

### npm (Recommended)

```bash
npm install -g @sdeonvacation/opencode-x
opencode-x
```

### Download Binary

Grab from [Releases](https://github.com/sdeonvacation/opencode-x/releases/latest):

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

Already have Claude Code hooks in `~/.claude/settings.json`? They work automatically.

---

## Feature Deep Dive

### Token Intelligence

Multiple systems work together to minimize cost — the single biggest advantage over Claude Code's raw-output approach:

**LLM Compression** — Large tool outputs are pre-processed by a fast model before reaching your main model. Three strategies selected automatically:

| Strategy  | Used for          | Result                             |
| --------- | ----------------- | ---------------------------------- |
| EXTRACT   | grep, glob, bash  | Key lines, bullets, file/line refs |
| SUMMARIZE | read, large prose | 3-6 bullet summary of key facts    |
| FILTER    | logs, diffs       | Matching items only, noise dropped |

Falls back silently to raw output on error. Never corrupts results.

**Cache Stability** — System prompt split into stable prefix (cached across turns) and dynamic suffix (memory, goals, env). Dynamic content changes without invalidating the cached prefix.

**Snapshot Gate** — Skips expensive git diff tracking on read-only turns (grep, read, search).

**Part Coalescer** — Batches rapid streaming DB writes (300ms debounce window).

### 3-Tier Context Safety Net

Sessions never crash from token overflow. Three layers trigger automatically:

| Tier                   | Trigger          | Action                                            |
| ---------------------- | ---------------- | ------------------------------------------------- |
| **Tool Result Budget** | Always active    | Oldest tool outputs truncated (50K char cap)      |
| **MicroCompact**       | 75% context used | Summarize older messages, keep 10 recent verbatim |
| **Context Collapse**   | 97% context used | Emergency backup to disk + structured summary     |

Plus: reactive 413 recovery retries the same turn inline after emergency compaction. No user intervention needed.

### Autonomous Goals

```
/goal Implement authentication middleware with all tests passing
```

Agent works autonomously. After each turn, a separate judge model evaluates whether the condition is met. On "no," the agent keeps working with the judge's reasoning as guidance. Guards prevent runaway:

- 200-turn hard limit (configurable)
- Optional token budget
- Independent judge validation (prevents premature self-reported success)

### Swarm Execution

One tool call spawns N parallel subagents with the same prompt template:

```json
{ "experimental": { "swarm": true, "swarm_concurrency": 5 } }
```

- Items up to 128, concurrency 1-20
- Per-item failure isolation (one crash doesn't abort others)
- Background mode: dispatch and keep working, results auto-injected on completion
- Structured XML results with per-item status and timing

### Push to Background (`Leader+D`)

Mid-execution, press `Leader+D`. Running agent detaches to background. TUI immediately accepts new input. Toast notification fires on completion. Session remains in session list.

### Hybrid Model Routing

Route work to the right model automatically:

```json
{
  "hybrid": {
    "enabled": true,
    "cheap_model": { "providerID": "anthropic", "modelID": "claude-haiku-4-5" }
  },
  "experimental": {
    "task_categories": { "review": { "providerID": "anthropic", "modelID": "claude-sonnet-4-6" } },
    "ultrawork_model": { "providerID": "anthropic", "modelID": "claude-sonnet-4-6" }
  }
}
```

- **Compression routing** — cheap model handles tool output compression, titles, compaction
- **Category routing** — tasks routed by type (review → sonnet, exploration → haiku)
- **Ultrawork routing** — `use_ultrawork: true` triggers premium reasoning model
- **Concurrency limiter** — per-model semaphore prevents API throttling

### Orchestration Guardrails

Configurable protections that Claude Code doesn't expose:

- **Doom loop detection** — ring-buffer hash catches repeated identical tool calls (default threshold: 5)
- **Spawn depth limit** — max 3 levels of nested subagents
- **Descendant cap** — max 50 total subagents per root session
- **Per-model concurrency** — semaphore prevents API rate limiting across parallel subagents
- **Stream idle timeout** — abort + retry stalled provider streams (default: 60s)

### Persistent + Session Memory

**Persistent memory** — cross-session facts in `~/.local/share/opencode/memory/`. Three types: user preferences, project conventions, corrections. Injected into every session's system prompt. Agent learns from your corrections over time.

**Session memory** — SQLite-backed entries that survive `/clear` and compaction. Managed via `/memory_add`, `/memory_edit`, `/memory_delete`. Scoped to current session only.

### Global LSP/MCP Sharing

Single LSP server per project, shared across all agent types — primary, subagents, background sessions, swarm workers, isolated worktrees. Path translation maps worktree paths to parent directory. 30-minute idle shutdown + auto-respawn.

No redundant server spawns. Consistent diagnostics everywhere. Zero LSP overhead multiplication.

### MCP Tool Filtering

Each MCP server exposes all its tools by default, which can add thousands of tokens to every LLM call. Use the `tools` allowlist to expose only the tools you need:

```json
{
  "mcp": {
    "context-mode": {
      "type": "local",
      "command": ["node", "server.js"],
      "tools": ["ctx_execute", "ctx_search", "ctx_batch_execute"]
    }
  }
}
```

Tools not in the allowlist are never sent to the model. Omit `tools` to expose everything (default).

### Claude Code Compatibility

Your existing setup works immediately with no migration:

| Source                                                        | Auto-loaded                  |
| ------------------------------------------------------------- | ---------------------------- |
| `~/.claude/settings.json` hooks                               | Yes                          |
| `~/.claude/hooks/commands.json`                               | Yes (as slash commands)      |
| `~/.claude/plugins/installed_plugins.json`                    | Yes (skills auto-discovered) |
| `CLAUDE.md` / `AGENTS.md`                                     | Yes                          |
| Same env vars (`CLAUDE_TOOL_NAME`, `CLAUDE_SESSION_ID`, etc.) | Yes                          |

Supported hook events: `PreToolUse`, `PostToolUse`, `SessionStart`, `UserPromptSubmit`, `Stop`

### Parallel Tool Calls

Safe concurrent execution of read-only tools within a single LLM round-trip. Permission-aware gate ensures only pre-approved, parallel-safe tools run concurrently:

---

## Featured Slash Commands

| Command          | Description                                              |
| ---------------- | -------------------------------------------------------- |
| `/goal`          | Set autonomous objective with judge validation           |
| `/btw`           | Inject context without starting a new turn (no LLM call) |
| `/swarm`         | Swarm concurrent agents to solve a task quickly.         |
| `/config`        | Show all merged config in toast                          |
| `/usage`         | Per-model cost/tokens/duration + subagent costs          |
| `/status`        | Session info with copyable ID, model, cost, tokens       |
| `/memory_add`    | Add session memory entry                                 |
| `/memory_edit`   | Edit existing memory entry                               |
| `/memory_delete` | Remove memory entry                                      |
| `/worktree`      | Manage git worktrees (create, list, remove, switch)      |

---

## Performance Numbers

Measured improvements over baseline opencode and raw LLM interaction:

| Metric                         | Improvement                                    |
| ------------------------------ | ---------------------------------------------- |
| Sliding window compaction      | **47% fewer input tokens** at 50-67K context   |
| LLM tool compression           | **30-60% token savings** on large tool outputs |
| Agent loop optimization        | **30%+ wall-clock reduction** per turn         |
| Turn reduction (simple tasks)  | 10-12 turns → **5-7 turns**                    |
| Turn reduction (complex tasks) | 18-22 turns → **9-13 turns**                   |
| SQLite transactions            | **50%+ reduction** via part coalescing         |
| Read-only turns                | **Zero git overhead** via snapshot gate        |

---

## Configuration

Full reference in **[OPENCODE-X_GUIDE.md](./OPENCODE-X_GUIDE.md)**.

Key experimental features:

```json
{
  "experimental": {
    "swarm": true,
    "swarm_concurrency": 5,
    "goal_system": true,
    "parallel_tool_calls": true,
    "microcompact": true,
    "context_collapse": true,
    "tool_result_budget": 50000,
    "prompt_split_caching": true,
    "worktree_isolation": true,
    "background_subagents": true,
    "loop_detector_threshold": 5,
    "max_subagent_depth": 3,
    "max_subagent_descendants": 50,
    "ultrawork_model": { "providerID": "anthropic", "modelID": "claude-sonnet-4-6" }
  },
  "hybrid": {
    "enabled": true,
    "cheap_model": { "providerID": "anthropic", "modelID": "claude-haiku-4-5" }
  }
}
```

---

## What's Coming

Active development pushing further ahead:

| Feature               | What it does                                                          |
| --------------------- | --------------------------------------------------------------------- |
| **Response Chaining** | OpenAI `previousResponseId` — near-zero input tokens on chained turns |
| **Goal Judge**        | Independent model validates goal completion with retry logic          |
| **Budgeted Reading**  | Token-budgeted file injection preserving section structure            |
| **Max Mode**          | Best-of-N parallel candidates with judge arbitration                  |
| **Deep Research**     | Adversarial jury-validated multi-source reports                       |
| **Checkpoint System** | Multi-hour session persistence via structured snapshots               |
| **Workflow Sandbox**  | Deterministic QuickJS-based multi-agent orchestration                 |
| **Dream & Distill**   | Self-improving knowledge + automatic skill extraction                 |

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

- **Repository**: https://github.com/sdeonvacation/opencode-x
- **Full Guide**: [OPENCODE-X_GUIDE.md](./OPENCODE-X_GUIDE.md)
- **Upstream**: https://github.com/anomalyco/opencode
- **Docs**: https://opencode.ai/docs

---

## License

MIT — See [LICENSE](./LICENSE).
