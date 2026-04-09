# Requirement: Buddy Companion System

## Summary

Port the buddy/companion system from `~/claude-code1/src/buddy/` to opencode's TUI. A persistent ASCII creature sits beside the user's input box, occasionally reacting to conversation in a speech bubble.

## Source Reference

Complete implementation in `~/claude-code1/src/buddy/` (8 files, ~1,519 lines) plus `~/claude-code1/src/commands/buddy/` (2 files, ~185 lines).

## Functional Requirements

### FR-1: Deterministic Companion Generation

- Generate companion from `hash(userId)` using seeded PRNG (Mulberry32)
- 18 species, 5 rarity tiers (weighted: 60/25/10/4/1), 6 eyes, 8 hats
- 5 stats: DEBUGGING, PATIENCE, CHAOS, WISDOM, SNARK (1-100, rarity-floored)
- 1% shiny chance
- Same user always gets same companion

### FR-2: Persistence

- Store only soul (name, personality, hatchedAt) in opencode config
- Regenerate bones (species, rarity, stats, eye, hat, shiny) from userId on every load
- Never persist bones (prevents edit-cheating, allows species array changes)

### FR-3: ASCII Sprite Rendering

- 18 species × 3 animation frames (5 lines tall, 12 chars wide)
- Hat substitution on line 0; eye placeholder `{E}` replacement
- Idle animation: 500ms tick, fidget sequence, rare blink
- Narrow terminal (<100 cols): collapse to one-line face + name

### FR-4: Speech Bubble

- Floating bubble (30-char wrap) shows companion reaction text
- Visible for ~10s, fades over last ~3s
- Tail direction: down or right depending on layout

### FR-5: Reaction System (MODIFIED from claude-code)

- **Replace proprietary `buddy_react` API with local LLM call**
- Use the active session model by default
- Config flag `experimental.buddy_model` to override with a specific `{ providerID, modelID }`
- Rate limit: 45s minimum between reactions (bypass when @-mentioned by name)
- Build transcript: last 12 messages, 5000 char max
- Prompt companion with personality + transcript → get one-line reaction
- Cache last 8 reactions to avoid repetition

### FR-6: `/buddy` Command

- `/buddy` (no args): hatch new companion or show existing CompanionCard
- `/buddy pet`: trigger 2.5s heart animation + force reaction
- `/buddy on`: unmute
- `/buddy off`: mute

### FR-7: System Prompt Injection

- Inject once per session: "A small {species} named {name} sits beside the user's input box..."
- Skip if muted or no companion

### FR-8: Feature Flag

- `experimental.buddy` (boolean) — enable/disable entire system
- `experimental.buddy_model` (optional `{ providerID, modelID }`) — override reaction model
- Zero overhead when disabled (components return null, no intervals created)

## Non-Functional Requirements

### NFR-1: Rebase Safety

- All new files in `src/cli/cmd/tui/buddy/` — no edits to hot files except minimal integration points
- Integration in session/index.tsx and prompt/index.tsx should be <20 lines each

### NFR-2: Performance

- Sprite animation: 500ms tick (not 80ms)
- Reaction LLM call: fire-and-forget, never blocks session turn
- Cache companion bones (single-entry cache, hot path: tick + keystroke)

### NFR-3: Compatibility

- Works in macOS Terminal, iTerm2, IntelliJ terminal
- Graceful degradation on narrow terminals (<100 cols)
