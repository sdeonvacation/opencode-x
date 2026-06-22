# OpenCode-X User Guide

AI-powered coding assistant in your terminal. Multi-agent, multi-provider, extensible. Natively compatible with Claude Code (agents, skills, hooks, and plugins work out of the box). Brings you the best of opencode and claude code.

## Quick Start

```bash
# Run opencode-x
opencode-x

# Run in a named git worktree (isolated branch)
opencode-x --worktree my-feature

# Skip all permission prompts
OPENCODE_PERMISSION='{"*":"allow"}' opencode-x

# Non-interactive mode (CI/scripts)
opencode-x run "Build the project"
opencode-x run --dangerously-skip-permissions "Run tests"
```

---

## Agents

Switch between primary agents with **Tab**. Mention subagents with `@name`.

| Agent       | Type     | Purpose                            |
| ----------- | -------- | ---------------------------------- |
| **build**   | Primary  | Full tool access for coding        |
| **plan**    | Primary  | Read-only analysis and planning    |
| **general** | Subagent | Complex research, multi-step tasks |
| **explore** | Subagent | Fast read-only codebase search     |

### Custom Agents

Create `~/.config/opencode/agents/build.md`:

```markdown
---
description: Custom build agent
mode: primary
model: anthropic/claude-sonnet-4-20250514
temperature: 0.2
permission:
  bash:
    "*": ask
    "npm *": allow
---

Your custom instructions here.
```

Or configure in `opencode.json`:

```json
{
  "agent": {
    "build": {
      "model": "anthropic/claude-sonnet-4-20250514",
      "prompt": "{file:./prompts/build.txt}",
      "temperature": 0.3
    }
  }
}
```

> **Note**: Custom prompts completely replace default prompts.

---

## Claude Code Compatibility

OpenCode-X natively loads and runs Claude Code artifacts. No migration needed.

| Source                                     | What it provides                         |
| ------------------------------------------ | ---------------------------------------- |
| `~/.claude/agents/*.md`                    | Agent definitions (auto-discovered)      |
| `~/.claude/skills/**/SKILL.md`             | Skills (auto-discovered)                 |
| `~/.claude/settings.json` → `hooks`        | Event hooks (auto-loaded)                |
| `~/.claude/hooks/commands.json`            | Custom slash commands                    |
| `~/.claude/plugins/installed_plugins.json` | Plugin skills + agents (auto-discovered) |
| `~/.agents/agents/*.md`                    | Agent definitions (auto-discovered)      |
| `~/.agents/skills/**/SKILL.md`             | Skills (auto-discovered)                 |
| `CLAUDE.md` / `CONTEXT.md`                 | Project instructions (auto-loaded)       |

Disable with: `OPENCODE_DISABLE_CLAUDE_CODE=1`
Disable external agents only: `OPENCODE_DISABLE_EXTERNAL_AGENTS=1`
Disable external skills only: `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`

---

## Slash Commands

| Command          | Description                                     |
| ---------------- | ----------------------------------------------- |
| `/init`          | Create/update AGENTS.md                         |
| `/review`        | Review changes (commit, branch, or PR)          |
| `/status`        | Session status, ID, compaction savings          |
| `/btw`           | Inject context without starting a new turn      |
| `/clear`         | Clear messages in current session               |
| `/clear-compact` | Clear messages and summarize history            |
| `/goal`          | Set autonomous goal (agent works without input) |
| `/dream`         | Trigger knowledge consolidation                 |
| `/distill`       | Trigger workflow extraction into skills         |
| `/memory_add`    | Add session memory entry                        |
| `/memory_edit`   | Edit existing session memory                    |
| `/memory_delete` | Remove session memory entry                     |
| `/worktree`      | Manage git worktrees (list, remove)             |
| `/swarm`         | Batch-parallel subagent dispatch                |
| `/workflow`      | Run a QuickJS sandboxed workflow script         |

### Custom Commands

Create `.opencode/commands/test.md`:

```markdown
---
description: Run tests
subtask: true
---

Run full test suite. Focus on failures and suggest fixes.
```

Supports `$ARGUMENTS`, `$1`/`$2` positional args, shell output via `` !`git log -5` ``, and file refs via `@src/file.ts`.

---

## Skills

