# HLD: Generic Provider Support (Zero Model-ID Hardcoding)

## Tech Stack

| Category    | Technology               | Purpose                                        |
| ----------- | ------------------------ | ---------------------------------------------- |
| Language    | TypeScript 5.8           | Existing codebase language                     |
| Schema      | Zod (v4)                 | Validation of reasoning_options, capabilities  |
| Data Source | models.dev registry JSON | External model metadata with reasoning_options |
| Runtime     | Bun 1.3.11               | Existing runtime                               |
| Testing     | bun test                 | Unit + integration validation                  |

## Components

| Component               | Responsibility                                   | Dependencies                                  |
| ----------------------- | ------------------------------------------------ | --------------------------------------------- |
| ReasoningOptions Schema | Parse/validate `reasoning_options` from registry | Zod, ModelsDev.Model                          |
| Capabilities Builder    | Map registry data → Provider.Model.capabilities  | ReasoningOptions Schema, fromModelsDevModel   |
| VariantGate             | Determine IF/WHAT effort variants exist (Tier 1) | Provider.Model.capabilities.reasoning_options |
| VariantShape            | Format variant objects per SDK protocol (Tier 2) | model.api.npm, effort values                  |
| ThinkingResolver        | Generic thinking enablement in options()         | reasoning_options, npm, providerID            |
| SchemaCompat            | Strict schema sanitization                       | schema_compat capability, providerID          |

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    models.dev Registry JSON                        │
│  { reasoning_options: [{type:"effort", values:[...]}], ... }      │
└───────────────────────────────┬────────────────────────────────────┘
                                │ parse
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│              models.ts — ModelsDev.Model Schema                    │
│  + reasoning_options: z.array(discriminatedUnion).optional()       │
└───────────────────────────────┬────────────────────────────────────┘
                                │ map
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│         provider.ts — fromModelsDevModel() Builder                 │
│  capabilities.reasoning_options = model.reasoning_options          │
│  capabilities.schema_compat = deriveSchemaCompat(provider.id)     │
└───────┬───────────────────────┬────────────────────┬──────────────┘
        │                       │                    │
        ▼                       ▼                    ▼
┌───────────────┐  ┌────────────────────┐  ┌────────────────────┐
│  variants()   │  │     options()      │  │     schema()       │
│               │  │                    │  │                    │
│ ┌───────────┐ │  │ ThinkingResolver   │  │ SchemaCompat gate  │
│ │VariantGate│ │  │ (capability-based) │  │ (strict sanitize)  │
│ └─────┬─────┘ │  │                    │  │                    │
│       ▼       │  └────────────────────┘  └────────────────────┘
│ ┌───────────┐ │
│ │VariantShape│ │
│ │(SDK switch)│ │
│ └───────────┘ │
└───────────────┘
```

**Description**: Data flows top-down from registry through schema validation into capabilities. Transform functions consume capabilities instead of model IDs. The `variants()` function splits into two tiers: a capability gate (data-driven, zero model-ID checks) and a shape formatter (SDK-protocol dispatch, retains npm switch for object format only). `options()` uses capability predicates instead of string matching. `schema()` uses `schema_compat` field instead of providerID checks. TransformCache remains untouched — it keys on `modelID + toolHash + sessionID`, and capabilities are baked into Provider.Model at build time (stable per model instance).

## Interfaces

### ReasoningOptions Schema (models.ts addition)

| Method         | Input                  | Output                           | Behavior                            | Errors                                             |
| -------------- | ---------------------- | -------------------------------- | ----------------------------------- | -------------------------------------------------- |
| (schema field) | raw JSON from registry | `ReasoningOption[] \| undefined` | Validates discriminated union array | Zod parse strips invalid entries via `.optional()` |

```ts
// Type signature only
type ReasoningOption =
  | { type: "toggle" }
  | { type: "effort"; values: string[] }
  | { type: "budget_tokens"; min: number; max?: number }
