# HLD: Buddy Companion System

## Tech Stack

| Category | Technology               | Purpose                                                        |
| -------- | ------------------------ | -------------------------------------------------------------- |
| Language | TypeScript 5.8.2         | Existing codebase language                                     |
| Runtime  | Bun 1.3.11               | Existing runtime; `Bun.hash()` for deterministic seed hashing  |
| UI       | @opentui/solid (SolidJS) | TUI rendering — `createSignal`, `setInterval`, `onCleanup`     |
| AI SDK   | Vercel AI SDK 6.x        | `streamText` for companion reaction LLM calls                  |
| Schema   | Zod                      | Config schema extensions for `experimental.buddy*` + companion |
| PRNG     | Mulberry32 (inline)      | Zero-dep seeded PRNG for deterministic companion generation    |
| Test     | bun:test                 | Unit and integration tests                                     |

## Components

| Component             | Responsibility                                                                   | Dependencies                                    |
| --------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------- |
| `types.ts`            | Type definitions, constants, rarity weights, species list                        | None                                            |
| `companion.ts`        | PRNG, `roll()`, `getCompanion()`, single-entry cache                             | `types.ts`, `Bun.hash()`                        |
| `sprites.ts`          | 18×3 ASCII frames, `renderSprite()`, `renderFace()`, hat lines                   | `types.ts`                                      |
| `prompt.ts`           | `companionIntroText()` for system prompt injection                               | `companion.ts`, `types.ts`                      |
| `react.ts`            | `triggerCompanionReaction()` — LLM call, rate limiting, dedup                    | `companion.ts`, `Provider`, `streamText`        |
| `CompanionSprite.tsx` | Animated sprite + speech bubble, wide/narrow layout                              | `companion.ts`, `sprites.ts`, `react.ts`, theme |
| `CompanionCard.tsx`   | Stat bars, rarity display, personality — shown by `/buddy`                       | `types.ts`, `sprites.ts`, theme                 |
| `SpeechBubble.tsx`    | 30-char word-wrap bubble with fade logic and tail direction                      | theme                                           |
| Config (extended)     | `experimental.buddy`, `experimental.buddy_model`, `companion`, `companion_muted` | Zod schema                                      |

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    Session Route (session/index.tsx)                      │
│                                                                          │
│  messages() ──┬──▶ createEffect(on assistant.time.completed)             │
│               │         │                                                │
│               │         ▼                                                │
│               │    triggerCompanionReaction()  ◀── react.ts              │
│               │         │ (fire-and-forget)                              │
│               │         ▼                                                │
│               │    streamText({ model, messages, system })               │
│               │         │                                                │
│               │         ▼                                                │
│               │    setReaction(text) ──▶ CompanionSprite                 │
│               │                                                          │
│               └──▶ <Prompt right={<CompanionSprite />} />               │
│                                                                          │
│  sync.data.config.experimental?.buddy ──▶ guard (Show when)             │
└──────────────────────────────────────────────────────────────────────────┘
         │                                          │
         ▼                                          ▼
┌─────────────────────┐              ┌──────────────────────────┐
│  CompanionSprite.tsx │              │  /buddy command handler  │
│                      │              │  (prompt/index.tsx via   │
│  ┌───────────────┐   │              │   command.register)      │
│  │ SpeechBubble  │   │              │                          │
│  │ (30-char wrap)│   │              │  /buddy → hatch or card  │
│  │ fade + tail   │   │              │  /buddy pet → hearts     │
│  └───────┬───────┘   │              │  /buddy on/off → mute    │
│          │           │              └──────────┬───────────────┘
│  ┌───────▼───────┐   │                         │
│  │ Sprite column │   │                         ▼
│  │ 500ms tick    │   │              ┌──────────────────────────┐
│  │ idle sequence │   │              │  CompanionCard.tsx        │
│  │ pet hearts    │   │              │  (dialog overlay)         │
│  └───────────────┘   │              │  stats, rarity, sprite    │
│                      │              └──────────────────────────┘
│  companion.ts ◀──────┤
│  sprites.ts ◀────────┤
└──────────────────────┘
         │
         ▼
