# Plan: Buddy Companion System

## Overview

Port the buddy/companion system from claude-code to opencode's TUI. A deterministic ASCII creature (18 species, 5 rarity tiers) sits beside the input box and occasionally reacts to conversation via a local LLM call. The proprietary `buddy_react` API is replaced with a call to the active model (or a configurable override).

## Tech Stack

- Language: TypeScript 5.8.2 + Bun 1.3.11
- UI: `@opentui/solid` (SolidJS JSX) — same as existing TUI
- AI: Vercel AI SDK `streamText` for reaction LLM calls
- Config: Zod schema in `src/config/config.ts`
- PRNG: Mulberry32 (ported from claude-code, zero deps)

## Testing Strategy

- Unit: companion generation determinism, sprite rendering, transcript building, rate limiting
- Integration: `/buddy` command hatch/pet/mute flow (mock LLM call)
- Done when: `bun --cwd packages/opencode typecheck` clean, all buddy tests pass

## Phases

### Phase 1: Core Data Layer (no UI, no LLM)

Pure TypeScript, zero dependencies on TUI or AI SDK. Can be tested standalone.

- Step 1: Create `src/cli/cmd/tui/buddy/types.ts` — port types, constants, rarity weights, species list, stat names, color mappings from `~/claude-code1/src/buddy/types.ts`
- Step 2: Create `src/cli/cmd/tui/buddy/companion.ts` — port Mulberry32 PRNG, `roll()`, `rollStats()`, `rollRarity()`, `getCompanion()`, `companionUserId()`, single-entry cache. Use `Bun.hash()` (already available in opencode runtime)
- Step 3: Create `src/cli/cmd/tui/buddy/sprites.ts` — port all 18 species × 3 frames, `renderSprite()`, `renderFace()`, hat lines
- Step 4: Create `src/cli/cmd/tui/buddy/prompt.ts` — port `companionIntroText()` and intro attachment logic
- Step 5: Add config fields to `src/config/config.ts`:
  - `experimental.buddy` (boolean, optional)
  - `experimental.buddy_model` (optional `{ providerID: string, modelID: string }`)
  - Top-level config: `companion` (StoredCompanion, optional), `companion_muted` (boolean, optional)
- Step 6: Write tests — `test/cli/tui/buddy/companion.test.ts` (determinism, caching, stats), `test/cli/tui/buddy/sprites.test.ts` (frame count, eye substitution, hat rendering)

### Phase 2: Reaction System (LLM integration)

- Step 1: Create `src/cli/cmd/tui/buddy/react.ts` — port `triggerCompanionReaction()` replacing API call with local LLM call:
  - Read `experimental.buddy_model` from config; fall back to active session model
  - Build transcript (last 12 messages, 5000 chars)
  - Call `streamText()` with short system prompt: companion personality + "respond in ≤15 words"
  - Collect full text, pass to `setReaction` callback
  - Rate limit: 45s minimum (bypass on @-mention)
  - Dedup: cache last 8 reactions
- Step 2: Write tests — `test/cli/tui/buddy/react.test.ts` (rate limiting, transcript building, @-mention detection, dedup)

### Phase 3: UI Components (TUI rendering)

- Step 1: Create `src/cli/cmd/tui/buddy/CompanionSprite.tsx` — port to `@opentui/solid`:
  - `createSignal` for tick, reaction, petAt
  - `setInterval(500ms)` with `onCleanup`
  - Idle animation sequence, pet hearts, speech bubble
  - Wide (≥100 cols) vs narrow (<100 cols) layout
  - `companionReservedColumns()` export for prompt width calculation
- Step 2: Create `src/cli/cmd/tui/buddy/CompanionCard.tsx` — port stat bars, rarity display, personality quote
- Step 3: Create `src/cli/cmd/tui/buddy/SpeechBubble.tsx` — 30-char wrap, fade logic, tail direction
- Step 4: Integrate into `src/cli/cmd/tui/routes/session/index.tsx`:
  - Import `CompanionSprite`, render in `right` prop of `<Prompt>`
  - Guard with `experimental.buddy` config check
  - Wire `triggerCompanionReaction()` call after each assistant turn completes
  - ~15 lines of integration code

### Phase 4: Command & System Prompt

- Step 1: Register `/buddy` slash command via `command.register()` in prompt component:
  - `/buddy` → hatch or show CompanionCard
  - `/buddy pet` → set petAt + trigger reaction
  - `/buddy on` / `/buddy off` → toggle mute
  - Hidden when `experimental.buddy` is false
- Step 2: Wire system prompt injection — add `companionIntroText()` to system prompt assembly in `src/session/system.ts` or via attachment in `src/session/prompt.ts`, guarded by config flag + companion exists + not muted
- Step 3: Write integration test — `test/cli/tui/buddy/command.test.ts` (hatch flow, pet, mute toggle)

## Risks

- **LLM call latency**: Reaction call may take 1-5s depending on model → mitigated by fire-and-forget (never blocks UI or session turn)
- **Token cost**: Each reaction is a short prompt (~200 tokens in, ~20 out) → mitigated by 45s rate limit + only when conversation is active
- **Model availability**: `buddy_model` override may reference a model not configured → fall back to active session model, log warning
- **Terminal width**: Companion sprite (12 cols) + bubble (30 cols) = 42 cols reserved → graceful collapse to one-line face at <100 cols
- **Config schema migration**: Adding `companion` to top-level config → optional field, no migration needed (undefined = no companion)
