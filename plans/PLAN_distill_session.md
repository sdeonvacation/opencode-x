# Plan: Distill Current Session

## Overview

Extend the `/distill` command to accept `this` as an argument, targeting only the current session's messages for skill extraction. No args keeps existing multi-session behavior. Requires a minor extension to the command system so templates can access session context at dispatch time.

## Tech Stack

TypeScript, Effect-ts, existing command/session infrastructure.

## Testing Strategy

- Unit: `buildSessionContext` returns expected format for a single session
- Integration: `/distill this` dispatches with current session context only
- Done when: `/distill` works as before; `/distill this` passes only current session messages to distill agent

## Phases

### Phase 1: Add `buildSessionContext` to `dream-spawn.ts`

- New function that builds context from exactly one session ID (reuses `extractText` / `MessageV2.page`)
- Signature: `buildSessionContext(sessionID: SessionID, opts?: { max_context_chars?: number; max_messages?: number }): string`
- Same output format as `buildContext` (markdown, role-tagged entries) but single session, no time filtering

### Phase 2: Add `dynamicTemplate` to `Command.Info`

- New optional field: `dynamicTemplate?: (input: { sessionID: SessionID; arguments: string }) => string | Promise<string>`
- In `SessionPrompt.command` (prompt.ts ~line 2206): if `cmd.dynamicTemplate` exists, call it with `{sessionID: input.sessionID, arguments: input.arguments}` instead of resolving `cmd.template`
- Backward compatible — existing commands without `dynamicTemplate` unchanged

### Phase 3: Wire `/distill` to use `dynamicTemplate`

- In `command/index.ts`, change distill command registration to use `dynamicTemplate`
- Logic: if arguments match `this` (case-insensitive, trimmed) → call `buildSessionContext(input.sessionID, cfg.distill)`
- Otherwise → existing `buildContext(days, opts)` behavior
- Keep `template` getter as fallback (for type compat / when dynamicTemplate not invoked)

### Phase 4: Adjust distill prompt for single-session mode

- Prepend a note to `DISTILL_TASK` when in single-session mode: "Analyzing a single session. Skip the 'recurring 2+ times' requirement — focus on complexity and non-obviousness."
- The "performed 2+ times" criterion doesn't apply when user explicitly asks to distill one session

## Risks/Edge cases

- **Current session too short/empty**: Return early with "No content to distill" message if < 3 messages
- **`dynamicTemplate` adds complexity to Command type**: Keep it optional, no schema validation (internal only), document clearly
- **`this` conflicts with future argument semantics**: Low risk — reserved word users won't type accidentally for other commands
- **Template type union gets unwieldy**: `dynamicTemplate` is separate field, doesn't touch existing `template: Promise<string> | string`