┌──────────────────────────────────────┐
│  companion.ts (Pure Data Layer)       │
│                                       │
│  Bun.hash(userId + SALT)              │
│       │                               │
│       ▼                               │
│  mulberry32(seed) ──▶ rng()           │
│       │                               │
│       ├──▶ rollRarity()  (weighted)   │
│       ├──▶ pick(SPECIES) (18 species) │
│       ├──▶ pick(EYES)    (6 eyes)     │
│       ├──▶ pick(HATS)    (8 hats)     │
│       ├──▶ rollStats()   (5 stats)    │
│       └──▶ shiny (1% chance)          │
│                                       │
│  rollCache: { key, value } ◀── hot    │
│  path optimization (tick + keystroke) │
└──────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────┐
│  Config (config.ts)                   │
│                                       │
│  experimental.buddy: boolean          │
│  experimental.buddy_model: {          │
│    providerID, modelID                │
│  }                                    │
│  companion: StoredCompanion           │
│  companion_muted: boolean             │
└──────────────────────────────────────┘
```

**Description**: The system is organized into three layers:

1. **Pure data layer** (`types.ts`, `companion.ts`, `sprites.ts`, `prompt.ts`) — zero UI or AI SDK dependencies. Deterministic companion generation from a seeded PRNG. Can be tested standalone with `bun test`.

2. **Reaction layer** (`react.ts`) — bridges the data layer with the Vercel AI SDK. Replaces the proprietary `buddy_react` API with a local `streamText()` call. Fire-and-forget (never blocks session turns). Rate-limited to 45s minimum between reactions.

3. **UI layer** (`CompanionSprite.tsx`, `CompanionCard.tsx`, `SpeechBubble.tsx`) — SolidJS components using `@opentui/solid` patterns. Rendered in the `right` prop of `<Prompt>` in the session route. Guarded by `experimental.buddy` config flag.

Integration touches only two existing files: `config.ts` (schema additions) and `session/index.tsx` (~15 lines for rendering + reaction trigger). All new code lives in `src/cli/cmd/tui/buddy/`.

## Interfaces

### types.ts — Constants & Types

No exported functions. Exports only types and const arrays:

| Export                | Type                                                                                        | Description                                                     |
| --------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `RARITIES`            | `readonly ["common", "uncommon", "rare", "epic", "legendary"]`                              | Rarity tiers                                                    |
| `Rarity`              | `typeof RARITIES[number]`                                                                   | Union type                                                      |
| `SPECIES`             | `readonly [18 species strings]`                                                             | All species names                                               |
| `Species`             | `typeof SPECIES[number]`                                                                    | Union type                                                      |
| `EYES`                | `readonly ["·", "✦", "×", "◉", "@", "°"]`                                                   | Eye characters                                                  |
| `Eye`                 | `typeof EYES[number]`                                                                       | Union type                                                      |
| `HATS`                | `readonly ["none", "crown", "tophat", "propeller", "halo", "wizard", "beanie", "tinyduck"]` | Hat options                                                     |
| `Hat`                 | `typeof HATS[number]`                                                                       | Union type                                                      |
| `STAT_NAMES`          | `readonly ["DEBUGGING", "PATIENCE", "CHAOS", "WISDOM", "SNARK"]`                            | Stat identifiers                                                |
| `StatName`            | `typeof STAT_NAMES[number]`                                                                 | Union type                                                      |
| `CompanionBones`      | `{ rarity, species, eye, hat, shiny, stats }`                                               | Deterministic parts derived from hash                           |
| `CompanionSoul`       | `{ name, personality, seed? }`                                                              | Model-generated parts stored in config                          |
| `StoredCompanion`     | `CompanionSoul & { hatchedAt: number }`                                                     | What persists in config                                         |
| `Companion`           | `CompanionBones & CompanionSoul & { hatchedAt: number }`                                    | Full merged companion                                           |
| `RARITY_WEIGHTS`      | `Record<Rarity, number>`                                                                    | `{ common: 60, uncommon: 25, rare: 10, epic: 4, legendary: 1 }` |
| `RARITY_STARS`        | `Record<Rarity, string>`                                                                    | `★` through `★★★★★`                                             |
| `RARITY_COLORS`       | `Record<Rarity, string>`                                                                    | Maps rarity to theme color key                                  |
| `SPECIES_NAMES`       | `Record<string, string>`                                                                    | Default name per species (e.g., duck → "Waddles")               |
| `SPECIES_PERSONALITY` | `Record<string, string>`                                                                    | Default personality per species                                 |

### companion.ts — Generation & Caching

| Function          | Input            | Output                   | Behavior                                                                                                                                                                  | Errors |
| ----------------- | ---------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `roll`            | `userId: string` | `Roll`                   | Hash `userId + SALT` → Mulberry32 seed → deterministic `CompanionBones` + `inspirationSeed`. Single-entry cache keyed by `userId + SALT`.                                 | None   |
| `rollWithSeed`    | `seed: string`   | `Roll`                   | Same as `roll` but uses arbitrary seed string (for rehatch). No caching.                                                                                                  | None   |
| `generateSeed`    | (none)           | `string`                 | Returns `"rehatch-{timestamp}-{random8}"` for rehatch seed generation.                                                                                                    | None   |
| `companionUserId` | (none)           | `string`                 | Reads user identity from config. Returns account UUID, userID, or `"anon"`.                                                                                               | None   |
| `getCompanion`    | (none)           | `Companion \| undefined` | Reads `StoredCompanion` from config. If exists, regenerates bones from `stored.seed ?? companionUserId()`, merges with soul. Returns `undefined` if no companion hatched. | None   |

**Type: `Roll`**

```typescript
type Roll = {
  bones: CompanionBones
  inspirationSeed: number
}
```

**Internal (not exported):**

- `mulberry32(seed: number): () => number` — seeded PRNG returning 0-1 float
- `hashString(s: string): number` — uses `Number(Bun.hash(s)) >>> 0` to get unsigned 32-bit integer (Mulberry32 requires u32 seed). Falls back to FNV-1a hash when `Bun.hash` is unavailable (test environments).
- `pick<T>(rng, arr): T` — random array element
- `rollRarity(rng): Rarity` — weighted random
- `rollStats(rng, rarity): Record<StatName, number>` — one peak stat, one dump stat, rarity-floored
- `rollFrom(rng): Roll` — full companion roll

### sprites.ts — ASCII Rendering

| Function           | Input                                  | Output     | Behavior                                                                                                                                 | Errors |
| ------------------ | -------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `renderSprite`     | `bones: CompanionBones, frame: number` | `string[]` | Returns 5-line array for the given species + frame. Substitutes `{E}` with `bones.eye`, applies hat on line 0 if `bones.hat !== "none"`. | None   |
| `renderFace`       | `bones: CompanionBones`                | `string`   | Returns single-line face string for narrow layout (e.g., `({E})` with eye substituted).                                                  | None   |
| `spriteFrameCount` | `species: Species`                     | `number`   | Returns number of animation frames for the species (always 3 in current data).                                                           | None   |

### prompt.ts — System Prompt Injection

| Function             | Input                           | Output    | Behavior                                                                                                                                                       | Errors |
| -------------------- | ------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `companionIntroText` | `name: string, species: string` | `string`  | Returns markdown block describing the companion for system prompt injection. Instructs the model to stay out of the way when user addresses companion by name. | None   |
| `shouldInjectIntro`  | `config: Config.Info`           | `boolean` | Returns `true` if `experimental.buddy` is enabled, companion exists, and not muted.                                                                            | None   |

### react.ts — Reaction System

| Function                   | Input                                                                                                                                                                   | Output    | Behavior                                                                                                                                                                                                                                                                                                                                                                                                    | Errors                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `triggerCompanionReaction` | `messages: Message[], setReaction: (text: string \| undefined) => void, config: Config.Info, activeModel: { providerID: string, modelID: string }, abort?: AbortSignal` | `void`    | 1. Check companion exists and not muted. 2. Check @-mention in last 3 user messages. 3. Rate limit: skip if <45s since last and not addressed. 4. Build transcript (last 12 messages, 5000 chars). 5. Resolve model (config `buddy_model` override, else `activeModel` from session). 6. Fire-and-forget `streamText()` call with `abortSignal`. 7. Collect text, dedup against last 8, call `setReaction`. | Swallowed — logs warning, never throws |
| `buildTranscript`          | `messages: Message[]`                                                                                                                                                   | `string`  | Slices last 12 messages, filters user/assistant, truncates each to 300 chars, joins with newlines, caps at 5000 chars total.                                                                                                                                                                                                                                                                                | None                                   |
| `isAddressed`              | `messages: Message[], name: string`                                                                                                                                     | `boolean` | Scans last 3 user messages for word-boundary match of companion name (case-insensitive).                                                                                                                                                                                                                                                                                                                    | None                                   |

**Module-level state (not exported):**

- `lastReactTime: number` — timestamp of last reaction call
- `recentReactions: string[]` — circular buffer of last 8 reactions for dedup
- `MIN_INTERVAL_MS = 45_000`
- `MAX_RECENT = 8`

**LLM Call Details:**

The reaction system replaces the proprietary `buddy_react` API with a local `streamText()` call:

```typescript
// Model resolution (in react.ts)
// Uses the STATIC async wrappers from provider.ts (lines 1658-1663),
// NOT the Effect-based Service interface. These return Promise, not Effect.
import { Provider } from "@/provider/provider"
import { streamText } from "ai"