Specialized instruction sets that auto-load when the agent recognizes a matching task.

### Locations

| Path                           | Scope              |
| ------------------------------ | ------------------ |
| `.opencode/skills/*/SKILL.md`  | Project            |
| `~/.config/opencode/skills/*/` | Global             |
| `~/.claude/skills/*/`          | Claude Code compat |
| `~/.agents/skills/*/`          | External           |

Configure additional paths/URLs:

```json
{
  "skills": {
    "paths": ["/path/to/custom/skills"],
    "urls": ["https://example.com/skill.md"]
  }
}
```

Invoke manually: `/skill-name` in chat.

### Creating a Skill

```
skills/my-skill/
├── SKILL.md          # Required - instructions + trigger keywords
├── references/       # Optional - bundled docs
└── scripts/          # Optional - helper scripts
```

---

## Models & Providers

### Format

`provider/model-id` — e.g. `anthropic/claude-sonnet-4-20250514`

### Configuration

```json
{
  "model": "anthropic/claude-sonnet-4-20250514",
  "agent": {
    "build": { "model": "openai/gpt-4" }
  },
  "provider": {
    "anthropic": {
      "options": { "baseURL": "https://api.anthropic.com/v1" }
    }
  }
}
```

75+ models via AI SDK: Anthropic, OpenAI, Google, AWS Bedrock, Azure, OpenCode Zen/Go, etc.

### OpenCode Go

Subscription service for curated open-source coding models (GLM-5, Kimi K2.5, MiniMax M2.7/M2.5).

```json
{ "model": "opencode-go/kimi-k2.5" }
```

---

## MCP Servers

External tool servers connected via Model Context Protocol. Must be configured explicitly in `opencode.json` (Claude Code MCP configs in `~/.claude/settings.json` are NOT auto-imported).

### Local (stdio)

```jsonc
{
  "mcp": {
    "my-server": {
      "type": "local",
      "command": ["node", "/path/to/server.js"],
      "environment": { "API_KEY": "secret" },
      "timeout": 10000,
    },
  },
}
```

### Remote (HTTP/SSE)

```jsonc
{
  "mcp": {
    "my-remote": {
      "type": "remote",
      "url": "https://mcp-server.example.com/mcp",
      "headers": { "Authorization": "Bearer {env:MY_TOKEN}" },
    },
  },
}
```

Supports OAuth (auto-registration or pre-registered credentials). Restart opencode after config changes.

---

## Configuration

### File Locations

| Location                           | Purpose              |
| ---------------------------------- | -------------------- |
| `~/.config/opencode/opencode.json` | Global config        |
| `.opencode/opencode.json`          | Project overrides    |
| `AGENTS.md` (project root)         | Project instructions |
| `~/.config/opencode/AGENTS.md`     | Global instructions  |

Also loads: `CLAUDE.md`, `CONTEXT.md` (same priority as `AGENTS.md`).

### Directory Structure

```
~/.config/opencode/
├── opencode.json       # Main config
├── agents/             # Custom agent definitions
├── commands/           # Custom slash commands
├── skills/             # Global skills
├── hooks.json          # Event hooks (optional)
└── plugins/            # TypeScript plugins

project-root/
├── .opencode/
│   ├── opencode.json   # Project config overrides
│   ├── agents/
│   ├── commands/
│   └── skills/
└── AGENTS.md           # Project instructions
```

### Key Config Fields

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-20250514",
  "default_agent": "build",
  "instructions": ["docs/guidelines.md", "~/my-rules.md"],
  "permission": { "bash": { "*": "ask", "git *": "allow" } },
  "agent": {},
  "command": {},
  "provider": {},
  "mcp": {},
  "compaction": { "auto": true, "prune": true },
  "experimental": {}
}
```

### Permissions

Values: `"allow"` | `"ask"` | `"deny"`. Glob patterns supported.

```json
{
  "permission": {
    "read": { "*": "allow", "*.env": "deny" },
    "edit": { "*": "allow", "*.lock": "deny" },
    "bash": { "*": "ask", "git *": "allow", "npm test": "allow" }
  }
}
```

Override all permissions:

```bash
# Universal (TUI + CLI)
OPENCODE_PERMISSION='{"*":"allow"}' opencode-x

