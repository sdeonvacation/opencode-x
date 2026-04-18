# HLD: Hybrid Routing v1 (Cloud-Default, Cost-Aware)

## Tech Stack

| Category  | Technology                     | Purpose                                                   |
| --------- | ------------------------------ | --------------------------------------------------------- |
| Language  | TypeScript 5.8                 | Type-safe routing logic, Zod schema extensions            |
| Runtime   | Bun 1.3.11                     | Process spawning for verify commands, test runner         |
| Framework | Effect 4.0 (Effect.fn, Layer)  | Traced effects, service composition, error propagation    |
| AI SDK    | Vercel AI SDK `generateObject` | Non-streaming structured preflight classification         |
| Config    | Zod                            | Config schema extension for `experimental.hybrid_routing` |
| Events    | Existing Bus (BusEvent)        | Typed telemetry event for route decisions                 |
| Testing   | bun:test                       | Unit + integration tests per module                       |

---

## Components

| Component                       | Responsibility                                                                                                                     | Dependencies                                        |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `hybrid-types.ts`               | Shared type definitions: `PreflightInput`, `PreflightResult`, `RouteDecision`, `OverrideReason`, `InvocationType`, `OperationType` | None (pure types)                                   |
| `hybrid-heuristics.ts`          | Regex-based bash command classification before LLM call                                                                            | `hybrid-types.ts`                                   |
| `hybrid-preflight.ts`           | Structured non-streaming LLM call via `generateObject`; 3-level model fallback                                                     | `hybrid-types.ts`, `Provider`, `Config`             |
| `hybrid-router.ts`              | Deterministic 6-branch policy → `RouteDecision`; ask formatter                                                                     | `hybrid-types.ts`                                   |
| `verify.ts`                     | Post-code-change verification: configured cmds → autodetect → LLM                                                                  | `Config`, `Provider`, Effect `ChildProcess`         |
| `events.ts` _(extended)_        | New `orchestration.route` telemetry event                                                                                          | `BusEvent`, `zod`                                   |
| `config.ts` _(extended)_        | `experimental.hybrid_routing` Zod schema block                                                                                     | `zod`                                               |
| `prompt.ts` _(hook, ~10 lines)_ | Primary turn routing hook before `createUserMessage`                                                                               | `hybrid-preflight.ts`, `hybrid-router.ts`, `Config` |
| `task.ts` _(hook, ~10 lines)_   | Subagent routing hook after `resolveTaskModel`                                                                                     | `hybrid-preflight.ts`, `hybrid-router.ts`, `Config` |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Config Layer                             │
│  experimental.hybrid_routing.{enabled, threshold,              │
│  preflight_model, local_models,                                  │
│  verify_commands, verify_cache_ttl_ms}                          │
└───────────────────────────┬─────────────────────────────────────┘
                            │ read by
          ┌─────────────────┴──────────────────┐
          │                                    │
  ┌───────▼────────┐                  ┌────────▼────────┐
  │  prompt.ts     │                  │   task.ts       │
  │  (hook ~L943)  │                  │  (hook ~L108)   │
  └───────┬────────┘                  └────────┬────────┘
          │                                    │
          └──────────────┬─────────────────────┘
                         │ calls
              ┌──────────▼──────────┐
              │  hybrid-preflight   │
              │  (generateObject)   │
              │  + heuristics       │
              └──────────┬──────────┘
                         │ PreflightResult
              ┌──────────▼──────────┐
              │   hybrid-router     │
              │  (deterministic     │
              │   6-branch policy)  │
              └──────┬──────┬───────┘
                     │      │
          ┌──────────┘      └──────────────┐
          │ RouteDecision                  │
   ┌──────▼──────┐                ┌────────▼────────┐
   │ ask path    │                │ route = local   │
   │ (return     │                │ or cloud        │
   │  early with │                │ stamp model on  │
   │  formatted  │                │ UserMessage,    │
   │  message)   │                │ continue loop   │
   └─────────────┘                └────────┬────────┘
                                           │ if code_change
                                  ┌────────▼────────┐
                                  │   verify.ts     │
                                  │ cmds→autodetect │
                                  │ →LLM fallback   │
                                  └────────┬────────┘
                                           │
                                  ┌────────▼────────┐
                                  │  events.ts      │
                                  │  Route event    │
                                  │  (Bus.publish)  │
                                  └─────────────────┘