async function getReactionModel(
  config: Config.Info,
  activeModel: { providerID: string; modelID: string },
): Promise<LanguageModelV3> {
  const override = config.experimental?.buddy_model
  const { providerID, modelID } = override ?? activeModel
  // Provider.getModel() and Provider.getLanguage() are static async wrappers
  const model = await Provider.getModel(providerID, modelID)
  return Provider.getLanguage(model)
}

// Caller passes activeModel from session route's local.model.current()
// which returns { providerID: string, modelID: string }

// System prompt for reaction
const REACTION_SYSTEM_PROMPT = `You are {name}, a small {species} companion.
Personality: {personality}
Stats: {stats}
Rarity: {rarity}

You sit beside a developer's input box and watch their conversation.
React in character with ONE short sentence (15 words max).
Be {personality-adjective}. Never use markdown. Never explain yourself.
If addressed by name, respond directly to what was said.

Recent reactions (avoid repeating): {recent}`
```

### CompanionSprite.tsx — Animated Sprite Component

| Export                     | Type / Signature                                                                                                                                                           | Behavior                                                                                                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CompanionSprite`          | `(props: { reaction: Accessor<string \| undefined>, setReaction: Setter<string \| undefined>, petAt: Accessor<number \| undefined>, config: Config.Info }) => JSX.Element` | Main sprite component. Creates 500ms tick interval. Renders wide (sprite + bubble) or narrow (face + name) based on terminal width. Manages pet hearts, idle animation sequence. Returns `null` when disabled or no companion. |
| `companionReservedColumns` | `(cols: number, speaking: boolean, companion: Companion \| undefined) => number`                                                                                           | Returns number of columns the sprite area reserves. 0 if disabled, muted, or narrow terminal. Used by prompt for width calculation.                                                                                            |

