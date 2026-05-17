# OpenCode X

Fork of [opencode](https://github.com/anomalyco/opencode) with token efficiency, memory efficiency, and orchestration improvements.

**For full setup and configuration, see [OPENCODE-X_GUIDE.md](./OPENCODE-X_GUIDE.md).**

---

## Features Added in This Fork

### Sliding Window Compaction

Replaces hard-truncation with a rolling-window strategy for long sessions. Instead of truncating to a fixed size, history is split into a summarized **head** and a verbatim **tail**.

- Summary cached by session + head boundary — only re-summarizes when the head changes
- Inflight deduplication — one compaction per session at a time; no redundant LLM calls
- Token savings tracked per session
- Configurable threshold (default 50k tokens) and tail ratio (default 50%)

```json
{
  "compaction": {
    "sliding_window": {
      "threshold": 50000,
      "tail_ratio": 0.5
    }
  }
}
```

### LLM Tool Output Compression

A local model pre-processes large tool outputs before they reach the cloud model — cuts token consumption without changing agent behavior.

- Triggered by output line count threshold (default: 10 lines)
- Three compression templates, selected per tool type:
  - **EXTRACT** — key lines, bullets, file/line refs (`grep`, `glob`, `bash`)
  - **SUMMARIZE** — 3–6 bullets capturing key facts (`read`, large output)
  - **FILTER** — matching items only, noise dropped (logs, diffs)
- Anti-hallucination system prompt enforced on every compression call
- Silently falls back to raw output on error — never corrupts results
- Per-event stats: `input_lines`, `output_lines`, `ratio`, `template`, `model`, `fallback`

```json
{
  "hybrid": {
    "enabled": true,
    "local_model": { "providerID": "anthropic", "modelID": "claude-haiku-4-5" },
    "compression_timeout_ms": 8000,
    "log_routing": true
  }
}
```

### Hybrid Local+Cloud Routing

Route task categories to specific models — cheap/fast for simple tasks, capable cloud model for complex ones.

```json
{
  "experimental": {
    "task_categories": {
      "review": { "providerID": "anthropic", "modelID": "claude-sonnet-4-6" },
      "cheap": { "providerID": "opencode-go", "modelID": "minimax-m2.5" }
    },
    "ultrawork_model": { "providerID": "anthropic", "modelID": "claude-sonnet-4-6" }
  }
}
```

### Safe Parallel Tool Execution

Pre-approved tool sets (`read`, `glob`, `grep`) execute concurrently within a single LLM response round-trip.

```json
{
  "experimental": {
    "parallel_tool_calls": true,
    "parallel_read": true
  }
}
```

### Orchestration Guardrails

- **Doom loop detection + hard cap** — aborts on repeated identical task calls; hard cap as separate backstop
- **Spawn limits** — caps subagent nesting depth and total descendants per root session
- **Per-model concurrency** — prevents thundering-herd against a single model endpoint
- **Task category routing** — `task_category` param routes subagent tasks to a configured model
- **Ultrawork routing** — `use_ultrawork: true` or `ulw`/`ultrawork` keyword routes to a high-reasoning model

```json
{
  "experimental": {
    "loop_detector_threshold": 5,
    "max_subagent_depth": 3,
    "max_subagent_descendants": 50,
    "model_concurrency": { "anthropic:claude-sonnet-4-6": 2 }
  }
}
```

### Session Memory

Persistent per-session memory that survives `/clear` and `/clear-compact`. Injected into the primary agent's system prompt only.

- `/memory_add` — add a memory entry (dialog prompt)
- `/memory_edit` — pick and edit an existing entry
- `/memory_delete` — pick and remove an entry
- Stored in SQLite (`MemoryTable`); tied to session, not affected by message clears

### LSP Memory Efficiency

- Orphan LSP server prevention — servers no longer accumulate across sessions
- Stale diagnostics cache cleared on `didChange`
- Idle shutdown — servers released when not in use
- Nearest-package tsserver resolution — correct server per workspace package

### Spinner Verbs

Contextual present-continuous labels in the TUI spinner (e.g., "Searching…", "Reading…") instead of generic activity text. Derived from tool runtime title metadata where available.

### New Slash Commands

| Command          | Description                                                 |
| ---------------- | ----------------------------------------------------------- |
| `/btw`           | Inject context into the session without starting a new turn |
| `/clear`         | Clear session messages                                      |
| `/clear-compact` | Clear messages and compact history                          |
| `/goto`          | Jump to a file or symbol                                    |

### Session Cost & Token Tracking

- Pre-computed cost and token totals attached to each session object
- Tiered pricing schema — cost adjusts for context window tier
- Streaming token count shown in tool calls during execution
- Fix: context metrics no longer double-count cache tokens in TUI

### Read Tool: Safe Default

`read` defaults to 300 lines with a head+tail summary instead of returning unbounded output. Prevents accidental full-file dumps flooding context.

### Session ID in `/status`

`/status` dialog shows the current session ID, copyable for debugging or referencing subagent sessions.

---

## What's Not in This Fork (Cherry-Picks from Upstream)

The following were pulled from upstream opencode and are not locally-originated features:

- Thinking mode (collapsed/expandable reasoning display)
- Session pinning + quick-switch
- Background subagents (`task(..., background=true)`)
- Ctrl/Cmd+number project switching
- Patch file rendering improvements
- Default diff parser for fenced code blocks

---

## OpenCode X vs. Upstream

| Feature                       | This Fork                                           | Upstream             |
| ----------------------------- | --------------------------------------------------- | -------------------- |
| **Sliding window compaction** | Rolling head+tail with summary cache                | Hard truncation only |
| **Tool output compression**   | Local LLM pre-processes large outputs               | None                 |
| **Hybrid/category routing**   | Per-category model routing + ultrawork              | None                 |
| **Parallel tool calls**       | Safe parallel execution                             | None                 |
| **Doom loop guard**           | Detection + hard cap + spawn depth/count limits     | Fewer guardrails     |
| **Session memory**            | Persistent per-session memory, survives clears      | None                 |
| **LSP memory efficiency**     | Orphan prevention + idle shutdown                   | Accumulates servers  |
| **Spinner verbs**             | Contextual tool activity labels                     | Generic spinner      |
| **TUI slash commands**        | `/btw`, `/clear`, `/clear-compact`, `/goto`         | None of these        |
| **Token tracking**            | Per-session totals, tiered pricing, streaming count | Basic                |
| **Read tool default**         | 300-line limit with head+tail                       | Unbounded            |

---

## Quick Start

```bash
bun install
bun run dev                              # TUI
bun run --cwd packages/opencode dev      # CLI
bun --cwd packages/opencode run build
bun --cwd packages/opencode test --timeout 30000
```

---

## Resources

- **Upstream**: https://github.com/anomalyco/opencode
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
