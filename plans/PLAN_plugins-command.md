# Plan: /plugins Slash Command

## Overview

Add a `/plugins` slash command that displays loaded plugin origins in a toast notification. Mirrors the `/agents` registration pattern but uses toast (not dialog) for output.

## Tech Stack

- TypeScript, Solid.js (TUI layer)
- Effect-ts (Plugin.Service access)
- Existing toast API (`ui/toast.tsx`)

## Testing Strategy

- Unit: Verify plugin name extraction from `PluginSpec` (string vs tuple)
- Integration: `/plugins` command triggers toast with correct plugin list
- Done when: Typing `/plugins` shows toast listing all `plugin_origins` entries by name

## Phases

### Phase 1: Register Slash Command

- Step 1: Add command entry in `app.tsx` commands array with `slash: { name: "plugins" }`, category "Plugin"
- Step 2: `onSelect` handler calls toast with formatted plugin list

### Phase 2: Plugin Data Access & Formatting

- Step 1: Access `plugin_origins` from config (available via sync context or config import)
- Step 2: Extract display name from each `PluginSpec` (package name for strings, first element for tuples)
- Step 3: Format as multiline string: one plugin per line with scope indicator
- Step 4: Handle empty state — toast "No plugins loaded" if list empty

## Constraints

- **Upstream-rebase safe**: Minimal, surgical edits only. No reformatting adjacent code. Append-only where possible (e.g., add command entry at end of commands array).
- **No broad refactors**: Touch only what's needed for this feature.

## Risks

- Toast text overflow: Long plugin lists may exceed toast display area → truncate with count suffix
- Config access in TUI: Need to verify `plugin_origins` is available in TUI context (sync exposes config)