**Internal signals:**

- `tick: number` — incremented every 500ms
- `reaction: string | undefined` — current speech bubble text
- `petAt: number | undefined` — timestamp of last pet (for heart animation)
- `bubbleStartTick: number` — tick when current reaction appeared

**Constants:**

- `TICK_MS = 500`
- `BUBBLE_SHOW = 20` (ticks → ~10s)
- `FADE_WINDOW = 6` (last ~3s dims)
- `PET_BURST_MS = 2500`
- `MIN_COLS_FOR_FULL_SPRITE = 100`
- `IDLE_SEQUENCE = [0, 0, 0, 0, 1, 0, 0, 0, -1, 0, 0, 2, 0, 0, 0]`

### SpeechBubble.tsx — Bubble Component

| Export         | Type / Signature                                                                                  | Behavior                                                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SpeechBubble` | `(props: { text: string, color: RGBA, fading: boolean, tail: "down" \| "right" }) => JSX.Element` | Word-wraps text at 30 chars. Renders rounded border box. Fading dims border + text. Tail direction: "right" for wide layout (connector dash), "down" for narrow (backslash lines). |

### CompanionCard.tsx — Stat Card Component

| Export          | Type / Signature                                                                               | Behavior                                                                                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CompanionCard` | `(props: { companion: Companion, lastReaction?: string, onDone?: () => void }) => JSX.Element` | Bordered card showing: rarity stars + species header, shiny indicator, sprite (frame 0), name, personality quote, 5 stat bars (filled/empty blocks), last reaction if any. |

## Data Flow

### Flow 1: Companion Generation (Hatch via `/buddy`)

| Step | Component            | Action                                                                                            | Next             |
| ---- | -------------------- | ------------------------------------------------------------------------------------------------- | ---------------- |
| 1    | Command handler      | User types `/buddy` with no existing companion                                                    | companion.ts     |
| 2    | `generateSeed()`     | Creates `"rehatch-{ts}-{rand}"` seed string                                                       | `rollWithSeed()` |
| 3    | `rollWithSeed(seed)` | Hash seed → Mulberry32 → roll rarity, species, eye, hat, shiny, stats                             | Command handler  |
| 4    | Command handler      | Builds `StoredCompanion` with default name/personality from `SPECIES_NAMES`/`SPECIES_PERSONALITY` | Config           |
| 5    | Config update        | `sdk.client.config.update({ companion: stored })` persists soul + hatchedAt                       | UI               |
| 6    | Session route        | Config change triggers re-render, `CompanionSprite` appears in prompt `right` prop                | —                |

### Flow 2: Reaction Trigger (After Assistant Turn)

| Step | Component                  | Action                                                                                                                                   | Next                         |
| ---- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 1    | Session route              | `createEffect` detects assistant message `time.completed` changed from undefined                                                         | `triggerCompanionReaction()` |
| 2    | `triggerCompanionReaction` | Check: companion exists, not muted, rate limit (45s or @-mentioned)                                                                      | `buildTranscript()`          |
| 3    | `buildTranscript()`        | Last 12 messages → role:text pairs → 5000 char cap                                                                                       | Model resolution             |
| 4    | Model resolution           | Read `experimental.buddy_model` → `Provider.getModel()` → `Provider.getLanguage()`. Fall back to active session model if not configured. | `streamText()`               |
| 5    | `streamText()`             | System prompt (personality + stats) + transcript → LLM call (~200 tokens in, ~20 out)                                                    | Collect response             |
| 6    | Collect response           | Iterate `result.fullStream`, accumulate `text-delta` events into full string                                                             | Dedup check                  |
| 7    | Dedup check                | Compare against `recentReactions` (last 8). If duplicate, discard.                                                                       | `setReaction()`              |
| 8    | `setReaction(text)`        | Updates `reaction` signal in `CompanionSprite`                                                                                           | SpeechBubble renders         |
| 9    | `SpeechBubble`             | Shows for ~10s (20 ticks), fades over last ~3s (6 ticks), then clears                                                                    | —                            |

**Error Flow**: Any error in steps 4-6 is caught and swallowed (logged as warning). The UI never blocks. If model resolution fails (e.g., `buddy_model` references unconfigured provider), falls back to active session model. If that also fails, reaction is silently skipped.

### Flow 3: Animation Tick (500ms Interval)

