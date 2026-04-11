# OpenCode User Guide

Guide based on OpenCode codebase analysis.

## Table of Contents

1. [Agents](#agents)
2. [Subagent Invocation](#subagent-invocation)
3. [Commands](#commands)
4. [Skills](#skills)
5. [Models & Providers](#models--providers)
6. [OpenCode Go](#opencode-go)
7. [TodoWrite](#todowrite)
8. [Best Practices](#best-practices)
9. [Configuration](#configuration)
10. [Environment Variables](#environment-variables)
11. [MCP Servers](#mcp-servers)
12. [Running local build of opencode] (#running-local-opencode)

---

## Agents

### Types

- **Primary**: Main assistants (switch with Tab)
- **Subagents**: Specialized helpers (via `@mention` or Task tool)

### Built-in Agents

| Agent          | Type     | Description                         |
| -------------- | -------- | ----------------------------------- |
| **build**      | Primary  | Full tool access for development    |
| **plan**       | Primary  | Read-only for analysis/planning     |
| **general**    | Subagent | Complex research, multi-step tasks  |
| **explore**    | Subagent | Fast read-only codebase exploration |
| **compaction** | Hidden   | System agent for context compaction |
| **title**      | Hidden   | Generates session titles            |
| **summary**    | Hidden   | Creates session summaries           |

### Default Prompts

**Build agent:**

- Ultra-concise: <4 lines of text
- No comments unless asked
- No summaries/preamble/postamble
- Never commit unless explicitly asked
- Run lint/typecheck after completing tasks

**Plan agent:**

- Read-only (no edits except plan files)
- Analyze, search, delegate explore agents
- Question tool and Plan Exit tool allowed

### Creating Custom Agents

**Method 1: Markdown**

```markdown
## <!-- ~/.config/opencode/agents/build.md -->

description: Custom build agent
mode: primary
model: anthropic/claude-sonnet-4-20250514
temperature: 0.2
permission:
bash:
"_": ask
"npm _": allow

---

Your custom instructions here.
```

**Method 2: JSON**

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

### Configuration Options

| Option        | Type                                   | Description                             |
| ------------- | -------------------------------------- | --------------------------------------- |
| `description` | string                                 | Brief description (required)            |
| `mode`        | `"primary"` \| `"subagent"` \| `"all"` | Agent type                              |
| `model`       | string                                 | Model ID (`provider/model-id`)          |
| `prompt`      | string                                 | Custom system prompt or `{file:./path}` |
| `temperature` | number                                 | 0.0-1.0 randomness control              |
| `permission`  | object                                 | Tool permissions                        |
| `hidden`      | boolean                                | Hide from autocomplete                  |
| `disable`     | boolean                                | Disable agent                           |

### Permissions

```json
{
  "permission": {
    "edit": "ask",
    "bash": {
      "*": "ask",
      "git status": "allow",
      "npm test": "allow"
    },
    "task": {
      "*": "allow",
      "expensive-*": "ask"
    }
  }
}
```

Values: `"allow"` | `"ask"` | `"deny"`

#### Override all permissions to allow

```bash
# Works everywhere (TUI + CLI)
OPENCODE_PERMISSION='{"*":"allow"}' opencode

# CLI only (opencode run, not TUI)
opencode run --dangerously-skip-permissions "your prompt"
```

**Important:** Custom prompts completely replace default prompts.

---

## Subagent Invocation

### Methods

#### 1. LLM Auto-Invocation

LLM sees subagents in Task tool description and invokes automatically:

```typescript
Task((subagent_type = "explore"), (description = "Find API endpoints"), (prompt = "..."))
```

#### 2. User @mention (TUI only)

```
@explore Find all API endpoints
```

System converts to Task tool call with `bypassAgentCheck: true`.

#### 3. Command-Based

```json
{
  "command": {
    "test": {
      "agent": "tester",
      "subtask": true,
      "template": "Run tests..."
    }
  }
}
```

### Task Tool Parameters

```typescript
{
  description: string  // Short 3-5 word description
  prompt: string       // Detailed instructions
  subagent_type: string  // Which subagent
  task_category?: string  // Optional model-routing category hint
  use_ultrawork?: boolean  // Explicit high-reasoning model override
  task_id?: string  // Resume existing session
}
```

### Orchestration Guardrails

Recent orchestration features added to subagent task execution:

- **Loop detection**
  - Detects repeated identical `task` calls within a session
  - Config: `experimental.loop_detector_threshold` (default `5`)
- **Spawn guardrails**
  - Limits subagent nesting depth and descendant count
  - Config:
    - `experimental.max_subagent_depth` (default `3`)
    - `experimental.max_subagent_descendants` (default `50`)
- **Concurrency limiting**
  - Limits concurrent subagent runs per model key
  - Config: `experimental.model_concurrency`
- **Category routing**
  - `task_category` can route a task to a configured provider/model
  - Config: `experimental.task_categories`
- **Ultrawork routing**
  - Uses a configured high-reasoning model for delegated tasks
  - Triggered by `ulw` / `ultrawork` in the task prompt or `use_ultrawork: true`
  - Config: `experimental.ultrawork_model`

### Task Examples

```typescript
// Route a delegated task by category
Task(
  (subagent_type = "general"),
  (description = "Review auth flow"),
  (prompt = "Check auth/session edge cases"),
  (task_category = "review"),
)

// Force ultrawork model for a delegated task
Task(
  (subagent_type = "explore"),
  (description = "Deep investigation"),
  (prompt = "Do ultrawork on retry behavior and error paths"),
  (use_ultrawork = true),
)
```

### Session Management

Child sessions linked to parent:

- `<leader>down`: Enter first child
- `right`: Next child
- `left`: Previous child
- `up`: Return to parent

### Restrictions

Subagents have:

- `todowrite: deny` (always)
- `task: deny` (default, unless explicitly allowed)

### Parallel Execution

Include multiple Task calls in ONE response for parallel execution:

```typescript
Task((subagent_type = "explore"), (description = "Find auth"), (prompt = "..."))
Task((subagent_type = "explore"), (description = "Find API"), (prompt = "..."))
Task((subagent_type = "explore"), (description = "Find models"), (prompt = "..."))
```

### Forcing Delegation

**Agent prompt strategy:**

```markdown
## DELEGATION RULES

### Testing - ALWAYS delegate to tester

**MANDATORY**: For testing requests, use Task tool with subagent_type: "tester".

Triggers: "test", "run tests", "verify", "npm test"

Task(subagent_type="tester", description="Run tests", prompt="...")
```

**Subagent description strategy:**

```markdown
---
description: MANDATORY for ALL testing - run tests, verify code, npm test, pytest, jest. ALWAYS use for testing.
---
```

**Command strategy:**

```markdown
---
agent: tester
subtask: true
---
```

---

## Commands

### Built-in

- `/init` - Create/update AGENTS.md
- `/review` - Review changes

### Creating Commands

**Markdown:**

```markdown
## <!-- .opencode/commands/test.md -->

description: Run tests
subtask: true

---

Run full test suite. Focus on failures and suggest fixes.
```

**JSON:**

```json
{
  "command": {
    "test": {
      "description": "Run tests",
      "template": "Run tests and analyze failures.",
      "subtask": true
    }
  }
}
```

### Features

**Arguments:**

- `$ARGUMENTS` - all arguments
- `$1`, `$2`, `$3` - positional

**Shell output:**

```markdown
!`git log --oneline -10`
```

**File references:**

```markdown
Review @src/components/Button.tsx
```

### Options

| Option        | Description               |
| ------------- | ------------------------- |
| `template`    | Prompt sent to LLM        |
| `description` | Brief description         |
| `agent`       | Which agent runs command  |
| `model`       | Override model            |
| `subtask`     | Force subagent invocation |

### Loading Priority

1. Built-in
2. JSON config
3. Markdown files
4. MCP prompts
5. Skills (if name not taken)

---

## Skills

### What Are Skills

Specialized instruction sets with domain-specific workflows. Auto-loaded when LLM recognizes matching task.

### Locations

- OpenCode: `{skill,skills}/**/SKILL.md` (global and project `.opencode/`)
- External: `~/.claude/skills/**/SKILL.md`, `~/.agents/skills/**/SKILL.md`
- Custom: Set `skills.paths` in config
- Remote: Set `skills.urls` in config

### Structure

```
skills/
└── my-skill/
    ├── SKILL.md          # Required
    ├── references/       # Optional
    ├── scripts/          # Optional
    └── templates/        # Optional
```

### SKILL.md Format

```markdown
---
name: my-skill
description: Clear trigger condition - when to use
references:
  - api-guide
---

# Skill Name

## Goal

Clear objective

## When to Use

- Trigger condition 1
- Keyword: "special phrase"

## Process

1. First step
2. Second step

## Rules

- Constraint 1
- What to avoid

## Examples

[Concrete examples]

## References

See `references/api-guide.md`
```

### Invocation Methods

| Method            | Syntax        | Example                                          |
| ----------------- | ------------- | ------------------------------------------------ |
| User command      | `/skill-name` | `/cloudflare`                                    |
| LLM auto-invoke   | Skill tool    | `Skill(name="cloudflare")`                       |
| Description match | Automatic     | User asks about Workers → loads cloudflare skill |

### Writing Descriptions

**Good:**

```markdown
---
description: Cloudflare Workers, Pages, KV, D1, R2. Use for any Cloudflare development.
---
```

**Forced loading in agent:**

```markdown
## SKILL RULES

### Cloudflare Development

**MANDATORY**: When user mentions Cloudflare:

1. Use Skill tool: `Skill(name="cloudflare")`
2. Follow loaded skill instructions
```

### Permissions

```json
{
  "permission": {
    "skill": {
      "*": "allow",
      "dangerous-skill": "ask"
    }
  }
}
```

---

## AGENTS.md

### File Locations

OpenCode loads instruction files:

1. Root: First `AGENTS.md`, `CLAUDE.md`, or `CONTEXT.md` in project root
2. Global: `~/.config/opencode/AGENTS.md` or `~/.claude/CLAUDE.md`
3. Subdirectories: Auto-loaded when reading files in that directory

### What to Include

#### 1. Build/Lint/Test Commands (Critical)

````markdown
## Commands

```bash
npm install
npm run dev
npm run typecheck  # MUST run after changes
npm run lint       # MUST run after changes
npm test
npm test -- path/to/test.ts  # Single file
```
````

````

#### 2. Code Style
```markdown
## Code Style

### Naming
- camelCase: variables, functions
- PascalCase: types, classes
- UPPER_SNAKE: constants

### Imports
// 1. External
import { z } from "zod"
// 2. Internal
import { db } from "@/db"
// 3. Relative
import { helper } from "./utils"
````

#### 3. Architecture Context

```markdown
## Architecture

- `src/api/` - REST endpoints
- `src/services/` - Business logic
- `src/models/` - Database models
```

#### 4. Project Rules

```markdown
## Rules

- NEVER modify `generated/` files
- Run `npm run generate` after GraphQL schema changes
- Database migrations require review
```

### Subdirectory AGENTS.md

```markdown
<!-- packages/api/AGENTS.md -->

# API Package

## Testing

npm test --workspace=packages/api

## Conventions

- All endpoints return `{ data, error, meta }`
- Use Zod for validation
```

### Custom Instructions

```json
{
  "instructions": ["lessons.md", "docs/guidelines.md", "~/my-global-rules.md", "https://example.com/rules.md"]
}
```

---

## Models & Providers

### Format

`provider/model-id`

**Examples:**

```json
{
  "model": "anthropic/claude-sonnet-4-20250514",
  "agent": {
    "build": {
      "model": "openai/gpt-4"
    }
  }
}
```

### Supported Providers

75+ via AI SDK: Anthropic, OpenAI, Google, AWS Bedrock, Azure, OpenCode Zen, OpenCode Go, etc.

### Configuration

```bash
export AWS_ACCESS_KEY_ID=xxx
export AWS_REGION=us-east-1
```

```json
{
  "provider": {
    "anthropic": {
      "options": {
        "baseURL": "https://api.anthropic.com/v1"
      }
    }
  }
}
```

---

## OpenCode Go

Subscription service for curated open-source coding models.

**Models:** GLM-5, Kimi K2.5, MiniMax M2.7, MiniMax M2.5
**Regions:** US, EU, Singapore

### Usage

```json
{
  "model": "opencode-go/kimi-k2.5",
  "agent": {
    "build": {
      "model": "opencode-go/minimax-m2.7"
    }
  }
}
```

### API Endpoints

| Model              | Endpoint            | Auth                    | SDK                         |
| ------------------ | ------------------- | ----------------------- | --------------------------- |
| GLM-5, Kimi K2.5   | `/chat/completions` | `Authorization: Bearer` | `@ai-sdk/openai-compatible` |
| MiniMax M2.7, M2.5 | `/messages`         | `x-api-key`             | `@ai-sdk/anthropic`         |

**Base URLs:**

- OpenAI: `https://opencode.ai/zen/go/v1/chat/completions`
- Anthropic: `https://opencode.ai/zen/go/v1/messages`

---

## TodoWrite

Native task management tool.

### Schema

```typescript
TodoWrite({
  todos: [
    {
      content: string, // Task description
      status: "pending" | "in_progress" | "completed" | "cancelled",
      priority: "high" | "medium" | "low",
    },
  ],
})
```

### When to Use

- Complex multi-step tasks (3+ steps)
- User provides multiple tasks
- Non-trivial features requiring planning

### Process

```typescript
// 1. Create list
TodoWrite({
  todos: [
    { content: "Analyze code", status: "pending", priority: "high" },
    { content: "Implement feature", status: "pending", priority: "high" },
    { content: "Write tests", status: "pending", priority: "high" },
  ],
})

// 2. Mark in_progress BEFORE starting
TodoWrite({
  todos: [
    { content: "Analyze code", status: "in_progress", priority: "high" },
    // ...rest unchanged
  ],
})

// 3. Mark completed IMMEDIATELY after finishing
TodoWrite({
  todos: [
    { content: "Analyze code", status: "completed", priority: "high" },
    { content: "Implement feature", status: "in_progress", priority: "high" },
    // ...
  ],
})
```

### Restrictions

Subagents have `todowrite: deny` by default. Only primary agents manage task lists.

### Best Practices

1. Create list early
2. Be specific
3. Update immediately
4. Only one `in_progress` at a time
5. Add new tasks discovered during work
6. Cancel obsolete tasks

---

## Best Practices

### Agent Design

1. Override default prompts carefully (lose all defaults)
2. Use clear descriptions for auto-triggering
3. Set appropriate permissions
4. Hide internal subagents with `hidden: true`

### Command Design

1. Use `subtask: true` for subagent commands
2. Leverage shell output (`!`backticks`)
3. Use positional args (`$1`, `$2`)
4. Keep focused - one task per command

### Skill Design

1. Write keyword-rich descriptions
2. Include multiple trigger conditions
3. Structure clearly: Goal, Process, Rules, Examples
4. Bundle reference docs in skill directory
5. Test triggering with keywords

### Configuration Organization

**Global** (`~/.config/opencode/opencode.json`):

- Default models
- Global agents
- Reusable commands
- Provider settings

**Project** (`.opencode/opencode.json`):

- Project-specific overrides
- Project commands
- Model overrides

### Model Selection

**Cheap:**

- MiniMax M2.5: Best cost-efficiency (~100k requests/month)
- Simple commands, formatting, docs, simple refactoring

**Premium:**

- GLM-5: Best performance (~6k requests/month)
- Complex architecture, security reviews, critical bugs, planning

---

## Configuration

### Directory Structure

```
~/.config/opencode/
├── opencode.json
├── agents/
├── commands/
└── skills/

project-root/
├── opencode.json
├── .opencode/
│   ├── opencode.json
│   ├── agents/
│   ├── commands/
│   └── skills/
└── AGENTS.md
```

### Key Options

| Field           | Description                  |
| --------------- | ---------------------------- |
| `model`         | Default model                |
| `default_agent` | Default primary agent        |
| `instructions`  | Additional instruction files |
| `permission`    | Global permissions           |
| `agent`         | Agent configs                |
| `command`       | Custom commands              |
| `skills`        | Skill paths/URLs             |
| `provider`      | Provider configs             |
| `mcp`           | MCP server configs           |
| `compaction`    | Compaction settings          |
| `experimental`  | Experimental features        |

### Permission Configuration

```json
{
  "permission": {
    "read": {
      "*": "allow",
      "*.env": "deny",
      ".secrets/*": "deny"
    },
    "edit": {
      "*": "allow",
      "*.lock": "deny"
    },
    "bash": {
      "*": "ask",
      "git *": "allow"
    }
  }
}
```

### Compaction

```json
{
  "compaction": {
    "auto": true,
    "prune": true,
    "reserved": 20000
  }
}
```

- `auto`: Automatically compact when approaching limit
- `prune`: Remove old tool outputs
- `reserved`: Token buffer for compaction overhead

### Experimental Features

```json
{
  "experimental": {
    "batch_tool": false,
    "continue_loop_on_deny": false,
    "primary_tools": [],
    "mcp_timeout": 30000,
    "loop_detector_threshold": 5,
    "max_subagent_depth": 3,
    "max_subagent_descendants": 50,
    "model_concurrency": {
      "openai:gpt-5.4": 2
    },
    "task_categories": {
      "review": {
        "providerID": "anthropic",
        "modelID": "claude-sonnet-4-5"
      }
    },
    "ultrawork_model": {
      "providerID": "anthropic",
      "modelID": "claude-sonnet-4-5"
    }
  }
}
```

**continue_loop_on_deny:**

- Default: rejection stops agent loop
- Enabled: agent receives feedback and continues
- Flow: Deny → Tab → Type feedback → Enter → Agent adapts

**loop_detector_threshold:**

- Consecutive identical delegated task calls before loop protection aborts
- Default: `5`

**max_subagent_depth / max_subagent_descendants:**

- Limit runaway subagent recursion and excessive child-session fanout
- Defaults: `3` depth, `50` descendants

**model_concurrency:**

- Optional map of concurrency limits per key
- Typical task key: `providerID:modelID`
- Batch tool also uses per-tool keys like `batch:read`, `batch:bash`

**task_categories:**

- Optional map from a `task_category` hint to a provider/model override
- Useful for routing categories like `review`, `research`, or `debug`

**ultrawork_model:**

- High-reasoning model override for delegated tasks
- Activates when a task prompt contains `ulw` / `ultrawork`, or when `use_ultrawork: true` is set on the task call
- No effect if this model is not configured

---

## Environment Variables

### Skill and Feature Control

| Variable                           | Default | Description                                      |
| ---------------------------------- | ------- | ------------------------------------------------ |
| `OPENCODE_DISABLE_EXTERNAL_SKILLS` | `false` | Disable `~/.claude/skills/`, `~/.agents/skills/` |
| `OPENCODE_DISABLE_CLAUDE_CODE`     | `false` | Disable all Claude Code compatibility            |
| `OPENCODE_DISABLE_DEFAULT_PLUGINS` | `false` | Disable default plugins                          |

### Configuration and Paths

| Variable                          | Default                            | Description            |
| --------------------------------- | ---------------------------------- | ---------------------- |
| `OPENCODE_CONFIG`                 | `~/.config/opencode/opencode.json` | Config file location   |
| `OPENCODE_CONFIG_DIR`             | `~/.config/opencode/`              | Config directory       |
| `OPENCODE_DISABLE_PROJECT_CONFIG` | `false`                            | Ignore project configs |

### Performance

| Variable                       | Default | Description                   |
| ------------------------------ | ------- | ----------------------------- |
| `OPENCODE_DISABLE_PRUNE`       | `false` | Disable pruning in compaction |
| `OPENCODE_DISABLE_AUTOCOMPACT` | `false` | Disable auto-compaction       |

### Developer

| Variable                           | Default                           | Description                          |
| ---------------------------------- | --------------------------------- | ------------------------------------ |
| `OPENCODE_EXPERIMENTAL`            | `false`                           | Enable all experimental features     |
| `OPENCODE_EXPERIMENTAL_WORKSPACES` | `false`                           | Event sourcing for multi-client sync |
| `OPENCODE_ENABLE_QUESTION_TOOL`    | Enabled for `cli`/`app`/`desktop` | Enable question tool                 |

**OPENCODE_ENABLE_QUESTION_TOOL:**

- Auto-enabled for interactive clients
- Only set manually for `acp` or to disable on interactive clients

### Database

| Variable      | Default                             | Description       |
| ------------- | ----------------------------------- | ----------------- |
| `OPENCODE_DB` | `~/.local/share/opencode/db.sqlite` | Database location |

### Common Use Cases

```bash
# Override all permissions to allow (universal)
OPENCODE_PERMISSION='{"*":"allow"}' opencode

# Disable external skills
export OPENCODE_DISABLE_EXTERNAL_SKILLS=1

# Custom config
OPENCODE_CONFIG=~/my-config.json opencode

# Enable all experimental
export OPENCODE_EXPERIMENTAL=1

# Disable auto-updates in CI
OPENCODE_DISABLE_AUTOUPDATE=1 opencode run "Build"
```

---

## Resources

- **Repository**: https://github.com/anomalyco/opencode
- **Documentation**: https://opencode.ai/docs
- **Console**: https://opencode.ai/zen
- **Discord**: https://opencode.ai/discord

## MCP Servers

MCP (Model Context Protocol) servers expose tools that opencode agents can call during a session. Two transport types are supported: **local** (subprocess via stdio) and **remote** (HTTP/SSE).

### Config file location

MCP servers are registered under the `"mcp"` key in the opencode config file:

| Platform | Default path                                                 |
| -------- | ------------------------------------------------------------ |
| macOS    | `~/Library/Preferences/opencode/opencode.json` (or `.jsonc`) |
| Linux    | `~/.config/opencode/opencode.json` (or `.jsonc`)             |
| Windows  | `%APPDATA%\opencode\opencode.json`                           |
| Override | `$OPENCODE_CONFIG_DIR/opencode.json`                         |

Project-level overrides are also read from `.opencode/opencode.json` inside any Git worktree.

### Local (stdio) server

opencode spawns the process and communicates via stdin/stdout (JSON-RPC 2.0).

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "my-server": {
      "type": "local",
      "command": ["node", "/path/to/server.js", "--arg"],
      "environment": {
        "API_KEY": "secret", // env vars passed to subprocess
      },
      "timeout": 10000, // ms; default 5000
      "enabled": true, // false to disable without removing entry
    },
  },
}
```

### Remote (HTTP/SSE) server

opencode tries `StreamableHTTPClientTransport` first, then falls back to `SSEClientTransport`.

```jsonc
{
  "mcp": {
    "my-remote": {
      "type": "remote",
      "url": "https://mcp-server.example.com/mcp",
      "headers": {
        "Authorization": "Bearer {env:MY_TOKEN}", // {env:VAR} expands at load time
      },
      "timeout": 10000,
    },
  },
}
```

#### Remote with OAuth

```jsonc
{
  "mcp": {
    // Dynamic client registration (RFC 7591) — opencode registers itself automatically
    "oauth-auto": {
      "type": "remote",
      "url": "https://example.com/mcp",
      "oauth": {},
    },
    // Pre-registered credentials
    "oauth-manual": {
      "type": "remote",
      "url": "https://example.com/mcp",
      "oauth": {
        "clientId": "your-client-id",
        "clientSecret": "your-client-secret",
        "scope": "read write",
      },
    },
    // Disable OAuth auto-detection entirely
    "no-auth": {
      "type": "remote",
      "url": "https://example.com/mcp",
      "oauth": false,
    },
  },
}
```

OAuth tokens are cached at `~/.local/share/opencode/mcp-auth.json`.

### Field reference

| Field                | Applies to | Type                    | Required | Description                         |
| -------------------- | ---------- | ----------------------- | -------- | ----------------------------------- |
| `type`               | both       | `"local"` \| `"remote"` | ✓        | Transport type                      |
| `command`            | local      | `string[]`              | ✓        | Executable + args array             |
| `url`                | remote     | `string`                | ✓        | MCP server URL                      |
| `environment`        | local      | `Record<string,string>` | –        | Env vars for subprocess             |
| `headers`            | remote     | `Record<string,string>` | –        | HTTP headers; supports `{env:VAR}`  |
| `oauth`              | remote     | `object \| false`       | –        | OAuth config or `false` to disable  |
| `oauth.clientId`     | remote     | `string`                | –        | Pre-registered client ID            |
| `oauth.clientSecret` | remote     | `string`                | –        | Client secret                       |
| `oauth.scope`        | remote     | `string`                | –        | Space-separated OAuth scopes        |
| `enabled`            | both       | `boolean`               | –        | `false` skips connection at startup |
| `timeout`            | both       | `number` (ms)           | –        | Per-server timeout (default: 5000)  |

Global timeout override: `"experimental": { "mcp_timeout": 30000 }`.

### Connection status values

| Status                      | Meaning                                             |
| --------------------------- | --------------------------------------------------- |
| `connected`                 | Fully initialized, tools available                  |
| `disabled`                  | `enabled: false` in config                          |
| `needs_auth`                | OAuth flow required                                 |
| `needs_client_registration` | OAuth server requires pre-registered `clientId`     |
| `failed`                    | Connection or tool-list error — check server stderr |

---

### mempalace example

[mempalace](https://github.com/i570749/mempalace) is a local Python MCP server providing semantic memory storage backed by ChromaDB. It exposes 19 tools across five categories.

#### Prerequisites

```bash
cd ~/mempalace
pip install -e .                          # or: uv pip install -e .
mempalace init ~/mempalace                # create the palace data directory
mempalace mine ~/mempalace --mode general # index existing data (optional)
```

If the palace is not initialized, `mempalace_status` returns:

```json
{
  "error": "No palace found",
  "hint": "Run: mempalace init <dir> && mempalace mine <dir>"
}
```

#### Config entry (macOS)

Add to `~/Library/Preferences/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mempalace": {
      "type": "local",
      "command": ["python", "-m", "mempalace.mcp_server"],
      "environment": {
        // Optional: override default ~/.mempalace/palace/
        "MEMPALACE_PALACE_PATH": "/Users/yourname/.mempalace/palace",
      },
    },
  },
}
```

**Restart opencode** after saving — MCP servers are connected at startup.

#### Available tools

| Category            | Tools                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Palace read (7)     | `mempalace_status`, `mempalace_list_wings`, `mempalace_list_rooms`, `mempalace_get_taxonomy`, `mempalace_search`, `mempalace_check_duplicate`, `mempalace_get_aaak_spec` |
| Palace write (2)    | `mempalace_add_drawer`, `mempalace_delete_drawer`                                                                                                                        |
| Knowledge graph (5) | `mempalace_kg_query`, `mempalace_kg_add`, `mempalace_kg_invalidate`, `mempalace_kg_timeline`, `mempalace_kg_stats`                                                       |
| Navigation (3)      | `mempalace_traverse`, `mempalace_find_tunnels`, `mempalace_graph_stats`                                                                                                  |
| Agent diary (2)     | `mempalace_diary_write`, `mempalace_diary_read`                                                                                                                          |

#### Verify connection

Start opencode and run:

```
> Use mempalace_status to show the palace overview
```

---

### Troubleshooting

| Symptom                            | Likely cause                               | Fix                                              |
| ---------------------------------- | ------------------------------------------ | ------------------------------------------------ |
| Status `failed`                    | Bad command, binary not on PATH            | Check `command` array; verify executable         |
| Status `needs_auth`                | OAuth required                             | Complete the OAuth flow in the TUI               |
| Status `needs_client_registration` | Auth server requires pre-registered client | Add `oauth.clientId` + `oauth.clientSecret`      |
| Server connects but no tools       | `tools/list` returned empty                | Check server logs (stderr)                       |
| Timeout errors                     | Server slow to start                       | Increase `timeout` or `experimental.mcp_timeout` |
| `{env:VAR}` not substituted        | Env var not set                            | Export the variable before launching opencode    |

---

# Running Local Opencode

- Define: opencode() {
  /path/opencode/packages/opencode/dist/opencode-darwin-arm64/bin/opencode
  } in .zshrc
- Use bun install

---

## Plugins

Plugins extend opencode via TypeScript files. Two types: **server** (main process) and **TUI** (worker process). A single file cannot export both — use separate files.

### Registration

`~/.config/opencode/opencode.json` (server):

```json
{ "plugin": ["~/.config/opencode/plugins/my-server.ts"] }
```

`~/.config/opencode/tui.json` (TUI, paths relative to `~/.config/opencode/`):

```json
{ "plugin": ["plugins/my-tui.ts"] }
```

Restart opencode after changes.

### Server Plugin

```ts
import type { Hooks, PluginInput } from "@opencode-ai/plugin"

async function server(_input: PluginInput): Promise<Hooks> {
  return {
    // Called on every server event
    event: ({ event }: any) => {
      // event.type, event.properties — NOT event.payload.type
      if (event?.type === "session.created") {
        /* event.properties.info.id, .parentID */
      }
      if (event?.type === "session.deleted") {
        /* event.properties.sessionID */
      }
    },

    // Inject system messages invisibly (not shown in TUI) before each turn
    "experimental.chat.system.transform": async (input, output) => {
      // input.sessionID — current session
      // output.system   — push strings here; each becomes a system message
      output.system.push("Your injected rule")
    },
  }
}

export default { id: "my-plugin", server }
```

### TUI Plugin

```ts
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import os from "os"

const tui: TuiPlugin = async (api) => {
  // Get current session ID
  const sid = () => {
    const r = api.route.current
    return r.name === "session" ? (r as any).params?.sessionID : undefined
  }

  api.command.register(() => [
    {
      title: "My Command",
      value: "my.command",
      category: "MyPlugin",
      slash: { name: "my_command" },
      onSelect: async () => {
        const id = sid()
        if (!id) return

        // Toast
        api.ui.toast({ variant: "success", message: "Done" })
        // variants: "success" | "info" | "error"

        // Text input dialog
        api.ui.dialog.replace(() =>
          api.ui.DialogPrompt({
            title: "Enter value",
            placeholder: "e.g. ~/.config/opencode/file.md",
            onConfirm: async (raw) => {
              api.ui.dialog.clear()
              const path = raw.trim().replace(/^~/, os.homedir())
              // use path...
            },
            onCancel: () => api.ui.dialog.clear(),
          }),
        )

        // Selection dialog
        api.ui.dialog.replace(() =>
          api.ui.DialogSelect({
            title: "Pick one",
            options: [
              { title: "Option A", value: "a", description: "Description" },
              { title: "Option B", value: "b", description: "Description" },
            ],
            onSelect: (opt) => {
              api.ui.dialog.clear()
              // opt.value
            },
          }),
        )

        // Inject a user message into the session (fire-and-forget, returns 204)
        // CRITICAL: v2 SDK uses FLAT params — sessionID at top level, NOT path: { id: ... }
        await (api.client.session.promptAsync as any)({
          sessionID: id,
          parts: [{ type: "text", text: "My injected message" }],
        })
      },
    },
  ])
}

export default { id: "my-tui-plugin", tui }
```

### State Bridge (server ↔ TUI)

Since the two processes can't share memory, use a shared JSON file:

```ts
import path from "path"
import fs from "fs/promises"
import os from "os"

const STATE = path.join(
  process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"),
  "opencode",
  "my-plugin.json",
)

async function readState() {
  try {
    return JSON.parse(await fs.readFile(STATE, "utf8"))
  } catch {
    return {
      /* defaults */
    }
  }
}

async function writeState(state: object) {
  await fs.mkdir(path.dirname(STATE), { recursive: true })
  await fs.writeFile(STATE, JSON.stringify(state), "utf8")
}
```

### Patterns

**Inject skill/rules for one turn only** (one-shot system injection):

- TUI sets a flag in state (e.g. `{ pending: { [sid]: true } }`) then calls `promptAsync`
- Server's `system.transform` reads the flag, pushes skill content to `output.system`, clears flag, returns early
- AI gets the full skill as system context; only the short user message is visible in TUI

**Track child sessions** (subagent detection):

```ts
const children = new Set<string>()
// in event hook:
if (event?.type === "session.created" && event.properties.info.parentID) children.add(event.properties.info.id)
if (event?.type === "session.deleted") children.delete(event.properties.sessionID)
// in system.transform: check children.has(input.sessionID)
```

### Gotchas

| Issue                                  | Cause                                      | Fix                                               |
| -------------------------------------- | ------------------------------------------ | ------------------------------------------------- |
| `"must start with 'ses'"` schema error | v1-style `{ path: { id } }` params         | Use flat `{ sessionID, parts }` — v2 SDK          |
| TUI worker crashes                     | `console.log` / `process.stderr.write`     | Use `fs.writeFile("/tmp/debug.log", ...)`         |
| Stuck at "loading plugins"             | Stray `});` / `]);` from incremental edits | Rewrite the file cleanly in one shot              |
| `event.type` is undefined              | Accessing `event.payload.type`             | Access directly: `event.type`, `event.properties` |
