# HLD: Rebase Isolation — Extract Inline Logic & Reorganize Git History

## Tech Stack

| Category  | Technology         | Purpose                                                              |
| --------- | ------------------ | -------------------------------------------------------------------- |
| Language  | TypeScript 5.8.2   | Existing codebase language; all extractions are `.ts`/`.tsx`         |
| Runtime   | Bun 1.3.11         | Test runner, build, module resolution                                |
| Framework | Effect 4.0-beta.43 | Service/layer pattern for `prompt.ts` and `processor.ts` extractions |
| UI        | SolidJS + opentui  | TUI components for `app.tsx` extractions                             |
| Schema    | Zod                | Parameter validation in tool modules                                 |
| Test      | bun:test           | Verification after each extraction                                   |

## Components

| Component             | Responsibility                                           | Dependencies                                                                  |
| --------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `prompt-reminders`    | Plan-mode reminders, BUILD_SWITCH injection              | `Session`, `Agent`, `Flag`, `AppFileSystem`, `PartID`                         |
| `subtask-handler`     | Execute subtask parts (fork session, run task tool)      | `Session`, `Agent`, `TaskTool`, `Permission`, `Bus`, `SessionRetry`, `Plugin` |
| `reasoning-handler`   | (Already handled inline — see analysis below)            | `PartCoalescer`, `Session`                                                    |
| `plugin-signature`    | Compute stable identity for plugin tool definitions      | `Plugin`                                                                      |
| `plugin-hook-cache`   | WeakMap cache for plugin hook/function IDs               | None (pure data structure)                                                    |
| `tool-filter`         | Filter tools by provider/model/feature flags             | `Flag`, `Env`, `ProviderID`                                                   |
| `task-spawn`          | Spawn reservation + session creation for task tool       | `Session`, `Bus`, `OrchestrationEvent`, `spawn-limits`, `Config`              |
| `task-model-resolver` | Compose final model from category + ultrawork overrides  | `category-routing`, `ultrawork`, `ultrawork-hook`, `Config`                   |
| `app-event-listeners` | Wire SDK event handlers (command, toast, session, error) | `sdk`, `route`, `command`, `toast`, `dialog`                                  |
| `btw-command`         | `/btw` slash command handler                             | `sdk`, `dialog`, `local`, `toast`, `sync`, `route`                            |
| `goto-command`        | `/goto` (change directory) slash command                 | `sdk`, `dialog`, `toast`, `Filesystem`                                        |
| `clear-commands`      | `/clear` and `/clear-compact` slash commands             | `sdk`, `sync`, `kv`, `toast`, `route`, `local`                                |
| `terminal-title`      | Terminal title effect (createEffect)                     | `route`, `sync`, `renderer`, `kv`, `Flag`                                     |
| `copy-handler`        | Copy-on-select and right-click copy logic                | `renderer`, `toast`, `Selection`, `Clipboard`                                 |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         UPSTREAM FILES (minimal hooks)                  │
│                                                                        │
│  prompt.ts ──┬── import + call ──▶ prompt-reminders.ts     (NEW)       │
│              └── import + call ──▶ subtask-handler.ts      (NEW)       │
│                                                                        │
│  processor.ts ── (no extraction needed — see analysis)                 │
│                                                                        │
│  registry.ts ─┬── import + call ──▶ plugin-signature.ts    (NEW)       │
│               ├── import + init ──▶ plugin-hook-cache.ts   (NEW)       │
│               └── import + call ──▶ tool-filter.ts         (NEW)       │
│                                                                        │
│  task.ts ─────┬── import + call ──▶ task-spawn.ts          (NEW)       │
│               └── import + call ──▶ task-model-resolver.ts (NEW)       │
│                                                                        │
│  app.tsx ─────┬── import + call ──▶ app-event-listeners.ts (NEW)       │
│               ├── import + entry ─▶ btw-command.tsx         (NEW)       │
│               ├── import + entry ─▶ goto-command.tsx        (NEW)       │
│               ├── import + entry ─▶ clear-commands.tsx      (NEW)       │
│               ├── import + use ───▶ terminal-title.tsx      (NEW)       │
│               └── import + call ──▶ copy-handler.ts        (NEW)       │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                    ALREADY-EXTRACTED MODULES (pattern reference)        │
│                                                                        │
│  session/history-cache.ts    ── factory function, returns typed object  │
│  session/doom-loop.ts        ── factory function, returns typed object  │
│  session/part-coalescer.ts   ── factory function, returns typed object  │
│  orchestration/*.ts          ── standalone functions, direct exports    │
│  tui/routes/session/task-session-id.ts ── pure function, typed args    │
└─────────────────────────────────────────────────────────────────────────┘
```

**Patterns used:**

- **Factory pattern** (history-cache, doom-loop, part-coalescer): `export const create = (input): Type => { ... }` — stateful modules that return an interface object.
- **Pure function pattern** (orchestration/\*, task-session-id): `export function name(opts): Result` — stateless utilities.
- **Effect.fn pattern** (within prompt.ts layer): Functions that use `Effect.fn("Name")(function* (...) { ... })` for traced effectful operations.

All new extractions follow the **pure function pattern** or **Effect.fn pattern** depending on whether they need Effect context.

## Module Specifications

### 1. `session/prompt-reminders.ts` (Extract from `prompt.ts`)

**File path:** `packages/opencode/src/session/prompt-reminders.ts`

**Source location:** `prompt.ts` lines 253–394 — the `insertReminders` function

**Exact code block being extracted:**

```
const insertReminders = Effect.fn("SessionPrompt.insertReminders")(function* (input: {
  messages: MessageV2.WithParts[]
  agent: Agent.Info
  session: Session.Info
}) {
  // ... lines 253-394
})
```

**Exports:**

```typescript
export type InsertRemindersInput = {
  messages: MessageV2.WithParts[]
  agent: Agent.Info
  session: Session.Info
}

export type InsertRemindersResult = {
  messages: MessageV2.WithParts[]
  changed: boolean
}

export const insertReminders: (
  input: InsertRemindersInput,
) => Effect.Effect<InsertRemindersResult, never, Session.Service | AppFileSystem.Service>
```

**Imports (dependencies):**

```typescript
import { Effect } from "effect"
import { Agent } from "../agent/agent"
import { Session } from "."
import { MessageV2 } from "./message-v2"
import { PartID } from "./schema"
import { Flag } from "../flag/flag"
import { AppFileSystem } from "../filesystem"
import PROMPT_PLAN from "./prompt/plan.txt"
import BUILD_SWITCH from "./prompt/build-switch.txt"
```

**Hook signature left in `prompt.ts`:**

```typescript
import { insertReminders } from "./prompt-reminders"
// At line ~1573:
const reminderResult = yield * insertReminders({ messages: msgs, agent, session })
```

**Note:** The function uses `sessions` (from `Session.Service`) and `fsys` (from `AppFileSystem.Service`). In the extracted module, these must be yielded from the Effect context. The function currently captures these from the layer closure. The extraction must convert it to accept them via Effect service requirements or pass them as parameters. **Recommended approach:** Pass `sessions` and `fsys` as part of the input to keep the module pure and avoid re-yielding services.

**Revised exports (parameter-passing approach, matching existing patterns):**

```typescript
export type InsertRemindersDeps = {
  sessions: Pick<Session.Interface, "updatePart">
  fsys: Pick<AppFileSystem.Interface, "existsSafe" | "ensureDir">
}

export const insertReminders: (
  deps: InsertRemindersDeps,
  input: InsertRemindersInput,
) => Effect.Effect<InsertRemindersResult>
```

---

### 2. `session/subtask-handler.ts` (Extract from `prompt.ts`)

**File path:** `packages/opencode/src/session/subtask-handler.ts`

**Source location:** `prompt.ts` lines 566–773 — the `handleSubtask` function

**Exact code block being extracted:**

```
const handleSubtask = Effect.fn("SessionPrompt.handleSubtask")(function* (input: {
  task: MessageV2.SubtaskPart
  model: Provider.Model
  lastUser: MessageV2.User
  sessionID: SessionID
  session: Session.Info
  msgs: MessageV2.WithParts[]
}) {
  // ... lines 566-773
})
```

**Exports:**

```typescript
export type HandleSubtaskInput = {
  task: MessageV2.SubtaskPart
  model: Provider.Model
  lastUser: MessageV2.User
  sessionID: SessionID
  session: Session.Info
  msgs: MessageV2.WithParts[]
}

export type HandleSubtaskDeps = {
  sessions: Pick<Session.Interface, "updateMessage" | "updatePart">
  agents: Pick<Agent.Interface, "get" | "list">
  registry: Pick<ToolRegistry.Interface, "named">
  plugin: Pick<Plugin.Interface, "trigger">
  permission: Pick<Permission.Interface, "ask">
  bus: Pick<Bus.Interface, "publish">
  status: Pick<SessionStatus.Interface, "set">
  getModel: (providerID: ProviderID, modelID: ModelID, sessionID: SessionID) => Effect.Effect<Provider.Model>
}

export const handleSubtask: (deps: HandleSubtaskDeps, input: HandleSubtaskInput) => Effect.Effect<void>
```

**Imports (dependencies):**

```typescript
import { Effect } from "effect"
import { ulid } from "ulid"
import { Session } from "."
import { SessionID, MessageID, PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { ToolRegistry } from "../tool/registry"
import { TaskTool } from "../tool/task"
import { Plugin } from "../plugin"
import { Permission } from "../permission"
import { Bus } from "../bus"
import { SessionStatus } from "./status"
import { SessionRetry } from "./retry"
import { NamedError } from "@opencode-ai/util/error"
import { InstanceState } from "../effect/instance-state"
```

**Hook signature left in `prompt.ts`:**

```typescript
import { handleSubtask } from "./subtask-handler"
// At line ~1534 (inside runLoop):
yield * handleSubtask(deps, { task, model, lastUser, sessionID, session, msgs })
```

---

### 3. `session/reasoning-handler.ts` — ANALYSIS: NOT NEEDED

**Analysis:** After reading `processor.ts` carefully, the "reasoning part handler" is not a single extractable block. The reasoning logic is spread across three event cases in `handleEvent` (lines 126–159: `reasoning-start`, `reasoning-delta`, `reasoning-end`). Each is 5–12 lines and deeply intertwined with `ctx.reasoningMap` and `coalescer.update()`. Extracting these would create more complexity than it saves — the hook overhead would exceed the extracted code.

**Decision:** Skip this extraction. The `processor.ts` diff is already manageable at ~123 lines with `doom-loop.ts` and `part-coalescer.ts` already extracted. The reasoning handlers are small, self-contained switch cases that don't warrant separate modules.

**Impact on plan:** `processor.ts` local diff stays at ~123 lines instead of dropping to ~20. This is acceptable — the remaining diff is mostly in `ProcessorContext` type additions and switch case handlers that are unlikely to conflict with upstream changes to other cases.

---

### 4. `tool/plugin-signature.ts` (Extract from `registry.ts`)

**File path:** `packages/opencode/src/tool/plugin-signature.ts`

**Source location:** `registry.ts` lines 213–234 — the `pluginDefinitionSignature` function

**Exact code block being extracted:**

```
const pluginDefinitionSignature = Effect.fnUntraced(function* (s: State) {
  const hooks = yield* plugin.list()
  const ids: string[] = []
  for (const hook of hooks) {
    const fn = (hook as any)["tool.definition"]
    if (!fn) continue
    let hookID = s.pluginHookID.get(hook as object)
    if (!hookID) {
      hookID = s.pluginHookSeq++
      s.pluginHookID.set(hook as object, hookID)
      s.cache = undefined
    }
    let fnID = s.pluginFunctionID.get(fn as Function)
    if (!fnID) {
      fnID = s.pluginHookSeq++
      s.pluginFunctionID.set(fn as Function, fnID)
      s.cache = undefined
    }
    ids.push(`${hookID}:${fnID}`)
  }
  return ids.join(",")
})
```

**Exports:**

```typescript
export type PluginSignatureState = {
  pluginHookID: WeakMap<object, number>
  pluginFunctionID: WeakMap<Function, number>
  pluginHookSeq: number
  cache?: unknown // set to undefined when signature changes
}

export function computePluginDefinitionSignature(hooks: readonly object[], state: PluginSignatureState): string
```

**Note:** This can be extracted as a **pure function** (no Effect needed) since `plugin.list()` can be called before invoking it, passing the result as `hooks`. This simplifies the extraction.

**Imports:**

```typescript
// No external imports — pure function
```

**Hook signature left in `registry.ts`:**

```typescript
import { computePluginDefinitionSignature } from "./plugin-signature"
// At line ~283:
const hooks = yield * plugin.list()
const pluginSignature = computePluginDefinitionSignature(hooks, s)
```

---

### 5. `tool/plugin-hook-cache.ts` (Extract from `registry.ts`)

**File path:** `packages/opencode/src/tool/plugin-hook-cache.ts`

**Source location:** `registry.ts` lines 53–56 (State type fields) and lines 194–197 (initialization)

**Analysis:** The "plugin hook cache" is really just three fields on the `State` type (`pluginHookID`, `pluginFunctionID`, `pluginHookSeq`) and their initialization. This is only ~10 lines total. Extracting to a separate file would add import overhead without meaningful conflict reduction.

**Decision:** Merge with `plugin-signature.ts` instead of a separate module. The `PluginSignatureState` type already captures these fields. The initialization (`pluginHookID: new WeakMap(), pluginFunctionID: new WeakMap(), pluginHookSeq: 1`) is trivial.

**Revised `plugin-signature.ts` exports:**

```typescript
export type PluginSignatureState = {
  pluginHookID: WeakMap<object, number>
  pluginFunctionID: WeakMap<Function, number>
  pluginHookSeq: number
  cache?: unknown
}

export function createPluginSignatureState(): PluginSignatureState

export function computePluginDefinitionSignature(hooks: readonly object[], state: PluginSignatureState): string
```

---

### 6. `tool/tool-filter.ts` (Extract from `registry.ts`)

**File path:** `packages/opencode/src/tool/tool-filter.ts`

**Source location:** `registry.ts` lines 301–313 — the `.filter()` call inside `tools`

**Exact code block being extracted:**

```
const filtered = (yield* all(s.custom)).filter((tool) => {
  if (tool.id === CodeSearchTool.id || tool.id === WebSearchTool.id) {
    return input.providerID === ProviderID.opencode || Flag.OPENCODE_ENABLE_EXA
  }
  const usePatch =
    !!Env.get("OPENCODE_E2E_LLM_URL") ||
    (input.modelID.includes("gpt-") && !input.modelID.includes("oss") && !input.modelID.includes("gpt-4"))
  if (tool.id === ApplyPatchTool.id) return usePatch
  if (tool.id === EditTool.id || tool.id === WriteTool.id) return !usePatch
  return true
})
```

**Exports:**

```typescript
export type ToolFilterInput = {
  providerID: ProviderID
  modelID: ModelID
}

export function filterTools(tools: Tool.Info[], input: ToolFilterInput): Tool.Info[]
```

**Imports:**

```typescript
import { ProviderID, type ModelID } from "../provider/schema"
import { Flag } from "../flag/flag"
import { Env } from "../env"
import { CodeSearchTool } from "./codesearch"
import { WebSearchTool } from "./websearch"
import { ApplyPatchTool } from "./apply_patch"
import { EditTool } from "./edit"
import { WriteTool } from "./write"
import type { Tool } from "./tool"
```

**Hook signature left in `registry.ts`:**

```typescript
import { filterTools } from "./tool-filter"
// At line ~301:
const filtered = filterTools(yield * all(s.custom), { providerID: input.providerID, modelID: input.modelID })
```

---

### 7. `orchestration/task-spawn.ts` (Extract from `task.ts`)

**File path:** `packages/opencode/src/orchestration/task-spawn.ts`

**Source location:** `task.ts` lines 69–139 — the subagent spawn block inside `executeTask`

**Exact code block being extracted:**

```
const subagent = existing
  ? { session: existing, spawned: false as const }
  : await (async () => {
      const maxDepth = cfg.experimental?.max_subagent_depth ?? 3
      const maxDescendants = cfg.experimental?.max_subagent_descendants ?? 50
      const spawnInfo = await reserveSpawn({
        sessionID: ctx.sessionID,
        parentID: ctx.sessionID,
        maxDepth,
        maxDescendants,
      }).catch(async (err) => {
        if (err instanceof SpawnLimitError) {
          await Bus.publish(OrchestrationEvent.SpawnRejected, {
            sessionID: ctx.sessionID,
            agent: next.name,
            reason: err.reason,
            limit: err.limit,
            current: err.current,
          })
        }
        throw err
      })
      try {
        const session = await Session.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          permission: [
            ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
            ...(canTask ? [] : [{ permission: id, pattern: "*" as const, action: "deny" as const }]),
            ...(cfg.experimental?.primary_tools?.map((item) => ({
              pattern: "*", action: "allow" as const, permission: item,
            })) ?? []),
          ],
        })
        await Bus.publish(OrchestrationEvent.Spawn, {
          sessionID: session.id,
          parentSessionID: ctx.sessionID,
          agent: next.name,
          depth: spawnInfo.depth,
        })
        return { session, spawnInfo, spawned: true as const }
      } catch (err) {
        spawnInfo.release()
        throw err
      }
    })()
```

**Exports:**

```typescript
export type SpawnSubagentInput = {
  parentSessionID: SessionID
  agent: Agent.Info
  description: string
  canTask: boolean
  canTodo: boolean
  primaryTools?: string[]
  maxDepth: number
  maxDescendants: number
}

export type SpawnResult =
  | { session: Session.Info; spawned: false }
  | { session: Session.Info; spawnInfo: SpawnReservation; spawned: true }

export async function spawnSubagent(existing: Session.Info | undefined, input: SpawnSubagentInput): Promise<SpawnResult>
```

**Imports:**

```typescript
import { Session } from "../session"
import type { SessionID } from "../session/schema"
import type { Agent } from "../agent/agent"
import { Bus } from "../bus"
import { OrchestrationEvent } from "./events"
import { reserveSpawn, SpawnLimitError, type SpawnReservation } from "./spawn-limits"
```

**Hook signature left in `task.ts`:**

```typescript
import { spawnSubagent } from "../orchestration/task-spawn"
// At line ~69:
const subagent = await spawnSubagent(existing, {
  parentSessionID: ctx.sessionID,
  agent: next,
  description: params.description,
  canTask,
  canTodo,
  primaryTools: cfg.experimental?.primary_tools,
  maxDepth: cfg.experimental?.max_subagent_depth ?? 3,
  maxDescendants: cfg.experimental?.max_subagent_descendants ?? 50,
})
```

---

### 8. `orchestration/task-model-resolver.ts` (Extract from `task.ts`)

**File path:** `packages/opencode/src/orchestration/task-model-resolver.ts`

**Source location:** `task.ts` lines 151–162 — model resolution composition

**Exact code block being extracted:**

```
const categoryModel = resolveCategory({
  category: params.task_category ?? params.subagent_type,
  categories: cfg.experimental?.task_categories ?? {},
  fallback: model,
})
const ultraworkModel =
  detectUltrawork(params.prompt, cfg.experimental?.ultrawork_model) ??
  resolveUltrawork({
    enabled: params.use_ultrawork === true,
    ultraworkModel: cfg.experimental?.ultrawork_model,
  })
const finalModel = ultraworkModel ?? categoryModel
```

**Exports:**

```typescript
import type { ModelRef } from "./category-routing"

export type ResolveTaskModelInput = {
  prompt: string
  subagentType: string
  taskCategory?: string
  useUltrawork?: boolean
  categories: Record<string, ModelRef>
  ultraworkModel?: ModelRef
  fallback: ModelRef
}

export function resolveTaskModel(input: ResolveTaskModelInput): ModelRef
```

**Imports:**

```typescript
import { resolve as resolveCategory, type ModelRef } from "./category-routing"
import { detect as detectUltrawork } from "./ultrawork"
import { resolveModel as resolveUltrawork } from "./ultrawork-hook"
```

**Hook signature left in `task.ts`:**

```typescript
import { resolveTaskModel } from "../orchestration/task-model-resolver"
// At line ~151:
const finalModel = resolveTaskModel({
  prompt: params.prompt,
  subagentType: params.subagent_type,
  taskCategory: params.task_category,
  useUltrawork: params.use_ultrawork,
  categories: cfg.experimental?.task_categories ?? {},
  ultraworkModel: cfg.experimental?.ultrawork_model,
  fallback: model,
})
```

---

### 9. `tui/effect/app-event-listeners.ts` (Extract from `app.tsx`)

**File path:** `packages/opencode/src/cli/cmd/tui/effect/app-event-listeners.ts`

**Source location:** `app.tsx` lines 1095–1184 — the event listener setup block

**Exact code block being extracted:**

```
const off = [
  sdk.event.on(TuiEvent.CommandExecute.type, (evt) => { ... }),
  sdk.event.on(TuiEvent.ToastShow.type, (evt) => { ... }),
  sdk.event.on(TuiEvent.SessionSelect.type, (evt) => { ... }),
  sdk.event.on("session.deleted", (evt) => { ... }),
  sdk.event.on("session.error", (evt) => { ... }),
  sdk.event.on("installation.update-available", async (evt) => { ... }),
]
```

**Exports:**

```typescript
import type { ReturnType as SDKType } from "@tui/context/sdk"
import type { ReturnType as RouteType } from "@tui/context/route"
import type { ReturnType as ToastType } from "@tui/ui/toast"
import type { ReturnType as CommandType } from "@tui/component/dialog-command"
import type { ReturnType as DialogType } from "@tui/ui/dialog"
import type { ReturnType as KVType } from "@tui/context/kv"
import type { ReturnType as ExitType } from "@tui/context/exit"

export type AppEventListenersDeps = {
  sdk: SDKType
  route: RouteType
  command: CommandType
  toast: ToastType
  dialog: DialogType
  kv: KVType
  exit: ExitType
}

export function setupAppEventListeners(deps: AppEventListenersDeps): (() => void)[]
```

**Hook signature left in `app.tsx`:**

```typescript
import { setupAppEventListeners } from "@tui/effect/app-event-listeners"
// At line ~1095:
const off = setupAppEventListeners({ sdk, route, command, toast, dialog, kv, exit })
```

---

### 10. `tui/command/btw-command.tsx` (Extract from `app.tsx`)

**File path:** `packages/opencode/src/cli/cmd/tui/command/btw-command.tsx`

**Source location:** `app.tsx` lines 872–946 — the `/btw` command entry in `command.register()`

**Exact code block being extracted:**

```
{
  title: "By the way",
  value: "btw.ask",
  slash: { name: "btw" },
  onSelect: async () => {
    const q = await DialogPrompt.show(dialog, "btw", { ... })
    // ... lines 878-946
  },
  category: "Agent",
}
```

**Exports:**

```typescript
export type BtwCommandDeps = {
  dialog: DialogType
  local: LocalType
  toast: ToastType
  sync: SyncType
  sdk: SDKType
  route: RouteType
}

export function createBtwCommand(deps: BtwCommandDeps): CommandEntry
```

**Hook signature left in `app.tsx`:**

```typescript
import { createBtwCommand } from "@tui/command/btw-command"
// Inside command.register() array:
createBtwCommand({ dialog, local, toast, sync, sdk, route }),
```

---

### 11. `tui/command/goto-command.tsx` (Extract from `app.tsx`)

**File path:** `packages/opencode/src/cli/cmd/tui/command/goto-command.tsx`

**Source location:** `app.tsx` lines 957–998 — the `/goto` command entry

**Exact code block being extracted:**

```
{
  title: "Change directory",
  value: "app.goto",
  slash: { name: "goto", aliases: ["cd"] },
  onSelect: async () => {
    const path = await DialogPrompt.show(dialog, "Change directory", { ... })
    // ... lines 964-998
  },
  category: "System",
}
```

**Exports:**

```typescript
export type GotoCommandDeps = {
  dialog: DialogType
  sdk: SDKType
  toast: ToastType
  sync: SyncType
}

export function createGotoCommand(deps: GotoCommandDeps): CommandEntry
```

**Hook signature left in `app.tsx`:**

```typescript
import { createGotoCommand } from "@tui/command/goto-command"
// Inside command.register() array:
createGotoCommand({ dialog, sdk, toast, sync }),
```

---

### 12. `tui/command/clear-commands.tsx` (Extract from `app.tsx`)

**File path:** `packages/opencode/src/cli/cmd/tui/command/clear-commands.tsx`

**Source location:** `app.tsx` lines 518–669 — the `/clear` and `/clear-compact` command entries

**Exact code block being extracted:**

```
{
  title: "Clear conversation",
  value: "session.clear",
  // ... lines 518-572
},
{
  title: "Compact and clear conversation",
  value: "session.compact_clear",
  // ... lines 573-669
},
```

**Exports:**

```typescript
export type ClearCommandsDeps = {
  sdk: SDKType
  sync: SyncType
  kv: KVType
  toast: ToastType
  route: RouteType
  local: LocalType
}

export function createClearCommands(deps: ClearCommandsDeps): CommandEntry[]
```

**Hook signature left in `app.tsx`:**

```typescript
import { createClearCommands } from "@tui/command/clear-commands"
// Inside command.register() array:
...createClearCommands({ sdk, sync, kv, toast, route, local }),
```

---

### 13. `tui/component/terminal-title.tsx` (Extract from `app.tsx`)

**File path:** `packages/opencode/src/cli/cmd/tui/component/terminal-title.tsx`

**Source location:** `app.tsx` lines 362–386 — the terminal title `createEffect`

**Exact code block being extracted:**

```
createEffect(() => {
  if (!terminalTitleEnabled() || Flag.OPENCODE_DISABLE_TERMINAL_TITLE) return
  if (route.data.type === "home") {
    renderer.setTerminalTitle("OpenCode")
    return
  }
  if (route.data.type === "session") {
    const session = sync.session.get(route.data.sessionID)
    if (!session || SessionApi.isDefaultTitle(session.title)) {
      renderer.setTerminalTitle("OpenCode")
      return
    }
    const title = session.title.length > 40 ? session.title.slice(0, 37) + "..." : session.title
    renderer.setTerminalTitle(`OC | ${title}`)
    return
  }
  if (route.data.type === "plugin") {
    renderer.setTerminalTitle(`OC | ${route.data.id}`)
  }
})
```

**Exports:**

```typescript
export type TerminalTitleDeps = {
  terminalTitleEnabled: () => boolean
  route: RouteType
  sync: SyncType
  renderer: RendererType
}

export function useTerminalTitle(deps: TerminalTitleDeps): void
```

**Hook signature left in `app.tsx`:**

```typescript
import { useTerminalTitle } from "@tui/component/terminal-title"
// At line ~362:
useTerminalTitle({ terminalTitleEnabled, route, sync, renderer })
```

---

### 14. `tui/util/copy-handler.ts` (Extract from `app.tsx`)

**File path:** `packages/opencode/src/cli/cmd/tui/util/copy-handler.ts`

**Source location:** `app.tsx` lines 340–349 — the console `onCopySelection` handler

**Exact code block being extracted:**

```
renderer.console.onCopySelection = async (text: string) => {
  if (!text || text.length === 0) return
  await Clipboard.copy(text)
    .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
    .catch(toast.error)
  renderer.clearSelection()
}
```

**Exports:**

```typescript
export type CopyHandlerDeps = {
  renderer: RendererType
  toast: ToastType
}

export function setupConsoleCopyHandler(deps: CopyHandlerDeps): void
```

**Hook signature left in `app.tsx`:**

```typescript
import { setupConsoleCopyHandler } from "@tui/util/copy-handler"
// At line ~340:
setupConsoleCopyHandler({ renderer, toast })
```

## Interfaces

### prompt-reminders

| Method          | Input                                                    | Output                          | Behavior                                                                                                                           | Errors                                          |
| --------------- | -------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| insertReminders | `deps: InsertRemindersDeps, input: InsertRemindersInput` | `Effect<InsertRemindersResult>` | Injects plan-mode system reminders and BUILD_SWITCH prompts into the last user message based on agent state and flag configuration | None (returns unchanged if no reminders needed) |

### subtask-handler

| Method        | Input                                                | Output         | Behavior                                                                                                                          | Errors                                                        |
| ------------- | ---------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| handleSubtask | `deps: HandleSubtaskDeps, input: HandleSubtaskInput` | `Effect<void>` | Creates assistant message, runs task tool, handles retry/interrupt, updates tool part state, optionally adds summary user message | `NamedError.Unknown` (agent not found), task execution errors |

### plugin-signature

| Method                           | Input                                                   | Output                 | Behavior                                                                                                                    | Errors |
| -------------------------------- | ------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------ |
| createPluginSignatureState       | (none)                                                  | `PluginSignatureState` | Creates initial state with empty WeakMaps and seq=1                                                                         | None   |
| computePluginDefinitionSignature | `hooks: readonly object[], state: PluginSignatureState` | `string`               | Assigns stable IDs to plugin hooks/functions, returns comma-joined signature; mutates state.cache to undefined on new hooks | None   |

### tool-filter

| Method      | Input                                        | Output        | Behavior                                                                                                          | Errors |
| ----------- | -------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------- | ------ |
| filterTools | `tools: Tool.Info[], input: ToolFilterInput` | `Tool.Info[]` | Removes CodeSearch/WebSearch unless opencode provider or EXA flag; swaps Edit/Write for ApplyPatch based on model | None   |

### task-spawn

| Method        | Input                                                            | Output                 | Behavior                                                                                                              | Errors            |
| ------------- | ---------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------- |
| spawnSubagent | `existing: Session.Info \| undefined, input: SpawnSubagentInput` | `Promise<SpawnResult>` | If existing session, wraps it; otherwise checks spawn limits, creates session with permissions, publishes Spawn event | `SpawnLimitError` |

### task-model-resolver

| Method           | Input                          | Output     | Behavior                                                                                                     | Errors |
| ---------------- | ------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------ | ------ |
| resolveTaskModel | `input: ResolveTaskModelInput` | `ModelRef` | Resolves category model, checks ultrawork keyword detection and explicit flag, returns ultrawork ?? category | None   |

### app-event-listeners

| Method                 | Input                         | Output           | Behavior                                                                                                                       | Errors |
| ---------------------- | ----------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------ |
| setupAppEventListeners | `deps: AppEventListenersDeps` | `(() => void)[]` | Registers handlers for CommandExecute, ToastShow, SessionSelect, session.deleted, session.error, installation.update-available | None   |

### btw-command / goto-command / clear-commands

| Method              | Input                     | Output           | Behavior                                             | Errors |
| ------------------- | ------------------------- | ---------------- | ---------------------------------------------------- | ------ |
| createBtwCommand    | `deps: BtwCommandDeps`    | `CommandEntry`   | Returns command entry for `/btw` quick-question flow | None   |
| createGotoCommand   | `deps: GotoCommandDeps`   | `CommandEntry`   | Returns command entry for `/goto` directory change   | None   |
| createClearCommands | `deps: ClearCommandsDeps` | `CommandEntry[]` | Returns 2 entries: `/clear` and `/clear-compact`     | None   |

### terminal-title / copy-handler

| Method                  | Input                     | Output | Behavior                                                           | Errors |
| ----------------------- | ------------------------- | ------ | ------------------------------------------------------------------ | ------ |
| useTerminalTitle        | `deps: TerminalTitleDeps` | `void` | Creates reactive effect that updates terminal title based on route | None   |
| setupConsoleCopyHandler | `deps: CopyHandlerDeps`   | `void` | Assigns `onCopySelection` callback to renderer console             | None   |

## Data Flow

### Prompt Reminders Flow

| Step | Component           | Action                                                                | Next             |
| ---- | ------------------- | --------------------------------------------------------------------- | ---------------- |
| 1    | `prompt.ts` runLoop | Calls `insertReminders(deps, { messages, agent, session })`           | prompt-reminders |
| 2    | prompt-reminders    | Checks agent name, Flag state, plan file existence                    | prompt-reminders |
| 3    | prompt-reminders    | Pushes synthetic TextPart onto last user message                      | prompt.ts        |
| 4    | `prompt.ts` runLoop | Uses returned `{ messages, changed }` to decide model message rebuild | processor        |

### Subtask Handler Flow

| Step | Component           | Action                                                      | Next            |
| ---- | ------------------- | ----------------------------------------------------------- | --------------- |
| 1    | `prompt.ts` runLoop | Detects subtask part, calls `handleSubtask(deps, input)`    | subtask-handler |
| 2    | subtask-handler     | Creates assistant message via `deps.sessions.updateMessage` | subtask-handler |
| 3    | subtask-handler     | Creates tool part via `deps.sessions.updatePart`            | subtask-handler |
| 4    | subtask-handler     | Calls `taskTool.execute(args, ctx)` with retry policy       | TaskTool        |
| 5    | TaskTool            | Spawns subagent session, runs prompt loop                   | subtask-handler |
| 6    | subtask-handler     | Updates tool part to completed/error state                  | prompt.ts       |

### Task Tool Spawn Flow

| Step | Component             | Action                                                  | Next                |
| ---- | --------------------- | ------------------------------------------------------- | ------------------- |
| 1    | `task.ts` executeTask | Calls `spawnSubagent(existing, input)`                  | task-spawn          |
| 2    | task-spawn            | Checks existing session or calls `reserveSpawn()`       | spawn-limits        |
| 3    | task-spawn            | Creates session with permissions via `Session.create()` | task-spawn          |
| 4    | task-spawn            | Publishes `OrchestrationEvent.Spawn`                    | task.ts             |
| 5    | `task.ts` executeTask | Calls `resolveTaskModel(input)`                         | task-model-resolver |
| 6    | task-model-resolver   | Composes category + ultrawork overrides                 | task.ts             |
| 7    | `task.ts` executeTask | Uses `finalModel` for `SessionPrompt.prompt()`          | SessionPrompt       |

### Tool Registry Filter Flow

| Step | Component     | Action                                                              | Next             |
| ---- | ------------- | ------------------------------------------------------------------- | ---------------- |
| 1    | `registry.ts` | Computes `pluginSignature` via `computePluginDefinitionSignature()` | plugin-signature |
| 2    | `registry.ts` | Checks cache key match                                              | registry.ts      |
| 3    | `registry.ts` | Calls `filterTools(allTools, { providerID, modelID })`              | tool-filter      |
| 4    | tool-filter   | Applies provider/model/flag rules, returns filtered list            | registry.ts      |

**Error Flows:**

- `insertReminders`: No errors — returns unchanged input if conditions not met.
- `handleSubtask`: Agent not found → publishes `Session.Event.Error` + throws `NamedError.Unknown`. Task execution failure → catches error, updates tool part to "error" state, logs warning. Interrupt → updates tool part to "error" with "Cancelled".
- `spawnSubagent`: `SpawnLimitError` → publishes `OrchestrationEvent.SpawnRejected`, re-throws. Session creation failure → releases spawn reservation, re-throws.
- `resolveTaskModel`: No errors — always returns a valid `ModelRef` (falls back to input fallback).
- `filterTools`: No errors — returns filtered array (may be empty).

## Data Model

No new database entities. All extractions operate on existing types:

| Entity                 | Fields (key types used)                                                   | Relationships           | Constraints                        |
| ---------------------- | ------------------------------------------------------------------------- | ----------------------- | ---------------------------------- |
| `MessageV2.WithParts`  | `info: MessageV2.Info, parts: MessageV2.Part[]`                           | Session → Messages      | Existing schema                    |
| `Session.Info`         | `id: SessionID, parentID?, title, permission, revert`                     | Parent ↔ Child sessions | Existing schema                    |
| `Agent.Info`           | `name, model?, permission, steps?, mode, variant`                         | Agent → Session         | Existing schema                    |
| `Provider.Model`       | `id, providerID, api, variants?`                                          | Model → Provider        | Existing schema                    |
| `Tool.Info`            | `id, init, parallelSafe?`                                                 | Tool → Registry         | Existing schema                    |
| `PluginSignatureState` | `pluginHookID: WeakMap, pluginFunctionID: WeakMap, pluginHookSeq: number` | (NEW, in-memory only)   | Mutable state within InstanceState |

## Decisions

| Decision                                                                 | Choice                                           | Reason                                                                                                                          | Alternatives                                      | Tradeoffs                                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------ |
| Skip `reasoning-handler.ts` extraction                                   | Keep reasoning logic inline in `processor.ts`    | Only ~25 lines across 3 switch cases; deeply coupled to `ctx.reasoningMap` and `coalescer`; extraction overhead exceeds benefit | Extract as separate module with context parameter | +5 lines hook overhead for -25 lines extracted; net negative       |
| Merge `plugin-hook-cache.ts` into `plugin-signature.ts`                  | Single module with state type + compute function | Cache state is only used by signature computation; separate file adds import overhead for ~10 lines                             | Keep as separate module per plan                  | Simpler dependency graph; one fewer file to create                 |
| Use dependency injection (parameter passing) for `prompt.ts` extractions | Pass `deps` object as first parameter            | Avoids re-yielding Effect services in extracted modules; matches how `task-session-id.ts` works (pure function with typed args) | Use Effect service requirements (Layer-based)     | More explicit but slightly more verbose call sites                 |
| Extract TUI commands as factory functions returning `CommandEntry`       | `createXxxCommand(deps): CommandEntry`           | Matches how `command.register()` expects array of entries; clean composition                                                    | Extract as SolidJS components with hooks          | Factory pattern is simpler, no JSX needed for command logic        |
| Keep `app.tsx` event listeners as setup function returning cleanup array | `setupAppEventListeners(deps): (() => void)[]`   | Matches existing `onCleanup(() => off.forEach(fn => fn()))` pattern                                                             | Extract as SolidJS `onMount` effect               | Preserves existing cleanup pattern exactly                         |
| Pure functions for `tool-filter` and `task-model-resolver`               | Stateless functions with typed input/output      | No Effect context needed; simplest possible extraction                                                                          | Effect.fn wrappers                                | Pure functions are easier to test and have zero framework overhead |

## Risks

| Risk                                                               | Impact                                                         | Likelihood | Mitigation                                                                                                                                                       |
| ------------------------------------------------------------------ | -------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `insertReminders` closure captures break when extracted            | Tests fail — plan mode or BUILD_SWITCH injection stops working | Medium     | The function uses `sessions.updatePart` and `fsys.existsSafe` from closure. Pass as `deps` parameter. Run `bun --cwd packages/opencode test` after extraction.   |
| `handleSubtask` has implicit dependency on `InstanceState.context` | Runtime error — `ctx.directory`/`ctx.worktree` unavailable     | Medium     | Must yield `InstanceState.context` inside the extracted function, or pass `ctx` as parameter. Verify with subtask-related tests.                                 |
| TUI command extractions break SolidJS reactivity                   | Commands silently fail — no error, just no action              | Low        | TUI commands are imperative (`async () => { ... }`), not reactive. Factory pattern preserves this. Manual test: run `/btw`, `/goto`, `/clear` after extraction.  |
| `pluginDefinitionSignature` extraction changes mutation timing     | Tool cache invalidation stops working — stale tools served     | Medium     | The function mutates `state.cache = undefined` as side effect. Must pass mutable state reference. Unit test: register new plugin hook, verify cache invalidated. |
| Cherry-pick during Phase 3 misses a change                         | Feature regression in restructured branch                      | Medium     | Diff final state against original branch: `git diff dev-pre-restructure..dev -- packages/opencode/src/` must show only file moves, no logic changes.             |
| `processor.ts` stays at ~123 lines diff (reasoning not extracted)  | Slightly higher conflict surface than planned                  | Low        | 123 lines is manageable. The reasoning cases are in a switch block — upstream changes to other cases won't conflict. Accept this tradeoff.                       |

## Test Plan

### Unit Tests

**For each extracted module, create a test file:**

| Module                | Test File                                        | Key Scenarios                                                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt-reminders`    | `test/session/prompt-reminders.test.ts`          | (1) Plan agent injects PROMPT_PLAN text. (2) Build agent after plan injects BUILD_SWITCH. (3) Non-plan agent returns unchanged. (4) Experimental plan mode creates system-reminder. (5) Plan file exists vs doesn't exist paths.                         |
| `subtask-handler`     | `test/session/subtask-handler.test.ts`           | (1) Happy path: task executes, part updated to completed. (2) Agent not found: throws NamedError. (3) Task execution fails: part updated to error. (4) Interrupt: part updated to error with "Cancelled". (5) Command subtask adds summary user message. |
| `plugin-signature`    | `test/tool/plugin-signature.test.ts`             | (1) Empty hooks returns empty string. (2) Same hooks return same signature. (3) New hook invalidates cache (sets undefined). (4) Stable across calls with same hooks.                                                                                    |
| `tool-filter`         | `test/tool/tool-filter.test.ts`                  | (1) CodeSearch/WebSearch included for opencode provider. (2) CodeSearch/WebSearch excluded for other providers. (3) ApplyPatch included for gpt- models. (4) Edit/Write excluded when ApplyPatch active.                                                 |
| `task-spawn`          | `test/orchestration/task-spawn.test.ts`          | (1) Existing session wraps without spawning. (2) New session reserves spawn + creates session. (3) SpawnLimitError publishes rejection event. (4) Session creation failure releases reservation.                                                         |
| `task-model-resolver` | `test/orchestration/task-model-resolver.test.ts` | (1) Category match returns category model. (2) Ultrawork keyword returns ultrawork model. (3) Explicit use_ultrawork=true returns ultrawork model. (4) No overrides returns fallback. (5) Ultrawork takes priority over category.                        |

**Mock dependencies:** Use typed mock objects matching the `Deps` interfaces. For Effect-based modules, use `Effect.runPromise` with test layers.

**Coverage target:** Each extracted module should have ≥90% line coverage.

### Integration Tests

| Test                                    | Components                                             | Verification                                                                     |
| --------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Prompt loop with reminders              | `prompt.ts` + `prompt-reminders.ts`                    | Run a plan-mode prompt, verify PROMPT_PLAN text appears in messages              |
| Prompt loop with subtask                | `prompt.ts` + `subtask-handler.ts`                     | Run a prompt with subtask part, verify child session created and result returned |
| Tool registry with plugin signature     | `registry.ts` + `plugin-signature.ts`                  | Register plugin, call `tools()`, verify cache invalidation on plugin change      |
| Task tool with spawn + model resolution | `task.ts` + `task-spawn.ts` + `task-model-resolver.ts` | Execute task tool, verify correct model used and spawn limits enforced           |

**Run after each extraction:**

```bash
bun --cwd packages/opencode test
bun --cwd packages/opencode typecheck
bun --cwd packages/opencode run build
```

### End-to-End Tests

| Journey           | Steps                                                    | Success Criteria                                   |
| ----------------- | -------------------------------------------------------- | -------------------------------------------------- |
| Full prompt loop  | Create session → send prompt → verify response           | Response received, no errors in bus                |
| Subtask execution | Send prompt with subtask part → verify child session     | Child session created, task tool part completed    |
| `/btw` command    | Trigger btw command → ask question → verify dialog       | Dialog shows, response streams, cleanup on dismiss |
| `/clear` command  | Create session with messages → run /clear → verify empty | All messages deleted, cost preserved in KV         |
| `/goto` command   | Run /goto with valid path → verify directory change      | SDK directory changes, toast confirms              |

### Non-Functional Tests

| Category      | Requirement                                                    | Verification                                                                            |
| ------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Performance   | No regression in prompt loop latency                           | Compare `time` output of 10-prompt benchmark before/after extraction                    |
| Type safety   | Zero `any` in extracted modules                                | `bun --cwd packages/opencode typecheck` passes clean                                    |
| Import cycles | No circular dependencies introduced                            | `madge --circular packages/opencode/src/session/prompt-reminders.ts` (or manual review) |
| Rebase safety | ≤5 trivially-resolvable conflicts on `git rebase upstream/dev` | Run rebase after Phase 3 restructuring                                                  |

## Git History Strategy

### Commit Dependency Graph

```
                    ┌──────────────────────────────────────────────┐
                    │  upstream/dev (base)                          │
                    └──────────────────┬───────────────────────────┘
                                       │
                    ┌──────────────────▼───────────────────────────┐
                    │  C1: feat(orchestration): task orchestration  │ NEW files only
                    │  8 files: orchestration/*.ts                  │
                    └──────────────────┬───────────────────────────┘
                                       │
                    ┌──────────────────▼───────────────────────────┐
                    │  C2: feat(session): history cache, coalescer, │ NEW files only
                    │  doom loop, prompt-reminders, subtask-handler │
                    │  6 files: session/*.ts                        │
                    └──────────────────┬───────────────────────────┘
                                       │
                    ┌──────────────────▼───────────────────────────┐
                    │  C3: feat(tool): batch tool, plugin utils     │ NEW files only
                    │  7 files: tool/*.ts, orchestration/*.ts       │
                    │  Depends on C1 (imports orchestration)        │
                    └──────────────────┬───────────────────────────┘
                                       │
                    ┌──────────────────▼───────────────────────────┐
                    │  C4: feat(tui): commands, UI utilities        │ NEW files only
                    │  ~12 files: tui/command/*, tui/effect/*,      │
                    │  tui/util/*, tui/component/*, tui/routes/*    │
                    └──────────────────┬───────────────────────────┘
                                       │
                    ┌──────────────────▼───────────────────────────┐
                    │  C5: fix(core): integrate modules into hooks  │ MODIFIES upstream
                    │  5 files: prompt.ts, processor.ts, registry.ts│
                    │  task.ts, app.tsx (~10-20 lines each)         │
                    │  Depends on C1-C4 (imports all new modules)   │
                    └──────────────────┬───────────────────────────┘
                                       │
              ┌────────────────────────┼────────────────────────┐
              │                        │                        │
   ┌──────────▼──────────┐  ┌─────────▼──────────┐  ┌─────────▼──────────┐
   │ C6: fix(tui)        │  │ C7: fix(tool)      │  │ C8: fix(session)   │
   │ UI fixes, sidebar   │  │ bash heredoc,      │  │ memory, startup,   │
   │ Depends on C5       │  │ write non-blocking  │  │ cache retention    │
   └──────────┬──────────┘  └─────────┬──────────┘  └─────────┬──────────┘
              │                        │                        │
              └────────────────────────┼────────────────────────┘
                                       │
                    ┌──────────────────▼───────────────────────────┐
                    │  C9: fix(permission): stale prompt, question  │
                    │  Depends on C5                                │
                    └──────────────────┬───────────────────────────┘
                                       │
              ┌────────────────────────┼────────────────────────┐
              │                        │                        │
   ┌──────────▼──────────┐  ┌─────────▼──────────┐  ┌─────────▼──────────┐
   │ C10: chore(provider)│  │ C11: test: local   │  │ C12: chore: docs,  │
   │ models snapshot     │  │ feature coverage   │  │ gitignore, meta    │
   │ REGENERATED         │  │ NEW files only     │  │ META only          │
   └─────────────────────┘  └────────────────────┘  └────────────────────┘
```

### Commit Ordering Rules

1. **C1 → C2 → C3**: Sequential — C3 imports from C1's orchestration modules
2. **C4**: Independent of C1-C3 (TUI files don't import orchestration), but ordered after for cleanliness
3. **C5**: Must come after C1-C4 (the integration commit imports all new modules)
4. **C6, C7, C8**: Independent of each other, all depend on C5
5. **C9**: Depends on C5 (permission changes reference integrated modules)
6. **C10, C11, C12**: Independent of each other, can come in any order after C9

### Rebase Conflict Surface Analysis

| Commit | Files Touching Upstream Code | Lines Modified     | Conflict Probability | Conflict Resolution Strategy                                                                                                                                                 |
| ------ | ---------------------------- | ------------------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1     | 0 (all NEW)                  | 0 upstream lines   | **NONE**             | N/A — pure additions                                                                                                                                                         |
| C2     | 0 (all NEW)                  | 0 upstream lines   | **NONE**             | N/A — pure additions                                                                                                                                                         |
| C3     | 0 (all NEW)                  | 0 upstream lines   | **NONE**             | N/A — pure additions                                                                                                                                                         |
| C4     | 0 (all NEW)                  | 0 upstream lines   | **NONE**             | N/A — pure additions                                                                                                                                                         |
| C5     | 5 files                      | ~50-80 lines total | **LOW**              | Each file gets ≤15 lines: import block + 1-3 call sites. If upstream moved code, re-apply imports at new location.                                                           |
| C6     | ~8 TUI files                 | ~150 lines         | **MEDIUM**           | `routes/session/index.tsx` sort fix is 5 lines. If upstream refactored session list rendering, manually re-apply sort. Sidebar/spinner changes are in local-only components. |
| C7     | 2 tool files                 | ~40 lines          | **LOW**              | `bash.ts` heredoc fix is localized. `write.ts` non-blocking change is a small wrapper.                                                                                       |
| C8     | ~4 session files             | ~60 lines          | **LOW**              | `llm.ts` config changes, `summary.ts` tweaks. Mostly additive config reads.                                                                                                  |
| C9     | 2 files                      | ~30 lines          | **LOW**              | `permission/index.ts` stale clearing is additive. `question/index.ts` dialog fix is localized.                                                                               |
| C10    | 1 generated file             | ~5000 lines        | **REGENERATE**       | Don't carry diff — regenerate `models-snapshot.js` post-rebase via provider refresh.                                                                                         |
| C11    | 0 (all NEW)                  | 0 upstream lines   | **NONE**             | N/A — pure additions                                                                                                                                                         |
| C12    | ~3 meta files                | ~20 lines          | **NONE**             | `.gitignore` additions and `AGENTS.md` updates are append-only.                                                                                                              |

**Total estimated conflict surface:** ~80 lines across 5 upstream files (C5) + ~150 lines in TUI files (C6) + ~130 lines in other modified files (C7-C9). Down from current ~30+ conflicts across 177 files.

### Multi-Spanning Commit Split Strategy

These original commits must be split during cherry-pick:

| Original Commit             | Split Into                                                                         | Reason            |
| --------------------------- | ---------------------------------------------------------------------------------- | ----------------- |
| `34ea177ea` (btw flow)      | C2 (prompt.ts changes → prompt-reminders), C4 (TUI components), C8 (server config) | Touches 3 domains |
| `c58fb7382` (btw streaming) | C2 (session module changes), C6 (TUI context changes)                              | Touches 2 domains |
| `2dc28f3b5` (stalled runs)  | C7 (write tool fix), C6 (TUI display fix)                                          | Touches 2 domains |

**Split procedure:** Use `git show <hash> -- <path>` to extract per-file patches, then `git apply` into the appropriate commit.

## Verification Strategy

### Feature Parity Verification

After Phase 3 (history reorganization), verify the restructured branch produces identical runtime behavior:

1. **Byte-level diff check:**

   ```bash
   # Compare final state of restructured branch vs original
   git diff dev-pre-restructure..dev -- packages/opencode/src/
   ```

   Expected: Only file additions (new modules) and corresponding deletions from source files. No net logic changes.

2. **Test matrix:**

   ```bash
   bun --cwd packages/opencode test                    # All 37+ test files pass
   bun --cwd packages/opencode typecheck               # Zero type errors
   bun --cwd packages/opencode run build               # Build succeeds
   ```

3. **Per-extraction verification** (run after each module extraction in Phase 1):

   ```bash
   # After extracting prompt-reminders.ts:
   bun --cwd packages/opencode test test/session/prompt.test.ts
   bun --cwd packages/opencode typecheck

   # After extracting subtask-handler.ts:
   bun --cwd packages/opencode test test/session/
   bun --cwd packages/opencode typecheck

   # After extracting plugin-signature.ts + tool-filter.ts:
   bun --cwd packages/opencode test test/tool/
   bun --cwd packages/opencode typecheck

   # After extracting task-spawn.ts + task-model-resolver.ts:
   bun --cwd packages/opencode test test/orchestration/
   bun --cwd packages/opencode typecheck

   # After extracting TUI modules:
   bun --cwd packages/opencode typecheck
   bun --cwd packages/opencode run build
   ```

4. **Rebase smoke test** (Phase 4):
   ```bash
   git fetch upstream
   git rebase upstream/dev
   # Expected: ≤5 conflicts, all trivially resolvable (import line shifts)
   bun --cwd packages/opencode test
   bun --cwd packages/opencode typecheck
   bun --cwd packages/opencode run build
   ```

### Rollback Strategy

- Before Phase 3: `git branch dev-pre-restructure` preserves original history
- During Phase 3: Work on a temporary branch; only replace `dev` after full verification
- If rebase fails catastrophically: `git checkout dev-pre-restructure` and retry with smaller extraction scope
