---
description: Add a new experimental feature to opencode-x with correct gating, defaults, and wiring
when_to_use: When adding a new tool, slash command, or behavior behind an experimental config flag
---

## Context

opencode-x has ~30 experimental features. Each needs: a schema entry, a gating check, optionally a TUI command gate, and guide/test updates. Three different default patterns exist — getting this wrong ships a feature silently enabled or permanently disabled.

## Default Pattern Decision

| Desired default                   | Pattern                         | Example                             |
| --------------------------------- | ------------------------------- | ----------------------------------- |
| **ON by default** (most features) | `cfg.experimental?.X !== false` | `goal_system`, `swarm`, `workflow`  |
| **OFF by default** (risky/large)  | `cfg.experimental?.X === true`  | `deep_research`, `wire_diagnostics` |
| **Numeric default**               | `cfg.experimental?.X ?? N`      | `tool_result_budget ?? 50_000`      |

## Steps

### 1. Add schema entry — `src/config/config.ts`

Find the `experimental` object schema (around line 1693). Add:

```typescript
// Default-on boolean:
my_feature: z.boolean().optional().describe("Enable my feature"),

// Opt-in boolean:
my_feature: z.boolean().optional().describe("Enable my feature (opt-in)"),

// Numeric with default:
my_feature_budget: z.number().int().positive().optional().describe("Budget for my feature (default: 50000)"),
```

Tunables (model, limits) are fine to keep as separate keys. Only add a boolean gate if the feature itself needs an on/off switch.

### 2. Gate the tool — `src/tool/registry.ts`

Find the tool list around line 199:

```typescript
// Default-on:
...(cfg.experimental?.my_feature !== false ? [MyTool] : []),

// Opt-in:
...(cfg.experimental?.my_feature === true ? [MyTool] : []),
```

### 3. Gate behavior in session — `src/session/prompt.ts` or `src/session/processor.ts`

Use the same pattern as step 2 wherever the feature is invoked in the session loop.

### 4. Gate TUI slash command — `src/cli/cmd/tui/app.tsx`

**CRITICAL: SDK type mismatch.** The `sync.data.config` type comes from `@opencode-ai/sdk/v2` and may not include new experimental keys. Always cast through `any`:

```typescript
// Default-on (just include the command, no gate needed):
createMyCommand({ dialog, toast, sdk, route }),

// Opt-in — must cast:
...((sync.data.config.experimental as any)?.my_feature === true
  ? [createMyCommand({ dialog, toast, sdk, route })]
  : []),

// Default-on with ability to disable:
...((sync.data.config.experimental as any)?.my_feature !== false
  ? [createMyCommand({ dialog, toast, sdk, route })]
  : []),
```

### 5. Update tests

Search for tests that check experimental config defaults:

```bash
rg "experimental" packages/opencode/test/ --include="*.ts" -l
```

Key test file: `test/effect/runtime-flags.test.ts` — update any `toBe(false)` → `toBe(true)` or vice versa for your flag.

### 6. Update guides

- **`OPENCODE-X_GUIDE.md`**: Add to the relevant feature section. Note the env var pattern:
  ```json
  { "experimental": { "my_feature": true } }
  ```
- **`AGENTS.md`**: If the feature affects agent behavior (tools, prompts, session flow), mention it.

### 7. Verify

```bash
bun --cwd packages/opencode typecheck
bun --cwd packages/opencode test --timeout 30000
```

## Gotchas

- **Never use `Flag.*` for config-based features** — `Flag.*` is for env var booleans at startup, not user config. Config features use `cfg.experimental?.X`.
- **SDK type mismatch in TUI** — `sync.data.config.experimental` TypeScript type comes from the SDK package. New keys added to `config.ts` schema are NOT automatically in the SDK type. Always `(sync.data.config.experimental as any)?.key` in TUI code.
- **Default-on `!== false` means `undefined` = enabled** — if a user has never set the key, `undefined !== false` is `true`. This is intentional.
- **Numeric defaults use `??` not `||`** — `cfg.experimental?.budget ?? 50_000` (not `||`) because `0` is a valid value that `||` would replace.
- **Removing a flag later** — follow the `skill-feature-flag-removal` pattern in persistent memory: delete from schema, remove gate, keep tunables.

## Templates

### Full new default-on feature

```typescript
// 1. config.ts schema (in experimental object):
my_feature: z.boolean().optional().describe("Enable my feature"),

// 2. registry.ts:
...(cfg.experimental?.my_feature !== false ? [MyTool] : []),

// 3. prompt.ts / processor.ts gate:
if (cfg.experimental?.my_feature !== false) {
  // feature logic
}

// 4. app.tsx — no gate needed for default-on commands

// 5. opencode.json to disable:
{ "experimental": { "my_feature": false } }
```

### Full new opt-in feature

```typescript
// 1. config.ts schema:
my_feature: z.boolean().optional().describe("Enable my feature (opt-in, requires explicit true)"),

// 2. registry.ts:
...(cfg.experimental?.my_feature === true ? [MyTool] : []),

// 3. app.tsx with cast:
...((sync.data.config.experimental as any)?.my_feature === true
  ? [createMyCommand({ dialog, toast, sdk, route })]
  : []),

// 4. opencode.json to enable:
{ "experimental": { "my_feature": true } }
```