```

**Description**: All new logic lives in `packages/opencode/src/orchestration/`. The two integration points (`prompt.ts`, `task.ts`) each add a single early-return guard (`if (!cfg.experimental?.hybrid_routing?.enabled) { /* existing path */ }`) followed by a call to `runPreflight` → `route`. The hybrid router is purely functional (no I/O). Preflight does the only I/O (one `generateObject` call). Verification is a separate concern triggered only on `code_change` routes. Telemetry is fire-and-forget via Bus after every route decision.

---

## Interfaces

### `hybrid-types.ts`

| Type / Enum       | Shape                                                                                                                                                                        | Notes                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `InvocationType`  | `"chat" \| "command" \| "tool"`                                                                                                                                              | Detected from call path                 |
| `OperationType`   | `"read" \| "bash_simple" \| "bash_complex" \| "code_change" \| "other"`                                                                                                      | Output of preflight + heuristics        |
| `OverrideReason`  | `"code_change" \| "low_confidence" \| "policy_bash_complex" \| "info_gap" \| "preflight_unavailable"`                                                                        | Why router overrode user/default model  |
| `RouteTarget`     | `"local" \| "cloud" \| "ask"`                                                                                                                                                | Routing destination                     |
| `PreflightInput`  | `{ prompt: string; agent: string; invocation_type: InvocationType; command_string?: string; parts_summary: string; base_model: ModelRef }`                                   | Input to preflight classifier           |
| `PreflightResult` | `{ confidence: number; info_gap: "high" \| "medium" \| "low"; needs_code_change: boolean; operation_type: OperationType; assumptions: string[]; ask_candidates: string[] }`  | Structured output from `generateObject` |
| `RouteDecision`   | `{ target: RouteTarget; model: ModelRef; was_overridden: boolean; override_reason?: OverrideReason; assumptions: string[]; ask_text?: string; preflight?: PreflightResult }` | Final routing decision                  |
| `ModelRef`        | `{ providerID: string; modelID: string }` (re-export from `category-routing.ts`)                                                                                             | Existing type                           |

### `hybrid-heuristics.ts`

| Function   | Input         | Output                       | Behavior                                                                                                                                                                                                                                        | Errors |
| ---------- | ------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `classify` | `cmd: string` | `OperationType \| undefined` | Applies `COMPLEX_RE` (`/(npm\|yarn\|pnpm\|bun\|docker\|gradle\|mvn\|build\|deploy\|test)\b/i`) → `"bash_complex"`, `SIMPLE_RE` (`/(echo\|pwd\|whoami\|env)\b/i`) → `"bash_simple"`. Returns `undefined` when neither matches. Never downgrades. | None   |

### `hybrid-preflight.ts`

| Function | Input                                             | Output                    | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                             | Errors                                         |
| -------- | ------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `run`    | `input: PreflightInput, cfg: HybridRoutingConfig` | `Effect<PreflightResult>` | 1. If `invocation_type === "command"` and `command_string` present: apply `classify(command_string)` to seed `operation_type` hint in LLM prompt. 2. Resolve preflight model: `cfg.preflight_model` → `cfg.local_models[0]` → `input.base_model`. 3. Call `generateObject` with `PreflightOutputSchema`. 4. Merge heuristic hint (heuristic wins for `bash_simple`/`bash_complex`, LLM wins otherwise). 5. Return `PreflightResult`. | `PreflightUnavailableError` if all models fail |

**Preflight output Zod schema** (passed to `generateObject`):

```ts
const PreflightOutputSchema = z.object({
  confidence: z.number().min(0).max(1),
  info_gap: z.enum(["high", "medium", "low"]),
  needs_code_change: z.boolean(),
  operation_type: z.enum(["read", "bash_simple", "bash_complex", "code_change", "other"]),
  assumptions: z.array(z.string()),
  ask_candidates: z.array(z.string()),
})
```

### `hybrid-router.ts`

| Function    | Input                                                                                                  | Output          | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Errors         |
| ----------- | ------------------------------------------------------------------------------------------------------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `route`     | `preflight: PreflightResult \| undefined, base: ModelRef, cfg: HybridRoutingConfig, explicit: boolean` | `RouteDecision` | **Policy order** (first match wins): 1. `preflight === undefined` → `cloud`, `override_reason = "preflight_unavailable"`. 2. `info_gap === "high"` → `ask`, format ask text from `ask_candidates`. 3. `needs_code_change === true` → `cloud`, `override_reason = "code_change"`. 4. `operation_type === "read" \|\| "bash_simple"` → `local` (confidence ignored). 5. `operation_type === "bash_complex"` → `cloud`, `override_reason = "policy_bash_complex"`. 6. `confidence < cfg.threshold` → `cloud`, `override_reason = "low_confidence"`. 7. else → `local`. If `explicit === true` and routed model differs from `base`: set `was_overridden = true`. Pick model from `cfg.local_models[0]` for local, `base` for cloud. | None (pure fn) |
| `formatAsk` | `candidates: string[], missing?: string`                                                               | `string`        | Returns fixed template: `"I need more information to proceed:\n\n- Missing: <missing>\n- Options:\n  1) ...\n  2) ...\n\nPlease clarify."` Populates from `candidates` when present, else uses `missing` placeholder.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | None           |

### `verify.ts`

| Function     | Input                                                           | Output                 | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Errors                               |
| ------------ | --------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `run`        | `cfg: HybridRoutingConfig, sessionID: string, repoRoot: string` | `Effect<VerifyResult>` | 1. If `cfg.verify_commands` non-empty: spawn each via `ChildProcess.make`. If spawn fails (ENOENT) → fallback to LLM verification. If process exits non-zero → `{ ok: false, source: "command", reason: "exit_nonzero" }` (no fallback). 2. If no commands or spawn-failed: check autodetect cache (key = `repoRoot + lockfile_mtime`). If cache miss or TTL expired: probe available scripts/tools, cache result. 3. If autodetected commands exist: run them (same exit-code semantics). 4. If nothing available: LLM verification via `generateObject`. If LLM `confidence < 0.6` → `{ ok: false, source: "llm", warn: true }`. | `VerifyError` on hard fail           |
| `autodetect` | `repoRoot: string`                                              | `Effect<string[]>`     | Probes for `package.json` scripts (`typecheck`, `build`, `test`), `Makefile` targets, etc. Returns command strings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | None (returns `[]` on probe failure) |

**VerifyResult type**:

```ts
type VerifyResult = {
  ok: boolean
  source: "command" | "autodetect" | "llm" | "none"
  warn?: boolean // LLM low-confidence
  reason?: string // human-readable failure detail
}
```

### `events.ts` (extension)

New event added to `OrchestrationEvent` namespace:

```ts
export const Route = BusEvent.define(
  "orchestration.route",
  z.object({
    sessionID: z.string(),
    route: z.enum(["local", "cloud", "ask"]),
    operation_type: z.enum(["read", "bash_simple", "bash_complex", "code_change", "other"]).optional(),
    confidence: z.number().optional(),
    info_gap: z.enum(["high", "medium", "low"]).optional(),
    needs_code_change: z.boolean().optional(),
    assumptions_count: z.number().int(),
    verification_used: z.boolean(),
    success: z.boolean(),
    was_overridden: z.boolean(),
    override_reason: z
      .enum(["code_change", "low_confidence", "policy_bash_complex", "info_gap", "preflight_unavailable"])
      .optional(),
    preflight_fallback: z.enum(["configured", "first_local", "base", "none"]).optional(),
  }),
)
```

---

## Data Flow

### Primary Prompt Path (prompt.ts)

| Step | Component          | Action                                                                                                                                                                                          | Next                              |
| ---- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 1    | `prompt.ts`        | Check `cfg.experimental?.hybrid_routing?.enabled`. If false → existing path unchanged.                                                                                                          | Existing `createUserMessage` call |
| 2    | `prompt.ts`        | Detect `invocation_type`: `"chat"` (default prompt call), `"command"` (slash command), `"tool"` (shell tool invocation). Extract text parts summary and optional `command_string`.              | `hybrid-preflight.run`            |
| 3    | `hybrid-preflight` | Apply heuristics on `command_string` if present. Call `generateObject` on preflight model. Return `PreflightResult`.                                                                            | `hybrid-router.route`             |
| 4    | `hybrid-router`    | Apply 6-branch policy. Return `RouteDecision` with `target`, `model`, `was_overridden`, `assumptions`, optional `ask_text`.                                                                     | Branch on `target`                |
| 5a   | `prompt.ts`        | If `target === "ask"`: create assistant message with `ask_text`, skip model loop, return early.                                                                                                 | Return `MessageV2.WithParts`      |
| 5b   | `prompt.ts`        | If `target === "local" \| "cloud"`: override `input.model` with `decision.model`. If `assumptions` non-empty: prepend synthetic text part to assistant output. Continue to `createUserMessage`. | `createUserMessage` → `loop`      |
| 6    | `prompt.ts`        | After loop completes (or ask path): emit `OrchestrationEvent.Route` via `Bus.publish`.                                                                                                          | Done                              |

### Subagent Path (task.ts)

| Step | Component | Action                                                                                                                                                                                                  | Next                               |
| ---- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 1    | `task.ts` | Check `cfg.experimental?.hybrid_routing?.enabled`. If false → existing `resolveTaskModel` path unchanged.                                                                                               | Existing path                      |
| 2    | `task.ts` | If ultrawork keyword detected or `use_ultrawork` flag set → use ultrawork model (unchanged precedence).                                                                                                 | Spawn session with ultrawork model |
| 3    | `task.ts` | Build `PreflightInput` from `params.prompt`, `params.subagent_type`, `invocation_type = "tool"`. Call `hybrid-preflight.run` → `hybrid-router.route`. There are no subagent-specific routing overrides. | Use `decision.model`               |
| 4    | `task.ts` | Emit `OrchestrationEvent.Route` via `Bus.publish`.                                                                                                                                                      | Done                               |

### Ask Path

| Step | Component       | Action                                                                                                    | Next                                 |
| ---- | --------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 1    | `hybrid-router` | Policy branch 2: `info_gap === "high"`. Call `formatAsk(candidates, missing)`.                            | Return `RouteDecision{target:"ask"}` |
| 2    | `prompt.ts`     | Receive `target === "ask"`. Create assistant `TextPart` with `ask_text`. Store via `sessions.updatePart`. | Return early, no LLM stream call     |
| 3    | `prompt.ts`     | Emit `OrchestrationEvent.Route` with `route: "ask"`.                                                      | Done                                 |

### Verification Path

| Step | Component   | Action                                                                                                        | Next                  |
| ---- | ----------- | ------------------------------------------------------------------------------------------------------------- | --------------------- |
| 1    | `prompt.ts` | After LLM loop completes, if `decision.preflight?.needs_code_change === true` and flag on: call `verify.run`. | `verify.ts`           |
| 2    | `verify.ts` | Try configured commands. Spawn-fail → LLM fallback. Exit non-zero → hard fail, no fallback.                   | Return `VerifyResult` |
| 3    | `verify.ts` | If no configured commands: check autodetect cache. TTL miss → probe. Run detected commands.                   | Return `VerifyResult` |
| 4    | `verify.ts` | If nothing available: LLM verification. `confidence < 0.6` → `{ ok: false, warn: true }`.                     | Return `VerifyResult` |
| 5    | `prompt.ts` | Incorporate `VerifyResult` into `OrchestrationEvent.Route` (`verification_used`, `success`).                  | Done                  |

**Error Flows**:

- Preflight model call fails → `PreflightUnavailableError` → router receives `preflight = undefined` → policy branch 1 → force `cloud`, `override_reason = "preflight_unavailable"`. Never blocks the turn.
- Verify command spawn fails (ENOENT) → fallback to LLM verification (not a hard error).
- Verify command exits non-zero → `VerifyResult { ok: false }` surfaced as warning in telemetry; does not abort the session.
- LLM verify confidence < 0.6 → `{ ok: false, warn: true }` — logged, not thrown.
- Flag off at any point → all new code paths are unreachable; zero behavior change.

---

## Data Model

No new database tables or migrations. All state is in-memory or per-turn.

| Entity                | Fields                                                                                                                                                                   | Relationships                        | Constraints                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ | ---------------------------------------------------------- |
| `HybridRoutingConfig` | `enabled: boolean; threshold: number; preflight_model?: ModelRef; local_models: ModelRef[]; verify_commands: string[]; verify_cache_ttl_ms: number`                      | Nested in `Config.experimental`      | `threshold` ∈ [0,1]; `local_models` non-empty when enabled |
| `PreflightInput`      | `prompt: string; agent: string; invocation_type: InvocationType; command_string?: string; parts_summary: string; base_model: ModelRef`                                   | Constructed per turn in prompt/task  | `parts_summary` is truncated text concat of TextParts      |
| `PreflightResult`     | `confidence: number; info_gap: "high"\|"medium"\|"low"; needs_code_change: boolean; operation_type: OperationType; assumptions: string[]; ask_candidates: string[]`      | Output of preflight, input to router | `confidence` ∈ [0,1]                                       |
| `RouteDecision`       | `target: RouteTarget; model: ModelRef; was_overridden: boolean; override_reason?: OverrideReason; assumptions: string[]; ask_text?: string; preflight?: PreflightResult` | Output of router, consumed by hooks  | `ask_text` present iff `target === "ask"`                  |
| `VerifyResult`        | `ok: boolean; source: "command"\|"autodetect"\|"llm"\|"none"; warn?: boolean; reason?: string`                                                                           | Output of verify, fed into telemetry | `warn` only when `source === "llm"`                        |
| `AutodetectCache`     | `key: string (repoRoot+mtimes); commands: string[]; expires_at: number`                                                                                                  | In-memory Map in `verify.ts`         | TTL from `verify_cache_ttl_ms`                             |

---

## Config Schema Definition

Extension to `experimental` object in `src/config/config.ts` (appended before closing `}`):

```ts
hybrid_routing: z
  .object({
    enabled: z.boolean().default(false)
      .describe("Enable intelligent local/cloud LLM routing"),
    threshold: z.number().min(0).max(1).default(0.7)
      .describe("Preflight confidence below this routes to cloud"),
    preflight_model: z
      .object({ providerID: z.string(), modelID: z.string() })
      .optional()
      .describe("Model used for preflight classification; falls back to local_models[0] then the base model"),
    local_models: z
      .array(z.object({ providerID: z.string(), modelID: z.string() }))
      .default([])
      .describe("Ordered list of local models; first entry used for routing"),
    verify_commands: z
      .array(z.string())
      .default([])
      .describe("Shell commands run after code_change operations to verify correctness"),
    verify_cache_ttl_ms: z
      .number().int().positive()
      .default(300_000)
      .describe("TTL in ms for autodetected verify command cache (default: 5 minutes)"),
  })
  .optional()
  .describe("Hybrid local/cloud routing (experimental)"),