| Step | Component         | Action                                                                                                                                | Next             |
| ---- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 1    | `CompanionSprite` | `setInterval(500)` increments `tick` signal                                                                                           | Frame selection  |
| 2    | Frame selection   | If reacting/petting: `tick % frameCount` (fast cycle). Else: `IDLE_SEQUENCE[tick % 15]` (mostly rest, occasional fidget, rare blink). | `renderSprite()` |
| 3    | `renderSprite()`  | Retrieves frame from `BODIES[species][frame]`, substitutes `{E}` → eye, applies hat                                                   | Render           |
| 4    | Blink handling    | If `IDLE_SEQUENCE` step is `-1`: use frame 0 but replace eye chars with `-`                                                           | Render           |
| 5    | Pet hearts        | If `petAt` within last 2.5s: prepend `PET_HEARTS[petAge % 5]` above sprite                                                            | Render           |
| 6    | Render            | `<text>` elements for each sprite line, colored by rarity                                                                             | —                |

### Flow 4: `/buddy` Command Dispatch

| Step | Component        | Action                                                                                                           | Next            |
| ---- | ---------------- | ---------------------------------------------------------------------------------------------------------------- | --------------- |
| 1    | Prompt component | User types `/buddy [subcommand]`, autocomplete matches registered slash command                                  | Command handler |
| 2    | Command handler  | Parse subcommand: `""`, `"pet"`, `"on"`, `"off"`                                                                 | Branch          |
| 3a   | `""` (no args)   | If no companion: hatch (Flow 1). If companion exists: show `CompanionCard` in dialog.                            | —               |
| 3b   | `"pet"`          | Set `petAt = Date.now()` → heart animation. Auto-unmute. Force `triggerCompanionReaction()` (bypass rate limit). | —               |
| 3c   | `"on"`           | `config.update({ companion_muted: false })`. Toast: "companion unmuted".                                         | —               |
| 3d   | `"off"`          | `config.update({ companion_muted: true })`. Toast: "companion muted".                                            | —               |

## Data Model

### TypeScript Types

| Entity            | Fields                                                                                                  | Relationships                                 | Constraints                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------- |
| `CompanionBones`  | `rarity: Rarity, species: Species, eye: Eye, hat: Hat, shiny: boolean, stats: Record<StatName, number>` | Derived from `Roll`                           | `stats` values 1-100; `hat` is `"none"` for common rarity; `shiny` is 1% chance |
| `CompanionSoul`   | `name: string, personality: string, seed?: string`                                                      | Stored in config as part of `StoredCompanion` | `name` ≤32 chars; `personality` ≤200 chars; `seed` present only after rehatch   |
| `StoredCompanion` | `name: string, personality: string, seed?: string, hatchedAt: number`                                   | Persisted in `config.companion`               | `hatchedAt` is `Date.now()` at hatch time                                       |
| `Companion`       | All of `CompanionBones` + `CompanionSoul` + `hatchedAt: number`                                         | Merged at runtime from bones + stored soul    | Bones regenerated on every read (never persisted) to prevent edit-cheating      |
| `Roll`            | `bones: CompanionBones, inspirationSeed: number`                                                        | Produced by `roll()` / `rollWithSeed()`       | Deterministic for same input; cached (single-entry) for hot-path performance    |

### Config Schema Additions

```typescript
// In src/config/config.ts — inside the `experimental` z.object():

buddy: z
  .boolean()
  .optional()
  .describe("Enable the buddy companion system"),
buddy_model: z
  .object({
    providerID: z.string(),
    modelID: z.string(),
  })
  .optional()
  .describe("Override model for companion reactions (defaults to active session model)"),

// In src/config/config.ts — at the top level of Info z.object(), after existing fields:

companion: z
  .object({
    name: z.string(),
    personality: z.string(),
    seed: z.string().optional(),
    hatchedAt: z.number(),
  })
  .optional()
  .describe("Stored companion soul (bones regenerated from seed/userId)"),
companion_muted: z
  .boolean()
  .optional()
  .describe("Mute companion reactions"),
```

### Rarity Color Mapping (opencode theme keys)

| Rarity    | Source Theme Key | opencode Equivalent | Rationale                     |
| --------- | ---------------- | ------------------- | ----------------------------- |
| common    | `inactive`       | `textMuted`         | Subdued, default tier         |
| uncommon  | `success`        | `success`           | Green, slightly special       |
| rare      | `permission`     | `info`              | Blue/cyan, notable            |
| epic      | `autoAccept`     | `accent`            | Purple/accent, impressive     |
| legendary | `warning`        | `warning`           | Gold/yellow, maximum prestige |

## Integration Points

### 1. `packages/opencode/src/config/config.ts`

**Location**: Lines 1025-1109 (inside `experimental` z.object())

**Add** (after `ultrawork_model` at ~line 1107):

```typescript
buddy: z.boolean().optional().describe("Enable the buddy companion system"),
buddy_model: z
  .object({
    providerID: z.string(),
    modelID: z.string(),
  })
  .optional()
  .describe("Override model for companion reactions (defaults to active session model)"),
```

