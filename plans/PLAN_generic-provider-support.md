# Plan: Generic Provider Support (Zero Model-ID Hardcoding)

## Overview

Replace all model-ID string matching in `variants()`, `options()`, and `schema()` with data-driven dispatch from the `reasoning_options` field already emitted by models.dev registry. Future models from any provider work automatically if correctly tagged in registry.

## Tech Stack

- TypeScript, Zod schemas
- models.dev registry JSON (external data source)
- Provider.Model capabilities (in-memory, no DB migration)

## Testing Strategy

- Unit: mock models with various `reasoning_options` combos, verify `variants()`/`options()`/`schema()` output
- Integration: load real models-snapshot, verify no regression for existing providers
- Done when: `bun --cwd packages/opencode typecheck && bun --cwd packages/opencode test --timeout 30000` passes

## Phases

### Phase 1: Parse and Flow `reasoning_options`

- Step 1: Add `reasoning_options` to `ModelsDev.Model` schema in `models.ts` (line ~64)
- Step 2: Add `reasoning_options` + `schema_compat` to `Provider.Model.capabilities` schema in `provider.ts` (line ~877)
- Step 3: Map in `fromModelsDevModel()` (line ~1040) and config override block (line ~1199)
- Step 4: Add `deriveSchemaCompat()` helper in `provider.ts`

### Phase 2: `variants()` — Data-Driven Effort Levels

- Step 1: Remove model-ID blocklist (lines 553-565)
- Step 2: Add capability-based early returns at top of function
- Step 3: Replace model-ID checks inside npm switch cases with `reasoning_options.values` lookup
- Step 4: Retain npm switch for SHAPE only (how to format the variant object)

### Phase 3: `options()` — Generic Thinking Enablement

- Step 1: Replace kimi model-ID checks (lines 1013-1023) with capability check
- Step 2: Generalize alibaba-cn `enable_thinking` to all openai-compatible reasoning models with toggle
- Step 3: Generalize zhipuai thinking enablement to all models needing it

### Phase 4: `schema()` — Strict Schema Sanitizer

- Step 1: Add `sanitizeStrict()` function before Gemini sanitizer (line ~1207)
- Step 2: Gate on `model.capabilities.schema_compat === "strict"`

## Risks/Edge cases

- **alibaba-cn/opencode providers don't emit `reasoning_options`**: Need fallback for models with `undefined` reasoning_options (treat as "no control" for variants, infer thinking from `capabilities.reasoning + interleaved`)
- **Regression on Claude adaptive thinking**: Must NOT affect Claude models (they have `effort`/`budget_tokens` in reasoning_options, handled by existing anthropic adaptive code)
- **Registry lag**: New model appears but models.dev hasn't tagged it yet → use existing npm-switch as fallback for variant shape generation

---

## Detailed Design

### Data Model

Registry `reasoning_options` types observed in models.dev:

| Type                                                      | Meaning                              | Example Providers                                 |
| --------------------------------------------------------- | ------------------------------------ | ------------------------------------------------- |
| `undefined`                                               | Not tagged (fallback needed)         | alibaba-cn, opencode, many routers                |
| `[]` (empty)                                              | Always-on reasoning, no user control | deepseek-reasoner, minimax-m2.x, kimi-k2-thinking |
| `[{ type: "toggle" }]`                                    | Binary on/off                        | MiniMax-M3, kimi-k2.5+, GLM-4.5+, all zhipuai     |
| `[{ type: "effort", values: [...] }]`                     | Multi-level effort                   | OpenAI gpt-5+, o3/o4, Anthropic opus-4-7+         |
| `[{ type: "budget_tokens", min, max? }]`                  | Token budget control                 | Anthropic (older), Google gemini-2.5              |
| `[{ type: "toggle" }, { type: "effort", values: [...] }]` | Both toggle + effort                 | DeepSeek-v4                                       |

### Schema Changes

**`models.ts`** — add after `reasoning: z.boolean()`:

```ts
reasoning_options: z.array(z.discriminatedUnion("type", [
  z.object({ type: z.literal("toggle") }),
  z.object({ type: z.literal("effort"), values: z.array(z.string()) }),
  z.object({ type: z.literal("budget_tokens"), min: z.number(), max: z.number().optional() }),
])).optional(),
```

**`provider.ts` capabilities** — add after `interleaved`:

```ts
reasoning_options: z.array(z.discriminatedUnion("type", [
  z.object({ type: z.literal("toggle") }),
  z.object({ type: z.literal("effort"), values: z.array(z.string()) }),
  z.object({ type: z.literal("budget_tokens"), min: z.number(), max: z.number().optional() }),
])).optional(),
schema_compat: z.enum(["standard", "strict"]).default("standard"),
```

**`provider.ts` builder**:

```ts
// In fromModelsDevModel() after interleaved:
reasoning_options: model.reasoning_options,
schema_compat: deriveSchemaCompat(provider.id),
```

**`deriveSchemaCompat` helper**:

```ts
function deriveSchemaCompat(providerID: string): "standard" | "strict" {
  // Provider-level API constraint: all models on these APIs share strict schema validation
  if (providerID.startsWith("moonshot") || providerID.includes("kimi")) return "strict"
  return "standard"
}
```

---

### `variants()` Redesign

**Strategy**: Two-tier dispatch:

1. **Tier 1 (capability gate)**: Use `reasoning_options` to determine IF variants exist and what values
2. **Tier 2 (shape dispatch)**: Use `model.api.npm` to determine variant object SHAPE only

**New logic at top of `variants()`** (replaces lines 548-565):

```ts
export function variants(model: Provider.Model): Record<string, Record<string, any>> {
  if (!model.capabilities.reasoning) return {}

  const opts = model.capabilities.reasoning_options

  // === Tier 1: Capability-based gate ===

  // Explicitly tagged "no control" → no variants
  if (opts && opts.length === 0) return {}

  // Toggle-only → no effort variants (thinking controlled via options() defaults)
  if (opts && opts.every((o) => o.type === "toggle")) return {}

  // Has explicit effort values → use them
  const effort = opts?.find((o) => o.type === "effort")
  const values = effort?.values // e.g. ["low", "medium", "high"] or ["low", "medium", "high", "xhigh", "max"]

  // === Tier 2: Shape dispatch by SDK ===
  // `values` is either from registry or undefined (fallback to SDK defaults)
  return variantsBySDK(model, values)
}
```

**`variantsBySDK(model, values?)`** — extracted from current npm switch:

- Takes model + optional effort values
- Returns correctly-shaped variant objects based on `model.api.npm`
- If `values` provided → use those exact levels
- If `values` undefined → use SDK-appropriate defaults (existing behavior for untagged models)
- Claude detection uses `reasoning_options.type === "effort"` presence (not model ID)
- Anthropic adaptive detection uses `reasoning_options` containing effort with values including "max"

**What gets removed from model-ID checks**:

| Current Check                                    | Replacement                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `id.includes("deepseek-chat\|reasoner\|r1\|v3")` | `opts.length === 0`                                                                         |
| `id.includes("minimax")`                         | `opts.length === 0` (m2.x) or `opts.every(toggle)` (m3)                                     |
| `id.includes("glm")`                             | `opts.every(toggle)`                                                                        |
| `id.includes("kimi\|k2p")`                       | `opts.every(toggle)`                                                                        |
| `id.includes("qwen\|big-pickle")`                | `opts === undefined` + fallback (no variants for openai-compatible without explicit effort) |
| `id.includes("grok-3-mini")`                     | `opts` with effort values                                                                   |
| `anthropicOpus47OrLater(model.api.id)`           | `opts` containing effort with values `["low","medium","high","xhigh","max"]`                |
| `isAnthropicAdaptive`                            | `opts` containing effort values + budget_tokens                                             |
| `id.includes("deepseek-v4")`                     | `opts` containing effort `["high","max"]`                                                   |
| `id === "o1-mini"`                               | Registry `reasoning_options: []` or untagged → fallback                                     |
| `id === "gpt-5-pro"`                             | Registry effort has only `["high"]` → generates single variant                              |
| Mistral IDs                                      | Registry tags mistral models correctly                                                      |

