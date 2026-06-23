# Plan: /insights — Built-in Session Analytics & Reporting

## Overview

Incorporate [opencode-insights](https://github.com/tim-hilde/opencode-insights) as a built-in internal plugin in opencode-x. Registers `/insights` slash command that analyzes session history via LLM, generates HTML report + JSON output. Uses direct `generateText()` calls (no temp sessions) with `small_model` for cheapest/lightest LLM usage. Reuses existing `/usage` token/cost data from session table.

## Tech Stack

- TypeScript (match opencode-x style)
- Built-in plugin (same pattern as CodexAuthPlugin, CopilotAuthPlugin)
- `@opencode-ai/plugin` API for tool/command registration
- AI SDK `generateText()` for direct LLM calls (bypass session creation)
- `bun:sqlite` for reading session data (same as current insights approach)
- Filesystem caching for facets (`~/.local/share/opencode/insights/facets/`)

## Testing Strategy

- Unit: interval parsing, JSON extraction, facet normalization, transcript reconstruction, report generation
- Integration: full pipeline with mock DB data → HTML output
- Done when: `/insights` produces valid HTML report from real session data using direct LLM calls

## Phases

### Phase 1: Port Source as Built-in Plugin

- Step 1: Create `packages/opencode/src/plugin/insights/` directory
- Step 2: Port all source files from opencode-insights (index.ts, orchestrator.ts, analyze.ts, extract.ts, db.ts, llm.ts, cache.ts, config.ts, prompts.ts, report.ts, types.ts)
- Step 3: Adapt imports to opencode-x conventions (relative paths, no external deps)
- Step 4: Register in `plugin/index.ts` internalPlugins array (like CodexAuthPlugin)
- Step 5: Verify plugin loads and `/insights` command appears

### Phase 2: Replace LLM Layer with Direct generateText()

- Step 1: Replace `runLlm()` (creates temp sessions) with direct AI SDK `generateText()` call
- Step 2: Use `small_model` from provider config (same resolution as /loop: provider small_model → fallback)
- Step 3: Remove session.create/session.delete overhead — just prompt → text response
- Step 4: Keep `mapLimit()` for parallel LLM calls with configurable concurrency
- Step 5: Ensure no ghost sessions created in DB during insights run

### Phase 3: Reuse Existing /usage Data

- Step 1: Identify overlap between insights `db.ts` queries and existing session token/cost tracking
- Step 2: Where opencode-x already aggregates data (e.g., per-model costs, token totals), read from existing APIs/queries rather than raw SQL
- Step 3: Keep insights-specific queries that don't overlap (tool error rates, cache efficiency, agent delegation patterns)
- Step 4: Ensure insights reads from same DB path opencode-x uses (no path resolution duplication)

### Phase 4: Adapt Configuration

- Step 1: Add `insights` config section to opencode.json schema (model, days, concurrency, maxSessions)
- Step 2: Remove standalone `~/.config/opencode/insights.json` — fold into main config
- Step 3: Keep CLI arg overrides working (--days, --model, --force, --all, --output)
- Step 4: Default model: uses `small_model` from provider config (not hardcoded haiku)

### Phase 5: Polish & Compatibility

- Step 1: Ensure report.ts HTML generation works with current session schema
- Step 2: Adapt `db.ts` queries if opencode-x session table schema differs from upstream opencode
- Step 3: Validate prompt injection guards (UNTRUSTED markers) still work
- Step 4: Test with real session data from opencode-x DB
- Step 5: Port tests from opencode-insights/test/

## Risks/Edge cases

- **Schema drift**: opencode-x session table may differ from upstream opencode schema → verify column names match
- **Large DB**: Many sessions = slow facet extraction → existing maxSessions cap (200) + caching mitigates
- **Model availability**: If small_model not configured → graceful error with message
- **Plugin API stability**: Built-in plugins bypass npm install but still use @opencode-ai/plugin types → ensure types match
- **Report size**: HTML reports with many sessions can be large → existing design handles this (collapsible sections)
- **Cost**: Even with haiku, analyzing 200 sessions × 8 aggregate prompts = ~210 LLM calls → concurrency + caching keeps cost low (~$0.10-0.50)

## Code References

| Reference                 | Path                                           | What to learn                     |
| ------------------------- | ---------------------------------------------- | --------------------------------- |
| opencode-insights source  | /Users/i570749/opencode-insights/src/          | Full implementation to port       |
| Internal plugin pattern   | packages/opencode/src/plugin/index.ts:60-76    | How built-in plugins register     |
| Plugin API types          | @opencode-ai/plugin                            | Tool/command/hooks interface      |
| Tool registry             | packages/opencode/src/tool/registry.ts:119-167 | How plugin tools become available |
| Provider/model resolution | packages/opencode/src/provider/provider.ts     | small_model access                |
| Session table schema      | packages/opencode/src/session/session.sql.ts   | Column names to query             |

## Architecture Notes (for HLD)

```
User: /insights --days 14
         │
         ▼
┌─────────────────────────────────────────┐
│  Insights Plugin (built-in)              │
│  Registered in internalPlugins[]         │
│  Exposes: tool.insights + command.insights│
└──────────┬──────────────────────────────┘
           ▼
┌─────────────────────────────────────────┐
│  Orchestrator                            │
│  1. Filter sessions (days, project)      │
│  2. Extract facets (LLM, cached)         │
│  3. Aggregate analysis (8 prompts)       │
│  4. At-a-glance synthesis                │
│  5. Generate HTML + JSON                 │
└──────────┬──────────────────────────────┘
           ▼
┌─────────────────────────────────────────┐
│  LLM Layer (direct generateText)         │
│  - No session creation/deletion          │
│  - Uses small_model from provider config │
│  - mapLimit(concurrency) parallel calls  │
└──────────┬──────────────────────────────┘
           ▼
┌─────────────────────────────────────────┐
│  Output                                  │
│  - HTML report (self-contained, opens    │
│    in browser)                           │
│  - insights.json (diffable)              │
│  - TUI toast with summary               │
└─────────────────────────────────────────┘
```