**Location**: Lines 1109-1110 (after `experimental` closes, before `.strict()`)

**Add** (top-level config fields):

```typescript
companion: z
  .object({
    name: z.string(),
    personality: z.string(),
    seed: z.string().optional(),
    hatchedAt: z.number(),
  })
  .optional(),
companion_muted: z.boolean().optional(),
```

**Impact**: ~12 lines added. No existing fields modified. Optional fields — no migration needed.

### 2. `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`

**Location**: Near line 1224 (Prompt render) and near line 137 (pending assistant memo)

**Add** (~20 lines total):

```tsx
// Import (top of file)
import { CompanionSprite, companionReservedColumns } from "@tui/buddy/CompanionSprite"
import { triggerCompanionReaction } from "@tui/buddy/react"

// After line 141 (lastAssistant memo) — reaction trigger effect:
const [companionReaction, setCompanionReaction] = createSignal<string | undefined>()
const [companionPetAt, setCompanionPetAt] = createSignal<number | undefined>()
const reactionAbort = new AbortController()
onCleanup(() => reactionAbort.abort()) // abort in-flight LLM call on unmount

createEffect(on(
  () => lastAssistant()?.time.completed,
  (completed) => {
    if (!completed) return
    if (!sync.data.config.experimental?.buddy) return
    triggerCompanionReaction(
      messages(),
      setCompanionReaction,
      sync.data.config,
      local.model.current(), // { providerID, modelID } — active session model as fallback
      reactionAbort.signal,
    )
  },
))

// At line 1232 (right prop of Prompt) — COMPOSE with existing plugin slot, not replace:
right={
  <box flexDirection="row" gap={1} flexShrink={0}>
    <Show when={sync.data.config.experimental?.buddy}>
      <CompanionSprite
        reaction={companionReaction}
        setReaction={setCompanionReaction}
        petAt={companionPetAt}
        config={sync.data.config}
      />
    </Show>
    <TuiPluginRuntime.Slot name="session_prompt_right" session_id={route.sessionID} />
  </box>
}
```

**Impact**: ~20 lines of integration. Companion renders **alongside** the existing `session_prompt_right` plugin slot (not replacing it). Wrapped in `<Show when>` guard — zero overhead when disabled.

### 3. `/buddy` Command Registration

**Location**: `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` — inside the `command.register()` call near line 390.

**Add** (appended to the existing command array):

```tsx
{
  title: "Buddy",
  value: "buddy",
  category: "Companion",
  hidden: !sync.data.config.experimental?.buddy,
  slash: {
    name: "buddy",
  },
  onSelect: async (dialog) => {
    // Dispatch to buddy command handler
    // See Flow 4 in Data Flow section
  },
},
```

**Impact**: ~20 lines. Hidden when feature flag is off.

### 4. System Prompt Injection

**Location**: `packages/opencode/src/session/system.ts` — add new export `companionPrompt()`

**Called from**: `packages/opencode/src/session/prompt.ts` — in the system prompt assembly (near line 1649 where `const system = [...env, ...(skills ? [skills] : []), ...instructions]`). Add `...companionPrompt(config)` to the array.

**Add to system.ts** (~8 lines):

```typescript
import { getCompanion } from "@/cli/cmd/tui/buddy/companion"
import { companionIntroText } from "@/cli/cmd/tui/buddy/prompt"

export function companionPrompt(config: Config.Info): string[] {
  if (!config.experimental?.buddy) return []
  if (config.companion_muted) return []
  const c = getCompanion()
  if (!c) return []
  return [companionIntroText(c.name, c.species)]
}
```

**Add to prompt.ts** (1 line, at system prompt assembly):

```typescript
const system = [...env, ...(skills ? [skills] : []), ...instructions, ...companionPrompt(config)]
```

**Impact**: ~8 lines in system.ts, ~1 line in prompt.ts. Returns empty array when disabled — zero overhead.

## Decisions