```

### Capabilities (provider.ts additions)

| Field             | Type                             | Source                           | Purpose                        |
| ----------------- | -------------------------------- | -------------------------------- | ------------------------------ |
| reasoning_options | `ReasoningOption[] \| undefined` | registry passthrough             | Drive variant/options dispatch |
| schema_compat     | `"standard" \| "strict"`         | `deriveSchemaCompat(providerID)` | Gate strict schema sanitizer   |

### deriveSchemaCompat (provider.ts helper)

| Method             | Input              | Output                   | Behavior                                     | Errors               |
| ------------------ | ------------------ | ------------------------ | -------------------------------------------- | -------------------- |
| deriveSchemaCompat | providerID: string | `"standard" \| "strict"` | Returns "strict" for moonshot/kimi providers | None (pure function) |

### variants() (transform.ts redesign)

| Method        | Input                                    | Output                                | Behavior                                                | Errors                       |
| ------------- | ---------------------------------------- | ------------------------------------- | ------------------------------------------------------- | ---------------------------- |
| variants      | model: Provider.Model                    | `Record<string, Record<string, any>>` | Two-tier dispatch: gate on capabilities, format per SDK | Returns `{}` on no-reasoning |
| variantsBySDK | model: Provider.Model, values?: string[] | `Record<string, Record<string, any>>` | SDK-specific shape formatting only                      | Returns `{}` for unknown SDK |

### options() (transform.ts generalization)

| Method  | Input                                | Output                | Behavior                              | Errors                           |
| ------- | ------------------------------------ | --------------------- | ------------------------------------- | -------------------------------- |
| options | {model, sessionID, providerOptions?} | `Record<string, any>` | Capability-driven thinking enablement | None (returns empty keys if N/A) |

### schema() (transform.ts addition)

| Method         | Input                                     | Output      | Behavior                                                 | Errors                          |
| -------------- | ----------------------------------------- | ----------- | -------------------------------------------------------- | ------------------------------- |
| schema         | model: Provider.Model, schema: JSONSchema | JSONSchema7 | Sanitize strict schemas before Gemini pass               | None (no-op for standard)       |
| sanitizeStrict | obj: unknown                              | unknown     | Strip extra keywords alongside $ref, flatten tuple items | None (pure recursive transform) |

## Data Flow

### Variant Generation (build time)

| Step | Component              | Action                                   | Next                            |
| ---- | ---------------------- | ---------------------------------------- | ------------------------------- |
| 1    | ModelsDev.get()        | Fetch/cache registry JSON                | Parse                           |
| 2    | ModelsDev.Model schema | Validate reasoning_options field         | Builder                         |
| 3    | fromModelsDevModel()   | Map reasoning_options → capabilities     | variants()                      |
| 4    | VariantGate (Tier 1)   | Check reasoning + opts type/length       | VariantShape or early return {} |
| 5    | VariantShape (Tier 2)  | Switch on model.api.npm → format objects | Store in model.variants         |

### Options Resolution (request time)

| Step | Component          | Action                                    | Next                 |
| ---- | ------------------ | ----------------------------------------- | -------------------- |
| 1    | Caller             | Invoke options({model, sessionID})        | ThinkingResolver     |
| 2    | ThinkingResolver   | Check capabilities.reasoning_options type | Emit thinking params |
| 3    | SDK-specific logic | Format thinking object per npm protocol   | Merge into result    |
| 4    | Return             | Merged options record                     | Provider SDK call    |

### Schema Sanitization (request time)

| Step | Component         | Action                                                   | Next                   |
| ---- | ----------------- | -------------------------------------------------------- | ---------------------- |
| 1    | Caller            | Invoke schema(model, rawSchema)                          | SchemaCompat gate      |
| 2    | SchemaCompat gate | Check `model.capabilities.schema_compat`                 | sanitizeStrict or skip |
| 3    | sanitizeStrict    | Recursively strip non-$ref siblings, flatten tuple items | Gemini sanitizer       |
| 4    | Gemini sanitizer  | Existing sanitization (unchanged)                        | Return                 |

**Error Flows**:

- **Registry parse failure**: Zod `.optional()` means invalid/missing `reasoning_options` → `undefined`. Fallback logic handles undefined gracefully.
- **Unknown SDK in variantsBySDK**: Falls through switch → returns `{}` (no variants). Safe default.
- **Untagged model (reasoning_options undefined)**:
  - First-party SDKs (openai, anthropic, google): Use existing SDK defaults as fallback.
  - openai-compatible: Return `{}` (no variants unless explicitly tagged).
- **schema_compat miss**: New strict provider not in `deriveSchemaCompat()` → schema passes unsanitized. API error surfaces to user. Fix: 1-line addition.

## Data Model

| Entity                                  | Fields                                                                       | Relationships                             | Constraints                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------- |
| ModelsDev.Model (extension)             | reasoning_options?: ReasoningOption[]                                        | Parent of Provider.Model capabilities     | Optional; Zod discriminatedUnion validates type field            |
| Provider.Model.capabilities (extension) | reasoning_options?: ReasoningOption[], schema_compat: "standard" \| "strict" | Derived from ModelsDev.Model + providerID | schema_compat defaults "standard"; reasoning_options passthrough |
| ReasoningOption (toggle)                | type: "toggle"                                                               | Member of reasoning_options array         | Discriminant: type literal                                       |
| ReasoningOption (effort)                | type: "effort", values: string[]                                             | Member of reasoning_options array         | values non-empty when present                                    |
| ReasoningOption (budget_tokens)         | type: "budget_tokens", min: number, max?: number                             | Member of reasoning_options array         | min >= 0                                                         |

**No DB migration** — all data is in-memory, derived at model load time.

## Decisions

| Decision                         | Choice                                             | Reason                                                                                    | Alternatives                     | Tradeoffs                                                                                                          |
| -------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Two-tier variant dispatch        | Gate on capabilities, shape by SDK                 | Separates "what" (data-driven) from "how" (protocol)                                      | Single capability-only dispatch  | Need npm switch for protocol differences (anthropic thinking vs openai reasoningEffort); keeps SDK shapes accurate |
| Passthrough reasoning_options    | Copy registry field verbatim to capabilities       | Zero transformation logic, registry is source of truth                                    | Normalize to internal enum       | More flexible; future registry additions auto-flow; avoids drift between internal/external types                   |
| Provider-level schema_compat     | Derive from providerID string                      | API constraint is provider-wide, not per-model                                            | Per-model flag from registry     | Registry doesn't have this data; provider-level is correct abstraction (all moonshot models share the strict API)  |
| Fallback for undefined opts      | First-party → SDK defaults; openai-compatible → {} | Prevents regression for untagged providers while enabling future auto-tagging             | Always return {}                 | First-party SDKs may have new models before registry tags them; SDK defaults are safe                              |
| Keep npm switch in variantsBySDK | Extract function, retain switch for shape only     | Each SDK has unique providerOptions shape (thinking vs reasoningConfig vs thinkingConfig) | Giant if/else on capability type | Switch is natural for protocol dispatch; model-ID checks removed from inside cases                                 |
| copilot special case kept        | Retain github-copilot switch case                  | Protocol-specific fields (reasoningSummary, include) not derivable from capabilities      | Force capability tagging         | Copilot not in registry; protocol is unique; revisit when tagged                                                   |

## Risks

| Risk                                  | Impact                                                       | Likelihood   | Mitigation                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Registry lag (new model not tagged)   | Model gets no variants until tagged                          | Medium       | First-party SDK fallback; user can set reasoningEffort in agent config manually                                                                |
| Claude regression (adaptive thinking) | Wrong variant shape for Claude models                        | Low          | Claude already has correct reasoning_options in registry; anthropic SDK branch unchanged for Claude path                                       |
| alibaba-cn 0% coverage                | All alibaba-cn models fallback to undefined path             | High (known) | Explicit fallback: `reasoning: true` + openai-compatible → enable_thinking (preserves current behavior exactly)                                |
| TransformCache invalidation           | Stale variants served after registry update                  | Low          | Cache keys include modelID; capabilities baked at fromModelsDevModel time; registry refresh rebuilds all models                                |
| Rebase conflict in variants()         | Upstream adds new model-ID check we've removed               | Medium       | Our generic version subsumes upstream's. On conflict: keep ours, verify model works via test. Helper extraction isolates from switch internals |
| deriveSchemaCompat incomplete         | New strict-schema provider not listed                        | Low          | 1-line fix per provider. Runtime symptom: API error with clear message. No silent corruption                                                   |
| openrouter/gateway dual-path          | These SDKs wrap other models, reasoning_options may conflict | Low          | Both have 100% registry coverage; their variant shapes already correct in current code; passthrough works                                      |

## Test Plan

### Unit Tests

**VariantGate logic** (pure function, no deps):

- `reasoning_options: []` → returns `{}`
- `reasoning_options: [{ type: "toggle" }]` → returns `{}`
- `reasoning_options: [{ type: "effort", values: ["low","high"] }]` → returns non-empty with correct levels
- `reasoning_options: [{ type: "budget_tokens", min: 128, max: 32768 }]` → returns budget-based variants
- `reasoning_options: undefined` + first-party SDK → uses SDK defaults
- `reasoning_options: undefined` + openai-compatible → returns `{}`
- `reasoning_options: [{ type: "toggle" }, { type: "effort", values: [...] }]` → uses effort values

**VariantShape logic** (per SDK):

- anthropic SDK + effort values → `{ thinking: { type: "adaptive" }, effort }` shape
- anthropic SDK + budget_tokens → `{ thinking: { type: "enabled", budgetTokens } }` shape
- openai SDK + effort values → `{ reasoningEffort, reasoningSummary: "auto" }` shape
- google SDK + budget_tokens → `{ thinkingConfig: { thinkingBudget } }` shape
- google SDK + effort values → `{ thinkingConfig: { thinkingLevel } }` shape
- bedrock SDK + effort → `{ reasoningConfig: { type: "adaptive" } }` shape
- unknown SDK → `{}`

**ThinkingResolver (options)**:

- Non-Claude model on anthropic SDK with toggle → enables thinking
- Claude model on anthropic SDK → does NOT enable thinking (handled elsewhere)
- alibaba-cn + reasoning + openai-compatible + opts undefined → `enable_thinking: true`
- alibaba-cn + reasoning + opts `[]` (always-on) → does NOT set enable_thinking
- baseten/opencode + interleaved object → sets chat_template_args

**SchemaCompat**:

- `schema_compat: "strict"` → strips non-$ref siblings, flattens tuple items
- `schema_compat: "standard"` → no-op (passthrough)
- Gemini sanitizer still runs after strict sanitizer

**deriveSchemaCompat**:

- providerID "moonshotai" → "strict"
- providerID "kimi-for-coding" → "strict"
- providerID "openai" → "standard"
- providerID "anthropic" → "standard"

### Integration Tests

**Regression suite** (load real models-snapshot):

- For every model in snapshot with known expected variants, verify `variants()` output matches current behavior
- Key models: claude-opus-4-6, gpt-5, gemini-2.5-pro, deepseek-v4, kimi-k2.5, glm-4.5, minimax-m3
- Verify `options()` output for known models matches current behavior
- Verify `schema()` output for moonshot models applies strict sanitizer

**TransformCache compatibility**:

- Verify cache key structure unchanged (modelID + toolHash + sessionID)
- Verify cached results for a model remain stable across calls
- Verify cache does NOT need invalidation when capabilities are static per model instance

### End-to-End Tests

**Critical user journeys**:

- Agent with Claude model → adaptive thinking variants appear in TUI
- Agent with GPT-5 model → effort selection works, reasoning summary returned
- Agent with Gemini-2.5 model → thinking budget variants work
- Agent with kimi-k2.5 on alibaba-cn → thinking enabled, reasoning extraction works
- Agent with untagged model on openai-compatible → gracefully degrades (no variants, manual config works)

### Non-Functional Tests

- **Performance**: `variants()` and `options()` must remain O(1) — no registry re-parsing at request time (capabilities pre-baked)
- **TransformCache hit rate**: No degradation from refactor (same cache keys, same model instances)
- **Typecheck**: `bun --cwd packages/opencode typecheck` passes with new schema additions
- **Backward compat**: All existing tests pass without modification (output-preserving refactor)