**Fallback for `undefined` reasoning_options**:

- If `model.api.npm` is `@ai-sdk/openai-compatible` and `opts` is undefined → return `{}` (no variants)
  - Rationale: openai-compatible providers that support effort WILL have `reasoning_options` tagged. If missing, assume no support.
- If `model.api.npm` is a first-party SDK (`@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`) and `opts` is undefined → use SDK defaults
  - Rationale: first-party providers may have new models not yet tagged in models.dev registry

---

### `options()` Thinking Enablement

**Current hardcoded blocks to replace**:

| Lines     | Current                                                                                                          | Generic Replacement                                                                                                                                        |
| --------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 984-989   | `providerID === "baseten" \|\| (providerID === "opencode" && ["kimi-k2-thinking", "glm-4.6"].includes(api.id))`  | `providerID === "baseten" \|\| (providerID === "opencode" && model.capabilities.reasoning && model.capabilities.interleaved)`                              |
| 991-996   | `["zai", "zhipuai"].includes(providerID) && npm === "@ai-sdk/openai-compatible"`                                 | Keep as-is (provider-protocol, not model-specific). OR: generalize to any openai-compatible model with toggle reasoning that needs explicit thinking param |
| 1013-1023 | `npm === anthropic && (modelId.includes("k2p") \|\| modelId.includes("kimi-k2."))`                               | `npm === anthropic && opts?.some(toggle) && !api.id.includes("claude")`                                                                                    |
| 1030-1037 | `providerID === "alibaba-cn" && reasoning && npm === openai-compatible && !modelId.includes("kimi-k2-thinking")` | `providerID === "alibaba-cn" && reasoning && npm === openai-compatible && opts?.length !== 0`                                                              |

**Generic thinking enablement rule**:

```ts
// Non-Claude models on anthropic SDK with controllable reasoning → enable thinking
if (
  (npm === "@ai-sdk/anthropic" || npm === "@ai-sdk/google-vertex/anthropic") &&
  opts?.some((o) => o.type === "toggle") &&
  !model.api.id.includes("claude")
) {
  result["thinking"] = {
    type: "enabled",
    budgetTokens: Math.min(16_000, Math.floor(model.limit.output / 2 - 1)),
  }
}

// DashScope models with reasoning that have controllable thinking
if (
  model.providerID === "alibaba-cn" &&
  model.capabilities.reasoning &&
  npm === "@ai-sdk/openai-compatible" &&
  !(opts && opts.length === 0) // not always-on (empty = no control = already enabled)
) {
  result["enable_thinking"] = true
}

// vLLM/baseten/opencode hosted models that need chat_template_args
if (
  (model.providerID === "baseten" || model.providerID === "opencode") &&
  model.capabilities.reasoning &&
  typeof model.capabilities.interleaved === "object" // needs reasoning extraction
) {
  result["chat_template_args"] = { enable_thinking: true }
}
```

---

### `schema()` Strict Sanitizer

**Add before Gemini sanitizer** (line ~1208):

```ts
if (model.capabilities.schema_compat === "strict") {
  const sanitize = (obj: unknown): unknown => {
    if (obj === null || typeof obj !== "object") return obj
    if (Array.isArray(obj)) return obj.map(sanitize)
    if ("$ref" in obj && typeof (obj as any).$ref === "string") return { $ref: (obj as any).$ref }
    const result = Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, sanitize(v)]))
    if (Array.isArray(result.items)) result.items = result.items[0] ?? {}
    return result
  }
  const sanitized = sanitize(schema)
  if (typeof sanitized === "object" && sanitized !== null && !Array.isArray(sanitized)) {
    schema = sanitized as typeof schema
  }
}
```

---

### Temperature/TopP/TopK (Lower Priority)