| Decision                      | Choice                                                               | Reason                                                                                                  | Alternatives                                                                 | Tradeoffs                                                                                           |
| ----------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Reaction model                | Local `streamText()` via Vercel AI SDK                               | Proprietary `buddy_react` API unavailable in opencode. Reuses existing provider infrastructure.         | Hardcoded responses, no reactions, separate HTTP endpoint                    | Costs tokens (~200 in, ~20 out per reaction). Mitigated by 45s rate limit.                          |
| Model fallback                | `buddy_model` config → active session model                          | Users may want a cheap/fast model for reactions. Fallback ensures it works without explicit config.     | Always use session model, always require explicit config                     | Session model may be expensive (e.g., Claude Opus). Config override provides escape hatch.          |
| Bones not persisted           | Regenerate from `seed`/`userId` on every read                        | Prevents edit-cheating (users can't edit config to get legendary). Allows species array changes.        | Persist full companion in config                                             | Slightly more CPU per read (mitigated by single-entry cache). Worth it for integrity.               |
| File location                 | `src/cli/cmd/tui/buddy/`                                             | All buddy code in one directory. Minimizes merge conflicts with hot files.                              | Spread across `src/companion/`, `src/cli/cmd/tui/component/companion/`       | Slightly deeper import paths. Worth it for isolation and rebase safety.                             |
| Animation tick rate           | 500ms (not 80ms)                                                     | Sprite animation doesn't need high framerate. 500ms matches source implementation and reduces CPU load. | 80ms (matches spinner), 250ms, 1000ms                                        | Animations are slightly chunky. Acceptable for ASCII art — charm, not smoothness.                   |
| Speech bubble in `right` prop | Inline beside sprite in wide mode                                    | opencode's `<Prompt>` already has a `right` prop slot rendered in the footer row. Natural integration.  | Floating overlay, separate panel, toast notification                         | Consumes horizontal space (~42 cols when speaking). Graceful collapse to narrow mode at <100 cols.  |
| Companion card as dialog      | Rendered via `dialog.replace()` in command handler                   | Matches existing pattern for `/share`, `/timeline`, etc. Dismissible with any key.                      | Inline in message stream, separate route, toast                              | Blocks prompt input while visible. Acceptable — card is informational, dismissed with one keypress. |
| Rehatch via seed              | `generateSeed()` creates random seed, stored in `CompanionSoul.seed` | Allows rehatch without changing userId. Deterministic from seed.                                        | Always derive from userId (no rehatch), random companion (non-deterministic) | Users can rehatch but lose their original companion. Stored seed overrides userId derivation.       |

## Risks

| Risk                           | Impact                                                     | Likelihood | Mitigation                                                                                                    |
| ------------------------------ | ---------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------- |
| LLM call latency               | Reaction appears 1-5s after turn completes                 | High       | Fire-and-forget — never blocks UI or session turn. Bubble appears when ready.                                 |
| Token cost accumulation        | Each reaction ~220 tokens. Active user: ~80 reactions/hour | Med        | 45s rate limit caps at ~80/hour. `buddy_model` override allows cheap model. Feature flag to disable entirely. |
| Model not configured           | `buddy_model` references unavailable provider/model        | Med        | Fall back to active session model. Log warning. If both fail, silently skip reaction.                         |
| Terminal width pressure        | Sprite (12 cols) + bubble (34 cols) = ~46 cols reserved    | Med        | Graceful collapse: <100 cols → one-line face + name. `companionReservedColumns()` returns 0 for narrow.       |
| Config schema bloat            | 4 new optional fields in config                            | Low        | All optional, no migration needed. `companion` and `companion_muted` only populated after first hatch.        |
| Sprite rendering in non-UTF8   | ASCII art may misalign in terminals without UTF-8 support  | Low        | Sprites use basic ASCII + limited Unicode (hearts, stars). Same risk as existing TUI elements.                |
| Reaction dedup false positive  | 8-entry cache may suppress valid similar reactions         | Low        | Exact string match only. 8 entries is small enough to cycle through quickly.                                  |
| Race condition on config write | Concurrent hatch + mute toggle could conflict              | Low        | Config updates are serialized through `sdk.client.config.update()`. Same pattern as existing config writes.   |

## Test Plan

### Unit Tests

#### `test/cli/tui/buddy/companion.test.ts` (~60 lines)

- **Determinism**: Same `userId` always produces same `CompanionBones` (species, rarity, eye, hat, shiny, stats)
- **Different users**: Different `userId` values produce different companions
- **Cache hit**: Calling `roll()` twice with same userId returns cached result (reference equality)
- **Cache miss**: Calling `roll()` with different userId replaces cache
- **Rarity distribution**: Over 10,000 rolls, rarity proportions approximate weights (±5%)
- **Stats range**: All stat values are 1-100 inclusive
- **Stats shape**: Exactly one peak stat (≥floor+50), exactly one dump stat (≤floor+5)
- **Shiny rate**: Over 10,000 rolls, shiny rate is ~1% (±0.5%)
- **`rollWithSeed`**: Arbitrary seed produces valid `CompanionBones`
- **`getCompanion`**: Returns `undefined` when no companion in config
- **`getCompanion`**: Returns merged `Companion` when `StoredCompanion` exists in config

#### `test/cli/tui/buddy/sprites.test.ts` (~40 lines)

- **Frame count**: Every species has exactly 3 frames
- **Frame dimensions**: Every frame is exactly 5 lines
- **Eye substitution**: `{E}` placeholder is replaced with the eye character
- **Hat rendering**: Non-`"none"` hat replaces line 0 content
- **`renderFace`**: Returns a string containing the eye character
- **All species covered**: `BODIES` has entries for all 18 species

#### `test/cli/tui/buddy/react.test.ts` (~80 lines)

- **Rate limiting**: Second call within 45s is skipped (no LLM call made)
- **Rate limit bypass**: @-mention bypasses rate limit
- **@-mention detection**: `isAddressed()` finds name in last 3 user messages (case-insensitive, word-boundary)
- **@-mention negative**: Does not trigger on partial matches or assistant messages
- **Transcript building**: `buildTranscript()` includes last 12 messages, caps at 5000 chars
- **Transcript truncation**: Individual messages truncated to 300 chars
- **Transcript empty**: Returns empty string for empty message array
- **Dedup**: Duplicate reaction text is discarded (not passed to `setReaction`)
- **Dedup buffer**: After 8 unique reactions, oldest is evicted
- **Muted skip**: Returns immediately when `companion_muted` is true
- **No companion skip**: Returns immediately when no companion exists
- **LLM error handling**: Errors in `streamText()` are caught and swallowed (mock rejects)

### Integration Tests

#### `test/cli/tui/buddy/command.test.ts` (~50 lines)

- **Hatch flow**: `/buddy` with no existing companion creates `StoredCompanion` in config
- **Hatch determinism**: Hatched companion has valid species, rarity, name, personality
- **Show existing**: `/buddy` with existing companion returns card data (not a new hatch)
- **Pet**: `/buddy pet` sets `petAt`, auto-unmutes, triggers reaction
- **Mute**: `/buddy off` sets `companion_muted: true`
- **Unmute**: `/buddy on` sets `companion_muted: false`
- **Feature gate**: Commands are hidden when `experimental.buddy` is false

### End-to-End Tests

Not required for Phase 1-4. The buddy system is entirely TUI-side with no server-side state beyond config persistence. Manual testing covers:

- **Critical journey**: Enable `experimental.buddy` → `/buddy` → see hatch output → companion appears beside prompt → send message → see reaction bubble → `/buddy pet` → see hearts → `/buddy off` → companion disappears
- **Narrow terminal**: Resize to <100 cols → companion collapses to one-line face

### Non-Functional Tests

- **Performance**: `roll()` cache hit should be <1μs (verified by running 100,000 calls in a loop, asserting <100ms total)
- **No overhead when disabled**: When `experimental.buddy` is false, zero `setInterval` timers created, zero LLM calls made, `CompanionSprite` returns `null`
- **Type safety**: `bun --cwd packages/opencode typecheck` must pass clean with all new files

## File Manifest

| File                                                          | Purpose                                                  | Approx Lines |
| ------------------------------------------------------------- | -------------------------------------------------------- | ------------ |
| `packages/opencode/src/cli/cmd/tui/buddy/types.ts`            | Types, constants, rarity weights, species, color mapping | ~120         |
| `packages/opencode/src/cli/cmd/tui/buddy/companion.ts`        | Mulberry32 PRNG, roll(), getCompanion(), cache           | ~140         |
| `packages/opencode/src/cli/cmd/tui/buddy/sprites.ts`          | 18×3 ASCII frames, renderSprite(), renderFace()          | ~520         |
| `packages/opencode/src/cli/cmd/tui/buddy/prompt.ts`           | companionIntroText(), shouldInjectIntro()                | ~30          |
| `packages/opencode/src/cli/cmd/tui/buddy/react.ts`            | triggerCompanionReaction(), transcript, rate limit, LLM  | ~150         |
| `packages/opencode/src/cli/cmd/tui/buddy/CompanionSprite.tsx` | Animated sprite + speech bubble, wide/narrow             | ~280         |
| `packages/opencode/src/cli/cmd/tui/buddy/CompanionCard.tsx`   | Stat bars, rarity display, personality                   | ~100         |
| `packages/opencode/src/cli/cmd/tui/buddy/SpeechBubble.tsx`    | 30-char wrap, fade logic, tail direction                 | ~60          |
| `packages/opencode/test/cli/tui/buddy/companion.test.ts`      | Determinism, caching, stats tests                        | ~60          |
| `packages/opencode/test/cli/tui/buddy/sprites.test.ts`        | Frame count, eye/hat substitution tests                  | ~40          |
| `packages/opencode/test/cli/tui/buddy/react.test.ts`          | Rate limiting, transcript, dedup tests                   | ~80          |
| `packages/opencode/test/cli/tui/buddy/command.test.ts`        | Hatch, pet, mute toggle integration tests                | ~50          |
| **Total new files: 12**                                       |                                                          | **~1,630**   |

**Modified files (minimal integration):**

| File                                                         | Changes                                                                                    | Lines Added |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ----------- |
| `packages/opencode/src/config/config.ts`                     | 4 new optional Zod fields                                                                  | ~12         |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | Import, reaction effect + abort, CompanionSprite composed with plugin slot, /buddy command | ~40         |
| `packages/opencode/src/session/system.ts`                    | `companionPrompt()` export (conditional)                                                   | ~8          |
| `packages/opencode/src/session/prompt.ts`                    | Spread `companionPrompt(config)` into system prompt array                                  | ~1          |
| **Total modified: 4 files**                                  |                                                                                            | **~61**     |