```

---

## Decisions

| Decision                                    | Choice                                                                              | Reason                                                                                             | Alternatives                                            | Tradeoffs                                                           |
| ------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------- |
| Preflight as non-streaming `generateObject` | Single structured call, not streaming                                               | Routing decision needed before turn starts; streaming adds latency with no benefit here            | Streaming with early-stop; heuristics-only              | Extra LLM call per turn; mitigated by small/fast preflight model    |
| Deterministic 6-branch router (pure fn)     | No LLM in router; pure TypeScript policy                                            | Predictable, testable, zero latency; LLM judgment already captured in `PreflightResult`            | LLM-in-router; weighted scoring                         | Less adaptive; policy changes require code edits                    |
| Heuristics override upward only             | `bash_simple`/`bash_complex` from regex; never downgrades LLM result                | Regex is fast and reliable for known patterns; prevents LLM from misclassifying obvious cases      | LLM-only classification                                 | Regex list needs maintenance as new tools emerge                    |
| Category routing kept outside hybrid layer  | `resolveTaskModel` remains as fallback when flag off                                | Avoids coupling; category routing is orthogonal to local/cloud split                               | Merge into hybrid router                                | Two separate routing layers; clear precedence chain                 |
| Verify hard-fail on exit non-zero           | No LLM fallback when command runs and fails                                         | If a configured command explicitly fails, that is signal — silently passing would hide real errors | Always fallback to LLM                                  | Stricter; user must fix or remove command from config               |
| `ask` path returns early (no LLM stream)    | Assistant message created directly, loop skipped                                    | Avoids wasting tokens on a turn that cannot proceed; forces user to provide missing info           | Emit ask as tool call result; continue with uncertainty | More abrupt UX; but consistent with "never silently pass" principle |
| Flag gating via early-return guard          | `if (!cfg.experimental?.hybrid_routing?.enabled) { /* existing */ }` at top of hook | Surgical; upstream-rebase safe; zero overhead when off                                             | Wrapper function; separate code path                    | Slightly more indentation; worth it for minimal diff footprint      |

---

## Risks

| Risk                                                | Impact                                                    | Likelihood | Mitigation                                                                                 |
| --------------------------------------------------- | --------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------ |
| Preflight model unavailable (local not configured)  | Every turn forced to cloud; defeats purpose               | Medium     | 3-level fallback chain; `preflight_unavailable` override reason logged; turn never blocked |
| Heuristic misclassifies new bash tools as simple    | Sensitive operation routed to local                       | Low        | Heuristics only upgrade (simple→complex); LLM refines; regex list extensible               |
| `generateObject` adds latency per turn              | UX degradation on fast operations                         | Medium     | Use smallest/fastest local model for preflight; preflight prompt kept minimal              |
| Ask path format drift across versions               | Inconsistent UX                                           | Low        | Fixed template in `formatAsk`; unit-tested                                                 |
| Verify command crashes vs missing conflated         | Silent pass on broken code                                | Low        | Explicit ENOENT check → LLM fallback; exit non-zero → hard fail, no fallback               |
| Upstream rebase conflict on `prompt.ts` / `task.ts` | Merge conflict on busy files                              | High       | ~10 lines each; single early-return guard; no restructuring of existing code               |
| Code-agent set hardcoded in task.ts hook            | New code agents not automatically forced to cloud         | Low        | Set defined as constant; easy to extend; documented                                        |
| Flag-on regression in existing flows                | Silent behavior change for users not using hybrid routing | Medium     | Flag-off tests prove zero change; flag-on tests cover all branches                         |

---

## Test Plan

### Unit Tests

**`test/orchestration/hybrid-heuristics.test.ts`**

- `classify("npm install")` → `"bash_complex"`
- `classify("docker build .")` → `"bash_complex"`
- `classify("echo hello")` → `"bash_simple"`
- `classify("pwd")` → `"bash_simple"`
- `classify("git status")` → `undefined` (neither pattern)
- `classify("bun run test")` → `"bash_complex"` (contains `bun`)
- Heuristic never returns `bash_simple` for complex input (no downgrade)

**`test/orchestration/hybrid-preflight.test.ts`**

- `invocation_type === "command"` with `command_string = "npm install"` → heuristic seeds `bash_complex` in prompt
- Preflight model fallback: configured → first local → base model (mock each failing)
- `generateObject` schema validation: all fields present, confidence ∈ [0,1]
- Heuristic wins for `bash_simple`/`bash_complex`; LLM wins for `code_change`/`read`/`other`

**`test/orchestration/hybrid-router.test.ts`**

- Branch 1: `preflight = undefined` → `cloud`, `override_reason = "preflight_unavailable"`
- Branch 2: `info_gap = "high"` → `ask`, `ask_text` contains template
- Branch 3: `needs_code_change = true` → `cloud`, `override_reason = "code_change"`
- Branch 4: `operation_type = "read"` → `local` (regardless of confidence)
- Branch 4: `operation_type = "bash_simple"` → `local` (regardless of confidence)
- Branch 5: `operation_type = "bash_complex"` → `cloud`, `override_reason = "policy_bash_complex"`
- Branch 6: `confidence = 0.5`, `threshold = 0.7` → `cloud`, `override_reason = "low_confidence"`
- Branch 7: `confidence = 0.9`, `operation_type = "other"` → `local`
- `explicit = true`, routed model ≠ base → `was_overridden = true`
- `explicit = false` → `was_overridden = false` regardless
- `formatAsk` with candidates → numbered list in fixed template
- `formatAsk` with no candidates → missing placeholder in template

**`test/orchestration/verify.test.ts`**

- Configured command ENOENT → fallback to LLM verification
- Configured command exits 1 → `{ ok: false, source: "command" }`, no LLM fallback
- Configured command exits 0 → `{ ok: true, source: "command" }`
- No commands, autodetect cache hit within TTL → uses cached commands
- No commands, autodetect cache miss → probes, caches result
- LLM verify confidence 0.8 → `{ ok: true, source: "llm" }`
- LLM verify confidence 0.5 → `{ ok: false, warn: true, source: "llm" }`

### Integration Tests

**`test/session/hybrid-prompt.test.ts`**

- Flag off: `prompt()` call produces identical `UserMessage.model` to current codebase (no override)
- Flag on, `info_gap = "high"`: returns early with assistant message containing ask template; no LLM stream call
- Flag on, `route = "local"`: `UserMessage.model` stamped with `local_models[0]`
- Flag on, `route = "cloud"`: `UserMessage.model` stamped with the existing base model
- Flag on, `assumptions` non-empty: synthetic text part prepended to assistant output
- `OrchestrationEvent.Route` emitted with correct fields after each routed turn
- `OrchestrationEvent.Route` NOT emitted when flag off

**`test/tool/task.test.ts` (extended)**

- Ultrawork keyword in prompt → ultrawork model wins regardless of hybrid flag
- `use_ultrawork: true` → ultrawork model wins
- `subagent_type = "coder"` + flag on + `operation_type = "read"` → local model
- `subagent_type = "debugger"` + flag on + `operation_type = "bash_complex"` → cloud model
- `subagent_type = "summarizer"` + flag on → same hybrid router policy as any other subagent
- Flag off + any subagent_type → existing `resolveTaskModel` result unchanged

### End-to-End Tests

- Full turn with flag on: preflight classifies `read` operation → local model used → verify skipped → event emitted
- Full turn with flag on: preflight classifies `code_change` → cloud model used → verify runs → event emitted with `verification_used: true`
- Ask path: turn with `info_gap = "high"` → assistant message returned with clarification text → no model call made
- Flag off: complete turn produces same output as before feature introduction

### Non-Functional Tests

- **Performance**: Preflight `generateObject` call must complete in < 2s on fast local model; measured in integration test
- **Security**: `verify_commands` entries are treated as shell commands — no user-controlled interpolation; commands are static strings from config only
- **Flag safety**: `cfg.experimental?.hybrid_routing?.enabled` guard evaluated before any new code path; optional chain ensures `undefined` config is safe
- **Rebase safety**: Integration point diffs verified to be ≤ 10 lines each via code review

---

## Integration Point Diffs

### `src/session/prompt.ts` (~line 943, inside `prompt` fn)

```diff
  const prompt = Effect.fn("SessionPrompt.prompt")(function* (input: PromptInput) {
    const session = yield* sessions.get(input.sessionID)
    yield* revert.cleanup(session)
+
+   const cfg = yield* config.get()
+   if (cfg.experimental?.hybrid_routing?.enabled) {
+     const decision = yield* HybridRouter.decide(input, cfg.experimental.hybrid_routing)
+     if (decision.target === "ask") return yield* makeAskMessage(input.sessionID, decision.ask_text!)
+     input = { ...input, model: decision.model }
+   }
+
    const message = yield* createUserMessage(input)
```

### `src/tool/task.ts` (~line 108, after `resolveTaskModel`)

```diff
    const finalModel = resolveTaskModel({ ... })
+
+   const cfg2 = await Config.get()
+   const hybridModel = cfg2.experimental?.hybrid_routing?.enabled
+     ? await HybridRouter.decideSubagent(params, finalModel, cfg2.experimental.hybrid_routing)
+     : finalModel
+
-   const concurrencyKey = `${finalModel.providerID}:${finalModel.modelID}`
+   const concurrencyKey = `${hybridModel.providerID}:${hybridModel.modelID}`
```

> Note: `HybridRouter.decide` and `HybridRouter.decideSubagent` are thin orchestration wrappers that call `hybrid-preflight.run` → `hybrid-router.route` and emit the telemetry event. They are defined in `src/orchestration/hybrid-router.ts` as exported Effect functions.

---

## Feature Flag Gating Strategy

- Flag: `cfg.experimental?.hybrid_routing?.enabled` (default `false` via Zod `.default(false)`)
- **Guard pattern**: Early-return at the top of each integration hook. If flag is falsy, the existing code path executes without modification.
- **Zero overhead when off**: No imports are evaluated at runtime for the new modules when the guard short-circuits (Effect lazy evaluation).
- **Config validation**: When `enabled: true`, `local_models` must be non-empty. Validated at config parse time with a Zod `.refine()`.
- **Test isolation**: All flag-off tests run the existing code path; flag-on tests explicitly set `experimental.hybrid_routing.enabled = true` in test config fixture.
- **Rollout**: Feature ships with `enabled: false`. Users opt in by adding `experimental.hybrid_routing` block to their config. No migration required.