These remain model-family based. Partial improvement: use `model.family` from registry instead of `id.includes()`:

```ts
// Current: if (id.includes("minimax-m2")) return 1.0
// Better:  if (model.family === "minimax") return 1.0
```

But `model.family` isn't currently in `Provider.Model`. Could add it (it's already in `fromModelsDevModel()` line 1006). Low priority since these don't BREAK anything, just suboptimal defaults.

---

## Rebase Safety Analysis

| Change                                    | Location                                        | Risk       | Strategy                                                                                    |
| ----------------------------------------- | ----------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------- |
| `reasoning_options` schema in models.ts   | Fork-only file (upstream moved to separate pkg) | **None**   | No conflict possible                                                                        |
| capabilities additions in provider.ts     | Additive fields                                 | **Low**    | Won't conflict with upstream field additions                                                |
| `fromModelsDevModel` mapping              | One line addition                               | **Low**    | Additive                                                                                    |
| `variants()` blocklist removal            | Same area upstream modifies                     | **Medium** | Our version SUBSUMES upstream's. On conflict: keep ours, verify no model regresses          |
| `variants()` npm switch → `variantsBySDK` | Restructured but same logic                     | **Medium** | Extracting to helper isolates from upstream changes to switch internals                     |
| `options()` thinking block                | Same area upstream modifies                     | **Medium** | Capability check is strictly simpler. On conflict: our version handles all upstream's cases |
| `schema()` sanitizer                      | New block above Gemini                          | **Low**    | Independent of Gemini code upstream maintains                                               |

**Key rebase principle**: All changes either (a) live in fork-only files, (b) are additive in stable locations, or (c) replace upstream's model-ID checks with a SIMPLER version that handles all the same cases. Conflicts resolve by keeping our generic version.

---

## Implementation Order (Dependencies)

```
Phase 0 (prerequisite — do first)
  └── SDK version bumps + typecheck + test

Phase 1 (prerequisite)
  ├── Step 1: models.ts schema
  ├── Step 2: provider.ts capabilities schema
  ├── Step 3: fromModelsDevModel mapping
  └── Step 4: deriveSchemaCompat helper

Phase 2 (depends on Phase 1) ─── Phase 3 (depends on Phase 1) ─── Phase 4 (depends on Phase 1)
  variants() redesign              options() generics              schema() sanitizer
  [can be parallel]                [can be parallel]              [can be parallel]
```

Phases 2, 3, 4 are independent — can be implemented in parallel after Phase 1.

---

## What We Explicitly Do NOT Change

- `applyCaching()` / `toolCaching()` / TransformCache — fork-perf caching already generic by SDK
- `normalizeMessages()` — already uses `interleaved` capability generically
- Provider SDK instantiation code — protocol-level, not model-level
- `sdkKey()` mapping — SDK identity, correctly scoped
- `kimi.txt` system prompt loading — content concern, not provider behavior

---

## Coverage Audit: Tool Calling & Caching Safety

### Tool Calling

**No breakage**. The plan touches tool calling in exactly ONE place: `schema()`.

| Concern                                | Impact   | Rationale                                                                                                                                                           |
| -------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema sanitizer activates incorrectly | **None** | Only fires for `schema_compat === "strict"`, derived from providerID (`moonshot*`, `*kimi*`). No other provider affected.                                           |
| Sanitizer breaks valid schemas         | **None** | Only strips (a) keywords alongside `$ref` (already rejected by these APIs) and (b) tuple `items` (already unsupported). Removing them makes schemas pass, not fail. |
| Tool caching regresses                 | **None** | `toolCaching()` is completely untouched. Gated on `isAnthropicLike` (npm-based check).                                                                              |
| Tool registry lookup changes           | **None** | `prompt.ts` call sites just pass model to `schema()` — capabilities flow naturally.                                                                                 |

### Caching

**No breakage**. All caching mechanisms are explicitly preserved:

| Mechanism                              | Gated By                                                  | Plan Impact                                                                                    |
| -------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `applyCaching()` (message breakpoints) | Provider npm/ID (anthropic, alibaba, openrouter, claude)  | **Unchanged**                                                                                  |
| `toolCaching()` (tool breakpoints)     | `isAnthropicLike` (anthropic, bedrock, vertex)            | **Unchanged**                                                                                  |
| `TransformCache` (LRU memoization)     | model.id + session key                                    | **Unchanged** — `reasoning_options` is baked into capabilities at build time, stable per model |
| `promptCacheKey`                       | Provider ID (openai, opencode, venice, azure, openrouter) | **Unchanged**                                                                                  |
| 1h TTL (`ENABLE_PROMPT_CACHING_1H`)    | Environment variable                                      | **Unchanged**                                                                                  |
| Cache slot allocation (3 vs 4)         | `hasToolSlot` (anthropic-like providers)                  | **Unchanged**                                                                                  |

**Why caching can't regress**: The plan modifies `variants()`, `options()`, and `schema()` — none of which participate in the caching pipeline. Caching is applied in `message()` (after transforms) and `toolCaching()` (at prompt assembly). Different call sites, different data flow.

---

## Coverage Audit: Future Model Support

### Registry Coverage Reality

| Provider          | SDK                         | reasoning_options Coverage | Future-Safe?                              |
| ----------------- | --------------------------- | -------------------------- | ----------------------------------------- |
| anthropic         | @ai-sdk/anthropic           | 100% (native)              | ✅ New Claude models auto-work            |
| openai            | @ai-sdk/openai              | 52% (growing)              | ✅ First-party, fallback to SDK defaults  |
| google            | @ai-sdk/google              | 47% (growing)              | ✅ First-party, fallback to SDK defaults  |
| deepseek          | @ai-sdk/openai-compatible   | 100%                       | ✅ Fully tagged                           |
| minimax           | @ai-sdk/anthropic           | 100%                       | ✅ Fully tagged                           |
| kimi-for-coding   | @ai-sdk/anthropic           | 100%                       | ✅ Fully tagged                           |
| zhipuai/zai (GLM) | @ai-sdk/openai-compatible   | 100%                       | ✅ Fully tagged                           |
| moonshotai        | @ai-sdk/openai-compatible   | 50% (growing)              | ⚠️ Older models untagged, new ones tagged |
| **alibaba-cn**    | @ai-sdk/openai-compatible   | **0%**                     | ⚠️ Needs fallback strategy                |
| **opencode**      | @ai-sdk/openai-compatible   | **3%**                     | ⚠️ Needs fallback strategy                |
| openrouter        | @openrouter/ai-sdk-provider | 100%                       | ✅ Fully tagged                           |
| bedrock           | @ai-sdk/amazon-bedrock      | 100%                       | ✅ Fully tagged                           |
| azure             | @ai-sdk/azure               | 98%                        | ✅ Nearly complete                        |

### Fallback Strategy for Untagged Providers (alibaba-cn, opencode)

These providers aggregate models from many sources but don't publish `reasoning_options`. Strategy:

**`variants()`**: If `reasoning_options` is `undefined`:

- First-party SDKs (`@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`) → use existing SDK-based defaults
- `@ai-sdk/openai-compatible` → return `{}` (no variants unless explicitly tagged)
- This is SAFE because: if a model on openai-compatible supports effort control but isn't tagged, the user can still pass effort via agent config (`"reasoningEffort": "high"` in opencode.json)

**`options()` thinking**: If `reasoning_options` is `undefined`:

- alibaba-cn: current rule uses `capabilities.reasoning` — keep it. The rule becomes: "if reasoning capability AND openai-compatible AND NOT explicitly empty opts → enable thinking"
- This means a new model on alibaba-cn with `reasoning: true` automatically gets `enable_thinking: true`. Only models with `reasoning_options: []` (explicitly always-on) are excluded.
- opencode: uses `interleaved` field as signal (if model has interleaved reasoning, it needs chat_template_args)

