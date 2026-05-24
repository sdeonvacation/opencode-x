# HLD: Local LLM Quick Wins

## Tech Stack

| Category  | Technology         | Purpose                                      |
| --------- | ------------------ | -------------------------------------------- |
| Language  | TypeScript 5.8     | Type-safe, branded types for IDs             |
| Framework | Effect-ts 4.0-beta | Structured async, service injection, yield\* |
| Runtime   | Bun 1.3.11         | Native TS execution, bun:test                |
| AI SDK    | Vercel AI SDK 6.x  | LLM.stream for title/compaction/complete     |
| Config    | Zod schemas        | `hybrid.enabled` + `hybrid.cheap_model` gate |

## Components

| Component          | Responsibility                                        | Dependencies                          |
| ------------------ | ----------------------------------------------------- | ------------------------------------- |
| **resolveLocal**   | Shared helper: resolve local model from hybrid config | Provider, Config                      |
| **ensureTitle**    | Title generation model resolution (Phase 1)           | resolveLocal, Provider, Agent         |
| **compaction**     | Compaction model resolution (Phase 2)                 | resolveLocal, Provider, Agent, Config |
| **complete**       | Summary/complete model resolution (Phase 3)           | resolveLocal, Provider, Config        |
| **shouldCompress** | Compression threshold gate (Phase 4)                  | (pure function)                       |
| **templateFor**    | Compression template selection (Phase 4)              | (pure function)                       |

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     Config.hybrid                        │
│  { enabled: bool, cheap_model?: { providerID, modelID } │
└──────────────┬───────────────────────────────────────────┘
               │
               ▼
    ┌─────────────────────┐
    │   resolveLocal()    │  ← new shared helper
    │  Config → Model?    │
    └────┬────┬────┬──────┘
         │    │    │
    ┌────┘    │    └────┐
    ▼         ▼         ▼
┌────────┐ ┌────────┐ ┌──────────┐
│ title  │ │compact │ │ complete │   Phases 1-3: model resolution
│ (P1)   │ │ (P2)   │ │  (P3)    │
└────────┘ └────────┘ └──────────┘

┌──────────────────────────────────────┐
│ shouldCompress / templateFor  (P4)   │  Phase 4: pure fn additions
│ + webfetch, websearch entries        │
└──────────────────────────────────────┘
```

**Description:** All 4 phases are surgical edits to existing model resolution chains. Phases 1-3 share a common pattern: check `hybrid.enabled` + `hybrid.cheap_model`, resolve via `Provider.getModel()`, fall through on failure. This is extracted into a single `resolveLocal` helper to avoid duplication. Phase 4 is independent — pure function additions to `shouldCompress` and `templateFor` with no config dependency.

## Interfaces

### resolveLocal (new helper)

| Method         | Input              | Output                        | Behavior                                                                                                                                             | Errors                                                          |
| -------------- | ------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `resolveLocal` | `cfg: Config.Info` | `Provider.Model \| undefined` | If `cfg.hybrid?.enabled && cfg.hybrid?.cheap_model`, call `Provider.getModel(providerID, modelID)`. Return model on success, `undefined` on failure. | Catches provider errors → returns `undefined` (silent fallback) |

**Location:** `src/session/prompt.ts` — module-level async function (used by `ensureTitle` and `complete`). Also duplicated or imported in `compaction.ts`.

**Signature (Effect context — prompt.ts):**

```typescript
function resolveLocal(provider: Provider.Service["Type"], cfg: Config.Info): Effect.Effect<Provider.Model | undefined> {
  if (!cfg.hybrid?.enabled || !cfg.hybrid?.cheap_model) return Effect.succeed(undefined)
  const ref = cfg.hybrid.cheap_model
  return provider
    .getModel(ProviderID.make(ref.providerID), ModelID.make(ref.modelID))
    .pipe(Effect.option, Effect.map(Option.getOrUndefined))
}
```

**Signature (async context — complete()):**

```typescript
async function resolveLocalAsync(cfg: Config.Info): Promise<Provider.Model | undefined> {
  if (!cfg.hybrid?.enabled || !cfg.hybrid?.cheap_model) return undefined
  const ref = cfg.hybrid.cheap_model
  try {
    return await Provider.getModel(ProviderID.make(ref.providerID), ModelID.make(ref.modelID))
  } catch {
    return undefined
  }
}
```

**Design decision:** Two variants needed because `ensureTitle`/`compaction` run in Effect.gen (yield\*) while `complete()` runs inside `Effect.promise` (async). The logic is identical — only the execution context differs.

### shouldCompress (modified)

| Method           | Input                          | Output    | Behavior                                                          | Errors      |
| ---------------- | ------------------------------ | --------- | ----------------------------------------------------------------- | ----------- |
| `shouldCompress` | `output: string, tool: string` | `boolean` | Existing + new: `webfetch` → lines > 50, `websearch` → lines > 50 | None (pure) |

### templateFor (modified)

| Method        | Input                                             | Output                | Behavior                                                              | Errors      |
| ------------- | ------------------------------------------------- | --------------------- | --------------------------------------------------------------------- | ----------- |
| `templateFor` | `tool: string, override?: Record<string, string>` | `CompressionTemplate` | Existing + new: `webfetch` → `"summarize"`, `websearch` → `"extract"` | None (pure) |

## Data Flow

### Phase 1: Title Generation

| Step | Component    | Action                                                                  | Next           |
| ---- | ------------ | ----------------------------------------------------------------------- | -------------- |
| 1    | ensureTitle  | Get title agent via `agents.get("title")`                               | 2              |
| 2    | ensureTitle  | Check `ag.model` (agent-level override)                                 | 3 if none      |
| 3    | resolveLocal | **NEW:** Read config, check `hybrid.enabled` + `cheap_model`            | 4 if undefined |
| 4    | ensureTitle  | Existing: `getSmallModel(providerID)` → `getModel(providerID, modelID)` | 5              |
| 5    | LLM.stream   | Generate title with resolved model                                      | done           |

**Before (prompt.ts:168-171):**

```typescript
const mdl = ag.model
  ? yield * provider.getModel(ag.model.providerID, ag.model.modelID)
  : (yield * provider.getSmallModel(input.providerID) ?? yield * provider.getModel(input.providerID, input.modelID))
```

**After:**

```typescript
const cfg = yield * config.get()
const mdl = ag.model
  ? yield * provider.getModel(ag.model.providerID, ag.model.modelID)
  : (yield * resolveLocal(provider, cfg) ??
    yield * provider.getSmallModel(input.providerID) ??
    yield * provider.getModel(input.providerID, input.modelID))
```

**Required import additions to prompt.ts:**

```typescript
import { Config } from "@/config/config"
```

**Required service addition in layer (prompt.ts:~81):**

```typescript
const config = yield * Config.Service
```

### Phase 2: Compaction

| Step | Component    | Action                                                                        | Next           |
| ---- | ------------ | ----------------------------------------------------------------------------- | -------------- |
| 1    | compaction   | Get compaction agent via `agents.get("compaction")`                           | 2              |
| 2    | compaction   | Check `agent.model` (agent-level override)                                    | 3 if none      |
| 3    | resolveLocal | **NEW:** Read config, check `hybrid.enabled` + `cheap_model`                  | 4 if undefined |
| 4    | compaction   | Existing: `getModel(userMessage.model.providerID, userMessage.model.modelID)` | 5              |
| 5    | LLM.stream   | Generate compaction summary with resolved model                               | done           |

**Before (compaction.ts:182-185):**

```typescript
const agent = yield * agents.get("compaction")
const model = agent.model
  ? yield * provider.getModel(agent.model.providerID, agent.model.modelID)
  : yield * provider.getModel(userMessage.model.providerID, userMessage.model.modelID)
```

**After:**

```typescript
const agent = yield * agents.get("compaction")
const cfg = yield * config.get()
const model = agent.model
  ? yield * provider.getModel(agent.model.providerID, agent.model.modelID)
  : (yield * resolveLocal(provider, cfg) ??
    yield * provider.getModel(userMessage.model.providerID, userMessage.model.modelID))
```

**Note:** `config` is already in scope (line 77: `const config = yield* Config.Service`). `resolveLocal` must be defined in or imported into `compaction.ts`.

### Phase 3: Summary/Complete

| Step | Component         | Action                                                                  | Next           |
| ---- | ----------------- | ----------------------------------------------------------------------- | -------------- |
| 1    | complete          | Determine base model from `input.model` or `lastModel()`                | 2              |
| 2    | complete          | If `input.model` set → use it directly                                  | done           |
| 3    | complete          | If `input.small === false` → use base model directly                    | done           |
| 4    | resolveLocalAsync | **NEW:** Read config, check `hybrid.enabled` + `cheap_model`            | 5 if undefined |
| 5    | complete          | Existing: `getSmallModel(providerID)` → `getModel(providerID, modelID)` | done           |

**Before (prompt.ts:974-979):**

```typescript
const base = input.model ?? (await lastModel(input.sessionID).pipe(Effect.runPromise))
const model = await (async () => {
  if (input.model) return Provider.getModel(input.model.providerID, input.model.modelID)
  if (input.small === false) return Provider.getModel(base.providerID, base.modelID)
  return (await Provider.getSmallModel(base.providerID)) ?? Provider.getModel(base.providerID, base.modelID)
})()
```

**After:**

```typescript
const base = input.model ?? (await lastModel(input.sessionID).pipe(Effect.runPromise))
const cfg = await Config.get()
const model = await (async () => {
  if (input.model) return Provider.getModel(input.model.providerID, input.model.modelID)
  if (input.small === false) return Provider.getModel(base.providerID, base.modelID)
  return (
    (await resolveLocalAsync(cfg)) ??
    (await Provider.getSmallModel(base.providerID)) ??
    Provider.getModel(base.providerID, base.modelID)
  )
})()
```

**Note:** `Config` is already imported in prompt.ts (will be added in Phase 1). `Config.get()` is a static async function — no service injection needed for the `Effect.promise` context.

### Phase 4: WebFetch/WebSearch Compression

| Step | Component      | Action                                | Next            |
| ---- | -------------- | ------------------------------------- | --------------- |
| 1    | shouldCompress | Check tool name against thresholds    | return bool     |
| 2    | templateFor    | Map tool name to compression template | return template |

**Before (route-classifier.ts:315-320):**

```typescript
export function shouldCompress(output: string, tool: string): boolean {
  const lines = listLines(output)
  if (tool === "bash") return lines > 30
  if (tool === "grep" || tool === "glob") return lines > 100
  return false
}
```

**After:**

```typescript
export function shouldCompress(output: string, tool: string): boolean {
  const lines = listLines(output)
  if (tool === "bash") return lines > 30
  if (tool === "grep" || tool === "glob") return lines > 100
  if (tool === "webfetch" || tool === "websearch") return lines > 50
  return false
}
```

**Before (route-classifier.ts:307-313):**

```typescript
export function templateFor(tool: string, override?: Record<string, string>): CompressionTemplate {
  const o = override?.[tool]
  if (o === "extract" || o === "summarize" || o === "filter") return o
  if (tool === "read") return "summarize"
  if (tool === "bash") return "filter"
  return "extract"
}
```

**After:**

```typescript
export function templateFor(tool: string, override?: Record<string, string>): CompressionTemplate {
  const o = override?.[tool]
  if (o === "extract" || o === "summarize" || o === "filter") return o
  if (tool === "read" || tool === "webfetch") return "summarize"
  if (tool === "bash") return "filter"
  return "extract"
}
```

**Note:** `webfetch` → `"summarize"` (web pages should be summarized to extract key info). `websearch` → `"extract"` (search results should have key items extracted). The `webfetch` case is merged into the existing `read` line. `websearch` falls through to the default `"extract"`.

**Error Flows:** Phase 4 has no error paths — pure functions with no external calls.

## Data Model

No schema changes. No new tables. No migrations.

The only data dependency is the existing `Config.Info.hybrid` field:

| Entity        | Fields                                                                    | Relationships                                | Constraints                                                                      |
| ------------- | ------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------- |
| Config.Hybrid | `enabled: boolean, cheap_model?: { providerID: string, modelID: string }` | Referenced by resolveLocal/resolveLocalAsync | `providerID` must exist in `config.provider` (validated by existing superRefine) |

## Decisions

| Decision                      | Choice                                                         | Reason                                                                                                                                                                                                                                                               | Alternatives                     | Tradeoffs                                                                                 |
| ----------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------- |
| Two helper variants           | `resolveLocal` (Effect) + `resolveLocalAsync` (async)          | `ensureTitle`/`compaction` use yield\*, `complete()` uses async/await inside Effect.promise                                                                                                                                                                          | Single Effect-only helper        | Would require refactoring `complete()` to Effect.gen — violates surgical edit constraint  |
| Helper location               | Define `resolveLocal` in prompt.ts, duplicate in compaction.ts | Avoids new module, keeps changes minimal                                                                                                                                                                                                                             | Extract to shared module         | New file = more churn; 5-line fn doesn't warrant shared module                            |
| webfetch threshold 50         | Lines > 50 triggers compression                                | Balances cost-benefit: compressing < 50 lines (~1K tokens) via local LLM costs 100-500ms for marginal savings; 50+ lines yields clear token reduction                                                                                                                | 20 (aggressive), 100 (like grep) | Too high = no compression on most fetches; too low = compression overhead exceeds savings |
| websearch template "extract"  | Use default extract template                                   | Search results are lists of items — extraction preserves structure                                                                                                                                                                                                   | "summarize"                      | Summarize would lose individual result entries                                            |
| webfetch template "summarize" | Merge with `read` branch                                       | Web pages are prose content, same as file reads                                                                                                                                                                                                                      | "extract"                        | Extract might miss context between items                                                  |
| No complexityClassify changes | Skip Phase 4 Step 3 from plan                                  | `complexityClassify` routes tool _execution_ (local vs cloud model for the tool call itself). webfetch/websearch are HTTP tools — they don't run on a model. Compression is a separate post-processing step that already works via `shouldCompress` + `templateFor`. | Add to LOCAL_ONLY or SPLIT       | Would incorrectly try to route HTTP tool calls to local model                             |
| Config.Service in prompt.ts   | Add to layer services                                          | Required for resolveLocal in ensureTitle                                                                                                                                                                                                                             | Pass config as parameter         | Would change ensureTitle signature, more invasive                                         |

## Risks

| Risk                                         | Impact                                                                             | Likelihood | Mitigation                                                                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Local model provider not configured          | getModel throws → resolveLocal returns undefined → falls through to existing chain | Med        | Effect.option wraps error, returns undefined silently                                                                        |
| Local model slow for titles                  | Title generation blocks UI briefly                                                 | Low        | Title gen already non-blocking (runs after first response); local models are fast for short outputs                          |
| Local model produces poor compaction         | Lost context in compacted conversation                                             | Low        | Compaction prompt is heavily structured (Goal/Instructions/Discoveries template); local model constrained by template        |
| Config.Service addition to prompt.ts layer   | Could affect layer dependency graph                                                | Low        | Config.Service is already provided transitively; adding explicit dependency is safe                                          |
| webfetch compression loses important content | Agent misses key information from web page                                         | Low        | Existing compression validation rejects expansion; original output used on failure; "summarize" template preserves key facts |
| Rebase conflict on prompt.ts                 | prompt.ts is a hot file                                                            | Med        | Changes are in isolated model-resolution blocks (3-5 lines each), not in message processing paths                            |

## Test Plan

### Unit Tests

#### Phase 1: Title — resolveLocal (prompt.ts)

| Test Case                                     | Input                                                                                      | Expected                 | Notes                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------ | ------------------------------------------------ |
| hybrid disabled → undefined                   | `cfg.hybrid.enabled = false`                                                               | returns `undefined`      | Falls through to existing chain                  |
| hybrid enabled, no cheap_model → undefined    | `cfg.hybrid.enabled = true, cheap_model = undefined`                                       | returns `undefined`      | Falls through                                    |
| hybrid enabled + valid cheap_model → Model    | `cfg.hybrid = { enabled: true, cheap_model: { providerID: "ollama", modelID: "llama3" } }` | returns `Provider.Model` | Provider.getModel succeeds                       |
| hybrid enabled + invalid provider → undefined | `cfg.hybrid = { enabled: true, cheap_model: { providerID: "nonexistent", modelID: "x" } }` | returns `undefined`      | Provider.getModel fails, caught by Effect.option |

#### Phase 2: Compaction — model resolution (compaction.ts)

| Test Case                                | Input                             | Expected                         |
| ---------------------------------------- | --------------------------------- | -------------------------------- |
| agent.model set → uses agent model       | agent has model override          | agent.model used, hybrid ignored |
| hybrid enabled → uses local model        | no agent.model, hybrid configured | local model used                 |
| hybrid disabled → uses userMessage model | no agent.model, hybrid disabled   | userMessage.model used           |

#### Phase 3: Complete — resolveLocalAsync (prompt.ts)

| Test Case                                    | Input                                              | Expected                         |
| -------------------------------------------- | -------------------------------------------------- | -------------------------------- |
| input.model set → uses input model           | explicit model in input                            | input.model used, hybrid ignored |
| small=false → uses base model                | input.small === false                              | base model used, hybrid ignored  |
| hybrid enabled + small → uses local model    | no input.model, small !== false, hybrid configured | local model used                 |
| hybrid disabled + small → uses getSmallModel | no input.model, small !== false, hybrid disabled   | getSmallModel fallback           |

#### Phase 4: shouldCompress + templateFor (route-classifier.ts)

**File:** `test/session/route-classifier.test.ts`

| Test Case                    | Function       | Input                              | Expected      |
| ---------------------------- | -------------- | ---------------------------------- | ------------- |
| webfetch > 50 lines → true   | shouldCompress | 55 lines, "webfetch"               | `true`        |
| webfetch ≤ 50 lines → false  | shouldCompress | 45 lines, "webfetch"               | `false`       |
| webfetch empty → false       | shouldCompress | "", "webfetch"                     | `false`       |
| websearch > 50 lines → true  | shouldCompress | 55 lines, "websearch"              | `true`        |
| websearch ≤ 50 lines → false | shouldCompress | 45 lines, "websearch"              | `false`       |
| webfetch → summarize         | templateFor    | "webfetch"                         | `"summarize"` |
| websearch → extract          | templateFor    | "websearch"                        | `"extract"`   |
| webfetch override respected  | templateFor    | "webfetch", { webfetch: "filter" } | `"filter"`    |

### Integration Tests

| Scenario                      | Components                                 | Verification                                                    |
| ----------------------------- | ------------------------------------------ | --------------------------------------------------------------- |
| Title gen with hybrid config  | Config + Provider + ensureTitle            | Title generated using local model when hybrid enabled           |
| Compaction with hybrid config | Config + Provider + compaction             | Compaction summary uses local model                             |
| webfetch output compressed    | shouldCompress + templateFor + LLMCompress | Web page output gets summarized before entering message history |

### Non-Functional Tests

| Requirement                        | Criteria                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------- |
| No regression when hybrid disabled | All existing tests pass unchanged with `hybrid.enabled = false` (default) |
| Type safety                        | `bun typecheck` passes — branded ProviderID/ModelID types enforced        |
| Config gating                      | Zero behavioral change when `hybrid` section absent from config           |

## File Change Summary

| File                                    | Lines Added | Lines Modified | Change                                                                                                                                                           |
| --------------------------------------- | ----------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/session/prompt.ts`                 | ~12         | 0              | Import Config, add Config.Service to layer, resolveLocal helper, resolveLocalAsync helper, modify ensureTitle model resolution, modify complete model resolution |
| `src/session/compaction.ts`             | ~8          | 0              | Import resolveLocal helper (or inline), modify compact model resolution                                                                                          |
| `src/session/route-classifier.ts`       | ~2          | 1              | Add webfetch/websearch to shouldCompress, merge webfetch into templateFor read branch                                                                            |
| `test/session/route-classifier.test.ts` | ~20         | 0              | New test cases for webfetch/websearch in shouldCompress and templateFor                                                                                          |
| **Total**                               | **~42**     | **1**          |                                                                                                                                                                  |
