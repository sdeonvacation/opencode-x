# Plan: Add Lifecycle Hook Events (SessionStart, UserPromptSubmit, Stop)

## Overview

Add `SessionStart`, `UserPromptSubmit`, and `Stop` hook events to make Claude Code plugins (caveman, etc.) work natively. The hook system already reads `~/.claude/settings.json` but ignores unknown events. This plan adds 3 events + makes `matcher` optional (Claude Code's lifecycle hooks don't use it).

## Tech Stack

- TypeScript 5.8 on Bun
- Effect-ts 4.0 (Effect.fn, Effect.runFork, Effect.ignore)
- Existing hook system (`src/hook/hook.ts`)
- Existing session lifecycle (`src/session/index.ts`, `src/session/prompt.ts`)

## Testing Strategy

- Unit: Hook dispatch with optional matcher, new events fire correctly
- Integration: Caveman plugin activates on SessionStart, mode-tracker fires on UserPromptSubmit
- Done when: `bun --cwd packages/opencode test test/hook/` passes, caveman works without modification

## Phases

### Phase 1: Hook System Core Changes (`src/hook/hook.ts`)

- Step 1: Add `"SessionStart" | "UserPromptSubmit"` to `Event` type union (line 13)
- Step 2: Add both to `EVENTS` array (line 22)
- Step 3: Change `Rule.matcher` from `string` to `string | undefined` (line 38)
- Step 4: Add `prompt?: string` to `Payload` type (line 45)
- Step 5: Add `SessionStart: [], UserPromptSubmit: []` to `empty()` return (line 72)
- Step 6: Add `CLAUDE_USER_PROMPT: payload.prompt ?? ""` env var in `execute()` (line 123)
- Step 7: Change dispatch matcher filter (line 162): `active.filter((r) => !r.matcher || matches(r.matcher, tool))`
- Step 8: Extend blocking check (line 169): `(event === "PreToolUse" || event === "UserPromptSubmit") && result.code !== 0`

### Phase 2: Config Schema (`src/config/config.ts`)

- Step 1: Add `SessionStart` schema to hooks object (after line 1312) — `matcher` optional
- Step 2: Add `UserPromptSubmit` schema to hooks object — `matcher` optional
- Step 3: Make `matcher` optional on ALL existing event schemas (lines 1217, 1231, 1245, 1259, 1273, 1287, 1301) for full Claude Code compatibility
- Step 4: Add optional `statusMessage: z.string().optional()` to all HookDef schemas (Claude Code uses this)

### Phase 3: Wire Dispatch Points

- Step 1: `src/session/index.ts` line ~437 (after `SyncEvent.run` in `createNext`): Dispatch `SessionStart` non-blocking via `Effect.runFork`
- Step 2: `src/session/prompt.ts` line ~1047 (after `sessions.touch` in `prompt()`): Dispatch `UserPromptSubmit` blocking — if denied, return user message without entering loop
- Step 3: `src/session/index.ts` line ~468 (in `remove()` before deletion): Dispatch `Stop` non-blocking via `Effect.ignore`
- Step 4: For UserPromptSubmit payload: extract text from `input.parts` (filter ContentPart text types, join)

## Risks

- Buggy UserPromptSubmit plugin blocks all input: Mitigated by 5s timeout (matching Claude Code default)
- SessionStart hook slow: Mitigated by non-blocking dispatch (fire-and-forget)
- Config access in `createNext()`: May need to yield config inside Effect context — verify it's available