# CLI only
opencode-x run --dangerously-skip-permissions "your prompt"
```

### Compaction (Context Management)

```json
{
  "compaction": {
    "auto": true,
    "prune": true,
    "reserved": 20000
  }
}
```

### Hybrid Routing

Route lightweight tasks to a cheap/fast model automatically:

```json
{
  "hybrid": {
    "enabled": true,
    "cheap_model": { "providerID": "anthropic", "modelID": "claude-haiku-4-5" }
  }
}
```

Large tool outputs are pre-processed by the cheap model before reaching the primary model.

### Stream Idle Timeout

Controls how long to wait for SSE data before retrying a stalled LLM stream:

```json
{ "stream_idle_timeout": 60000 }
```

Per-provider override: `"provider": { "anthropic": { "options": { "chunkTimeout": 90000 } } }`

---

## Features Enabled by Default

These work out of the box, no configuration needed. Set to `false` in `experimental` to disable.

| Feature                | What it does                                            |
| ---------------------- | ------------------------------------------------------- |
| Goal system            | `/goal` for autonomous multi-turn execution             |
| Persistent memory      | Cross-session memory via `memory_persist` tool          |
| Swarm mode             | Batch-parallel subagent dispatch                        |
| Workflow engine        | QuickJS sandboxed multi-agent pipelines                 |
| Hooks                  | Claude Code compatible event hooks                      |
| Worktree isolation     | Git worktree isolation for parallel subagents           |
| MicroCompact           | Summarize older messages at 75% context usage           |
| Context collapse       | Emergency context reset at 97% usage                    |
| Prompt split caching   | Cache-friendly system prompt split for provider caching |
| Multi-step tool chains | Safe multi-step SDK tool execution                      |
| Dream & Distill        | Auto-consolidate knowledge (dream: 7d, distill: 30d)    |

---

## Optional Experimental Features

Enable individually in config, or enable all with `OPENCODE_EXPERIMENTAL=1`:

```json
{
  "experimental": {
    "parallel_tool_calls": true,
    "continue_loop_on_deny": true,
    "deep_research": true,
    "tool_result_budget": 50000,
    "wire_diagnostics": true,
    "ultrawork_model": { "providerID": "anthropic", "modelID": "claude-sonnet-4-6" },
    "task_categories": { "review": { "providerID": "anthropic", "modelID": "claude-sonnet-4-6" } }
  }
}
```

| Feature                 | Description                                                    |
| ----------------------- | -------------------------------------------------------------- |
| `parallel_tool_calls`   | Allow safe parallel tool execution                             |
| `continue_loop_on_deny` | Agent continues after permission denial (Tab to give feedback) |
| `deep_research`         | Enable `/research` command and deep research workflow          |
| `tool_result_budget`    | Character budget for tool results in history                   |
| `wire_diagnostics`      | Per-request LLM profiling (JSONL logs)                         |
| `ultrawork_model`       | High-reasoning model for complex delegated tasks               |
| `task_categories`       | Route task categories to specific provider/model combos        |
| `model_concurrency`     | Per-model concurrency limits (default: 5)                      |

---

## Memory

### Session Memory

Per-session, survives `/clear` and `/clear-compact`. Managed via `/memory_add`, `/memory_edit`, `/memory_delete`. Injected into system prompt for current session only.

### Persistent Memory

Cross-session, survives restarts. Agent saves automatically via `memory_persist` tool. Stored as markdown in `~/.local/share/opencode/memory/`. Injected into every session's system prompt.

Types: `user` (preferences), `project` (codebase facts), `feedback` (corrections from mistakes).

### Dream & Distill

Background self-improvement that fires automatically:

- **Dream** (every 7 days): Reviews recent sessions, writes project facts to persistent memory
- **Distill** (every 30 days): Identifies repeated workflows, creates skill files

Disable with: `OPENCODE_EXPERIMENTAL_DREAM=false`

---

## Goal System

Autonomous multi-turn execution toward a defined objective.

```
/goal Implement auth middleware with passing tests
```

Agent works continuously, receiving auto-continuation between turns. Calls `goal_complete` with evidence when done. Guards: max 200 turns, pauses on budget limits.

---

## Workflow Engine

QuickJS-sandboxed scripts that orchestrate multi-agent pipelines with deterministic replay.

```
/workflow my-pipeline
```

Workflows spawn agent sessions, pass arguments, and run with configurable concurrency and timeouts.

---

## Worktrees

### CLI Flag

Launch opencode in an isolated git worktree:

```bash
opencode-x --worktree feature-branch      # Create/reuse named worktree
opencode-x --worktree feature --ephemeral  # Auto-cleanup on exit, patch back
```

### Slash Command

`/worktree` (alias `/wt`) — create, list, remove, or switch worktrees interactively.

### Subagent Isolation

Agents can use `isolation: true` on task calls. Each subagent gets a private worktree, changes are patched back to parent on completion.

---

## Push to Background

Detach a running session: **Leader+D**

Session continues executing in background. TUI immediately unblocks. Toast notification fires on completion.

---

## Hooks

Event hooks run shell commands on lifecycle events. Your existing `~/.claude/settings.json` hooks work automatically.

Add opencode-specific hooks in `~/.config/opencode/hooks.json`:

```json
{
  "PreToolUse": [{ "matcher": "Bash", "command": "/path/to/hook.sh", "timeout": 10 }],
  "UserPromptSubmit": [{ "command": "my-validator.sh", "timeout": 5 }]
}
```

| Event              | Blocking | Description                     |
| ------------------ | -------- | ------------------------------- |
| `PreToolUse`       | Yes      | Before tool execution; can deny |
| `PostToolUse`      | No       | After successful tool execution |
| `UserPromptSubmit` | Yes      | Before prompt is processed      |
| `SessionStart`     | No       | When session starts             |
| `Stop`             | No       | On session end                  |
| `SubagentStart`    | No       | When subagent spawns            |
| `SubagentStop`     | No       | When subagent completes         |

Blocking hooks: non-zero exit = deny (stderr used as reason).

---

## Plugins

TypeScript extensions for deeper integration. Two types:

- **Server** — events, system prompt injection
- **TUI** — custom commands, dialogs, UI extensions

Register in `opencode.json`:

```json
{ "plugin": ["~/.config/opencode/plugins/my-plugin.ts"] }
```

TUI plugins in `~/.config/opencode/tui.json`:

```json
{ "plugin": ["plugins/my-tui.ts"] }
```

---

## TUI Keybindings

| Key      | Action                     |
| -------- | -------------------------- |
| Tab      | Switch primary agent       |
| `@name`  | Mention subagent           |
| Leader+d | Push session to background |
| Leader+b | Toggle sidebar             |
| Leader+v | Paste image                |
| Leader+↓ | Enter child session        |
| ←/→      | Navigate sibling sessions  |
| ↑        | Return to parent session   |

---

## Environment Variables

| Variable                           | Description                          |
| ---------------------------------- | ------------------------------------ |
| `OPENCODE_PERMISSION`              | JSON permission override             |
| `OPENCODE_CONFIG`                  | Config file path                     |
| `OPENCODE_CONFIG_DIR`              | Config directory                     |
| `OPENCODE_DB`                      | Database location                    |
| `OPENCODE_EXPERIMENTAL`            | Enable all experimental features     |
| `OPENCODE_DISABLE_AUTOUPDATE`      | Disable auto-updates (CI)            |
| `OPENCODE_DISABLE_AUTOCOMPACT`     | Disable auto-compaction              |
| `OPENCODE_DISABLE_EXTERNAL_SKILLS` | Disable external skill directories   |
| `OPENCODE_DISABLE_EXTERNAL_AGENTS` | Disable external agent directories   |
| `OPENCODE_DISABLE_CLAUDE_CODE`     | Disable all Claude Code compat       |
| `OPENCODE_DISABLE_DEFAULT_PLUGINS` | Disable default plugins              |
| `OPENCODE_EXPERIMENTAL_DREAM`      | Set `false` to disable dream/distill |

---

## AGENTS.md

Project instruction file loaded automatically. Include:

1. **Build/test commands** — what to run after changes
2. **Code style** — naming, imports, patterns
3. **Architecture** — directory structure, key modules
4. **Rules** — what to never modify, required workflows

Subdirectory `AGENTS.md` files auto-load when reading files in that directory.

---

## Resources

- **Repository**: https://github.com/sdeonvacation/opencode-x
- **Opencode Docs**: https://opencode.ai/docs