**`schema()`**: Provider-level, not model-level. All models on `moonshotai*`/`*kimi*` get sanitized. Future kimi/moonshot models auto-covered.

### Future Model Scenarios (Zero Code Change Required)

| Scenario                                | What Happens                                                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| MiniMax-M4 released on minimax provider | Registry tags it with `reasoning_options`. If `[toggle]` → thinking enabled, no variants. If `[effort, values]` → generates variants.         |
| Kimi-K3 on kimi-for-coding              | Tagged `[toggle]` → thinking enabled on anthropic SDK. `schema_compat: "strict"` from providerID.                                             |
| New GLM-6 on zhipuai                    | Tagged `[toggle]` → zhipuai thinking param sent. No variants.                                                                                 |
| DeepSeek-V5 on deepseek                 | Tagged with effort values → variants generated. Interleaved if present.                                                                       |
| New model on alibaba-cn                 | `reasoning: true` → `enable_thinking` sent. `interleaved` if present → reasoning extraction.                                                  |
| New model on opencode gateway           | `reasoning: true` + `interleaved` → `chat_template_args`. Otherwise basic.                                                                    |
| OpenAI GPT-6                            | First-party SDK, tagged with effort → variants auto-generated.                                                                                |
| Gemini-4 on @ai-sdk/google              | If tagged `effort` → `thinkingLevel` variants. If tagged `budget_tokens` → `thinkingBudget` variants. Values from registry.                   |
| Brand new provider X                    | If uses `@ai-sdk/openai-compatible` + tags `reasoning_options` → works. If strict schema → add providerID to `deriveSchemaCompat()` (1 line). |

### Google/Gemini Coverage (Detailed)

Current code uses `id.includes("2.5")` / `id.includes("3.1")` to choose between `thinkingBudget` vs `thinkingLevel`. With the plan:

| Model                | reasoning_options                                        | Variant Shape Generated                                            |
| -------------------- | -------------------------------------------------------- | ------------------------------------------------------------------ |
| gemini-2.5-pro       | `[{ budget_tokens, min:128, max:32768 }]`                | `{ thinkingConfig: { includeThoughts: true, thinkingBudget: N } }` |
| gemini-2.5-flash     | `[toggle, { budget_tokens, min:0, max:24576 }]`          | `{ thinkingConfig: { includeThoughts: true, thinkingBudget: N } }` |
| gemini-3-pro-preview | `[{ effort, values:["low","high"] }]`                    | `{ thinkingConfig: { includeThoughts: true, thinkingLevel: V } }`  |
| gemini-3.1-pro       | `[{ effort, values:["low","medium","high"] }]`           | `{ thinkingConfig: { includeThoughts: true, thinkingLevel: V } }`  |
| gemini-3.5-flash     | `[{ effort, values:["minimal","low","medium","high"] }]` | `{ thinkingConfig: { includeThoughts: true, thinkingLevel: V } }`  |
| gemma-4 (untagged)   | `undefined`                                              | `{}` (no variants -- correct, gemma doesn't control thinking)      |

**Shape dispatch rule for Google SDK**:

- `reasoning_options` has `budget_tokens` → use `thinkingBudget` with `min`/`max` bounds from registry
- `reasoning_options` has `effort` → use `thinkingLevel` with exact values from registry
- Both eliminate the `id.includes("2.5")` / `id.includes("3.1")` checks entirely
- Untagged Google models (gemma, image-preview) → no variants (correct behavior)

### The One Remaining Code-Change Point

`deriveSchemaCompat()` requires a code change if a NEW provider (not moonshot/kimi) has strict schema requirements. This is unavoidable without:

- Adding `schema_compat` to the models.dev Provider-level schema (not just Model)
- Or: detecting strict schema from runtime errors (too complex, fragile)

Mitigation: This is a ONE-LINE addition per new strict provider. And it's rare — only Moonshot's API has this constraint currently.

### Gateway/Router SDKs (Currently Unhandled)

These SDKs exist in the registry but have NO `reasoning_options` tagging and are NOT in the current `variants()` switch:

| SDK                             | Provider              | Models          | Current Behavior                   | Plan Behavior                             |
| ------------------------------- | --------------------- | --------------- | ---------------------------------- | ----------------------------------------- |
| `@ai-sdk/vercel`                | v0                    | 3 (tagged `[]`) | Falls through switch → no variants | `opts.length === 0` → no variants ✅      |
| `@aihubmix/ai-sdk-provider`     | aihubmix              | 50 (0% tagged)  | Falls through → no variants (bug?) | `opts === undefined` → no variants (safe) |
| `ai-gateway-provider`           | cloudflare-ai-gateway | 27 (0% tagged)  | Falls through → no variants        | `opts === undefined` → no variants (safe) |
| `gitlab-ai-provider`            | gitlab                | 18 (0% tagged)  | Falls through → no variants        | `opts === undefined` → no variants (safe) |
| `merge-gateway-ai-sdk-provider` | merge-gateway         | 59 (0% tagged)  | Falls through → no variants        | `opts === undefined` → no variants (safe) |

**These are all proxy/gateway providers** that re-expose other models (Claude, GPT, Gemini, etc.) under their own SDK. Since they have 0% `reasoning_options` coverage and the plan's fallback for unknown SDKs with `undefined` opts is `return {}`, behavior is preserved (no regression).

When/if these registries start tagging `reasoning_options`, variants will auto-appear — zero code change.

### GitHub Copilot (Special Case)

`@ai-sdk/github-copilot` is NOT in the registry — it's configured programmatically. Current code has a dedicated switch case with model-ID checks inside (`model.id.includes("gemini")`, `model.id.includes("claude")`).

**Plan approach**: Keep the copilot switch case for SHAPE (it adds `reasoningSummary: "auto"` + `include: ["reasoning.encrypted_content"]` which is protocol-specific). BUT: if copilot models can flow through with `reasoning_options` from some source, the ID checks inside the case become unnecessary. For now, copilot remains a special case — revisit when/if copilot models get capability tagging.

---

## SDK Version Updates (Pre-requisite)

Local main is behind upstream on key SDKs. Bump BEFORE implementing:

| Package                       | Local   | Upstream | Delta      | Risk                                   |
| ----------------------------- | ------- | -------- | ---------- | -------------------------------------- |
| `@ai-sdk/anthropic`           | 3.0.71  | 3.0.82   | 11 patches | Adaptive thinking API may have changed |
| `@ai-sdk/google`              | 3.0.63  | 3.0.73   | 10 patches | thinkingLevel/thinkingBudget API       |
| `@ai-sdk/google-vertex`       | 4.0.112 | 4.0.128  | 16 patches | Same                                   |
| `@ai-sdk/amazon-bedrock`      | 4.0.96  | 4.0.112  | 16 patches | reasoningConfig shape                  |
| `@openrouter/ai-sdk-provider` | 2.8.1   | 2.9.0    | Minor bump | New routing features                   |
| `venice-ai-sdk-provider`      | 2.0.1   | 2.0.2    | 1 patch    | Trivial                                |

**Why bump first**: Plan dispatches on capability data, not SDK internals — so it's version-independent in design. But newer SDKs may:

- Support providerOptions keys our variant shapes emit (e.g., newer `@ai-sdk/anthropic` supports `effort` param directly)
- Fix bugs with unknown option passthrough
- Add new providerOptions that we'd want to generate

**Action**: Run `bun update @ai-sdk/anthropic @ai-sdk/google @ai-sdk/google-vertex @ai-sdk/amazon-bedrock @openrouter/ai-sdk-provider venice-ai-sdk-provider` then typecheck + test before starting implementation.

**Note**: All changes are patch-level (no breaking changes). The API surface needed by this plan (`thinking.type`, `effort`, `budgetTokens`, `thinkingConfig.thinkingLevel/thinkingBudget`) is already present in currently installed versions. Phase 0 is optional but recommended for bug fixes.
