# OpenCode X

AI-powered development platform with hybrid local+cloud routing, safe parallelism, and enhanced orchestration.

**For detailed setup and configuration, see [OPENCODE-X_GUIDE.md](./OPENCODE-X_GUIDE.md).**

---

## What's New in OpenCode X

### Hybrid Local+Cloud Routing

Intelligently route tasks: cheap/simple turns execute locally, complex analysis uses cloud. Configurable per-category routing for cost efficiency.

- Evidence: `session/llm.ts`, `route-classifier.ts`, `resolve-local.ts`

### Safe Parallel Tool Execution

Run compatible tools in parallel—read, glob, grep, and file operations execute concurrently for faster workflows.

- Evidence: `session/llm.ts`, `tool/grep.ts`, `tool/glob.ts`, `tool/read.ts`, `provider/transform.ts`

### Stronger Orchestration Guardrails

- **Loop detection** — Catches repeated identical task calls
- **Spawn limits** — Caps subagent nesting depth and descendant count
- **Concurrency caps** — Per-model request limiting
- **Task category routing** — Delegate to specialized models for review, research, debug, etc.
- Evidence: `src/tool/task.ts`, `src/session/subtask-handler.ts`, `src/orchestration/*`

### Enhanced TUI Commands

New slash commands for faster navigation:

- `/goto` — Jump to file/symbol
- `/clear`, `/clear-compact` — Session management
- `/btw` — Inline context insertion
- Evidence: `tui/command/*`

### Better Image Paste & Feedback

- Improved clipboard image handling in TUI
- Enhanced spinner feedback for long-running operations
- Evidence: `clipboard-image.ts`, `prompt/index.tsx`, `spinner-verbs.ts`

### Long-Session Stability

Memory and stability fixes for extended sessions and large tool output:

- Optimized message buffering
- Improved bash/output streaming
- Database compaction refinements
- Evidence: `session/message-v2.ts`, `tool/bash.ts`, `storage/db.ts`

### LSP Enhancements

- Pull-based diagnostics
- Instant `didChange` sync
- Idle shutdown optimization
- Nearest-package tsserver resolution
- Evidence: `src/lsp/*`

### Terminal Customization

- Font settings in app (configurable terminal appearance)
- Bundled Nerd Font for icon support
- Evidence: `packages/app/src/context/settings.tsx`, `terminal.tsx`

---

## vs. Upstream (dev)

| Feature                    | OpenCode X branch                                | upstream/dev                                |
| -------------------------- | ------------------------------------------------ | ------------------------------------------- |
| **Hybrid routing**         | Configurable local+cloud routing by turn type    | No branch-added hybrid routing layer        |
| **Parallel tools**         | Parallel execution for approved safe tool sets   | No branch-added parallel tool execution     |
| **Loop/spawn guards**      | Added loop detection and spawn limits            | Fewer orchestration guardrails in this area |
| **Task categories**        | Added category-based task routing                | No branch-added task category routing       |
| **TUI commands**           | Adds `/goto`, `/clear`, `/clear-compact`, `/btw` | Does not include this branch command set    |
| **Long-session stability** | Adds memory and output-handling fixes            | Does not include this branch fix set        |
| **Terminal fonts**         | Adds terminal font settings + bundled font       | Does not include this branch font feature   |

---

## Quick Start

### Install

```bash
bun install
```

### Run TUI

```bash
bun run dev
```

### Run CLI

```bash
bun run --cwd packages/opencode dev
```

### Build

```bash
bun --cwd packages/opencode run build
```

### Test

```bash
bun --cwd packages/opencode test --timeout 30000
```

---

## Key Configuration

### Hybrid Routing (Example)

```json
{
  "experimental": {
    "task_categories": {
      "review": {
        "providerID": "anthropic",
        "modelID": "claude-sonnet-4-5"
      },
      "cheap": {
        "providerID": "opencode-go",
        "modelID": "minimax-m2.5"
      }
    }
  }
}
```

### Orchestration Limits

```json
{
  "experimental": {
    "loop_detector_threshold": 5,
    "max_subagent_depth": 3,
    "max_subagent_descendants": 50,
    "model_concurrency": {
      "anthropic:claude-sonnet-4-5": 2
    }
  }
}
```

### Parallel Tool Calls

Include multiple tool calls in one LLM response—grep, glob, and read execute concurrently:

```typescript
Grep({ pattern: "function foo" })
Glob({ pattern: "src/**/*.ts" })
Read({ filePath: "src/index.ts" })
// All run in parallel
```

---

## Resources

- **Docs**: https://opencode.ai/docs
- **Console**: https://opencode.ai/zen
- **Discord**: https://opencode.ai/discord
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
