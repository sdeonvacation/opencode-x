# Plan: /context Command

## Overview

A `/context` TUI command that displays a comprehensive breakdown of what's consuming the current session's context window. Shows model info, token usage by category (system prompt, tools, MCP tools, agents, memory, skills, messages), and per-item token estimates with a visual usage bar.

## Tech Stack

- TypeScript + Effect-ts (server-side route)
- Solid-js + @opentui (TUI dialog rendering)
- Hono (HTTP route)
- `cheapTokenEstimate` chars/4 approximation for sizing

## Testing Strategy

- Unit: token estimation logic, data assembly
- Integration: route returns correct shape, TUI renders without crash
- Done when: `/context` shows category breakdown matching actual prompt assembly

## Phases

### Phase 1: Server Route — Context Data Assembly

- Step 1: Create `src/session/context-usage.ts` namespace with `ContextUsage` types and assembly logic
- Step 2: Add `GET /session/:sessionID/context` route in `server/routes/session.ts`
- Step 3: Route resolves session model, then assembles token estimates for each category:
  - System prompt (provider prompt text)
  - Instructions (AGENTS.md, CLAUDE.md content)
  - System tools (built-in tool definitions from ToolRegistry)
  - MCP tools (per-tool token estimates from mcp.tools())
  - Custom agents (agent definition text)
  - Memory files (PersistentMemory.inject() content)
  - Skills (SystemPrompt.skills() output — listing only, not loaded content)
  - Messages (conversation history via MessageV2.filterCompactedEffect)
  - Free space (context limit minus sum of above)
- Step 4: Return structured JSON matching the display categories

### Phase 2: TUI Command — Dialog Rendering

- Step 1: Create `src/cli/cmd/tui/command/context-command.tsx` following `/usage` pattern
- Step 2: Register in `app.tsx` as `createContextCommand(...)` with `slash: { name: "context" }`
- Step 3: Render scrollable dialog with:
  - Header: model name, model ID, token usage ratio
  - Visual bar (colored segments per category)
  - Category breakdown with token counts and percentages
  - Expandable sections: MCP tools list, Custom agents list, Skills list, Memory files list

### Phase 3: Polish

- Step 1: Sort items within each section by token count descending
- Step 2: Format numbers (1.2k, 939.8k style)
- Step 3: Tree-style indentation for sub-items (├─ prefix)
- Step 4: Group skills by source (User, Plugin, Built-in)
- Step 5: Group agents by source (User, Plugin)

## Risks/Edge cases

- **Token estimation inaccuracy**: chars/4 is rough; actual tokenization varies per model. Mitigation: label as "Estimated" and use same heuristic consistently
- **No active session**: if invoked from home screen, show warning toast (same pattern as /usage)
- **Large MCP tool lists**: many MCP tools could make dialog very tall. Mitigation: scrollable dialog, show top N with "and X more" footer
- **Model not resolved**: session may not have a model set yet. Mitigation: fall back to default model or show "unknown"
- **Context window = 0**: some custom models have no context limit. Mitigation: omit percentage/bar when limit unknown
