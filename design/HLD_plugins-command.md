# HLD: /plugins Slash Command

## Tech Stack

| Category  | Technology     | Purpose                                         |
| --------- | -------------- | ----------------------------------------------- |
| Language  | TypeScript 5.8 | Existing TUI codebase language                  |
| Framework | Solid.js       | TUI reactive UI framework                       |
| Runtime   | Bun            | Existing runtime                                |
| UI        | Toast API      | Lightweight non-blocking display of plugin list |

## Components

| Component        | Responsibility                              | Dependencies                                    |
| ---------------- | ------------------------------------------- | ----------------------------------------------- |
| Command Entry    | Register `/plugins` in commands array       | `useSync`, `useToast`                           |
| Plugin Formatter | Extract names + scope from `plugin_origins` | `Config.PluginOrigin`, `Config.pluginSpecifier` |
| Toast Display    | Show formatted plugin list to user          | Toast API (`ui/toast.tsx`)                      |

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  app.tsx (commands array)                           │
│                                                     │
│  { slash: { name: "plugins" }, onSelect: handler } │
└──────────────────────┬──────────────────────────────┘
                       │ onSelect()
                       ▼
┌──────────────────────────────────────────────────────┐
│  onSelect handler (inline in app.tsx)               │
│                                                     │
│  1. Read sync.data.config.plugin_origins            │
│  2. Format plugin list (name + scope)               │
│  3. Call toast.show({ title, message, variant })    │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────┐
│  Toast UI (ui/toast.tsx)                            │
│  Renders message in top-right overlay               │
│  Auto-dismisses after duration                      │
└──────────────────────────────────────────────────────┘

Data source:
  Server Config.get() → SDK client → sync.data.config (includes plugin_origins)
```

Description: The `/plugins` command is a single entry in the `commands` array in `app.tsx`. Its `onSelect` handler reads `plugin_origins` from the sync context (already fetched at bootstrap via `sdk.client.config.get()`), formats plugin names with scope indicators, and displays them via the existing toast API. No new files, no new components — purely inline logic following the existing command registration pattern.

## Interfaces

### onSelect Handler (inline in app.tsx)

| Method   | Input                   | Output | Behavior                                                       | Errors            |
| -------- | ----------------------- | ------ | -------------------------------------------------------------- | ----------------- |
| onSelect | `dialog: DialogContext` | `void` | Reads plugin_origins, formats list, shows toast, clears dialog | None (toast-only) |

### Plugin Name Extraction (inline helper logic)

| Method        | Input            | Output   | Behavior                                                                                                  | Errors |
| ------------- | ---------------- | -------- | --------------------------------------------------------------------------------------------------------- | ------ |
| formatPlugins | `PluginOrigin[]` | `string` | Extracts display name from each spec, appends scope tag, joins with newline. Truncates if >10 entries.    | None   |
| extractName   | `PluginSpec`     | `string` | If string: extract package name (strip version). If tuple: use first element. If `file://`: use basename. | None   |

### Toast API (existing, no changes)

| Method     | Input                                                     | Output | Behavior                               | Errors |
| ---------- | --------------------------------------------------------- | ------ | -------------------------------------- | ------ |
| toast.show | `{ title?: string, message: string, variant, duration? }` | void   | Shows toast, auto-hides after duration | None   |

## Data Flow

| Step | Component        | Action                                                                       | Next             |
| ---- | ---------------- | ---------------------------------------------------------------------------- | ---------------- |
| 1    | User             | Types `/plugins` or selects from command palette                             | Command dispatch |
| 2    | Command dispatch | Calls `onSelect(dialog)`                                                     | Handler          |
| 3    | Handler          | Reads `sync.data.config.plugin_origins ?? []`                                | Formatter        |
| 4    | Formatter        | Extracts name from each `PluginSpec`, appends `[scope]`                      | Toast            |
| 5    | Toast            | `toast.show({ title: "Plugins", message, variant: "info", duration: 8000 })` | Display          |
| 6    | Handler          | Calls `dialog.clear()`                                                       | Done             |

**Error Flows**: No error paths. If `plugin_origins` is undefined/empty, toast shows "No plugins loaded". The toast API itself handles display lifecycle (auto-dismiss via timeout).

## Data Model

| Entity       | Fields                                                       | Relationships             | Constraints                                 |
| ------------ | ------------------------------------------------------------ | ------------------------- | ------------------------------------------- |
| PluginOrigin | `spec: PluginSpec, source: string, scope: "global"\|"local"` | Part of Config.Info       | Already exists, read-only access            |
| PluginSpec   | `string \| [string, PluginOptions]`                          | Contained in PluginOrigin | Spec string is npm specifier or file:// URL |

## Display Format Specification

### Toast Content

```
Title: "Plugins"
Variant: "info"
Duration: 8000ms

Message format (non-empty list):
  plugin-name [global]
  another-plugin [local]
  @scope/plugin [global]

Message format (empty list):
  No plugins loaded

Message format (truncated, >10 plugins):
  plugin-1 [global]
  plugin-2 [local]
  ...
  ... and 5 more
```

### Name Extraction Rules

1. **String spec** (e.g. `"@opencode/theme-catppuccin@1.2.0"`): Use package name without version → `@opencode/theme-catppuccin`
2. **Tuple spec** (e.g. `["my-plugin", { opt: true }]`): Use first element, apply same name extraction → `my-plugin`
3. **file:// URL** (e.g. `"file:///path/to/plugin/index.ts"`): Use directory name or filename without extension (match existing `DialogStatus` logic)
4. **Scope indicator**: Append ` [global]` or ` [local]` based on `origin.scope`

### Reference Implementation Pattern (from DialogStatus)

The existing `dialog-status.tsx` already extracts plugin names from `sync.data.config.plugin` using the same logic:

- `file://` → extract basename/dirname
- npm specifier → split at last `@` for name/version

The `/plugins` command reuses this extraction approach but additionally shows the `scope` from `plugin_origins` (which `dialog-status` does not use since it reads from `config.plugin` not `config.plugin_origins`).

## Decisions

| Decision             | Choice                            | Reason                                                     | Alternatives                   | Tradeoffs                                      |
| -------------------- | --------------------------------- | ---------------------------------------------------------- | ------------------------------ | ---------------------------------------------- |
| Display mechanism    | Toast (not dialog/picker)         | Lightweight, non-blocking, matches PLAN requirement        | Dialog with list               | Toast has limited space; dialog is richer      |
| Data source          | `sync.data.config.plugin_origins` | Contains scope info; already available in TUI context      | `sync.data.config.plugin`      | `plugin` lacks scope; `plugin_origins` has it  |
| Truncation threshold | 10 plugins                        | Toast max width is 60 chars, ~12 lines visible             | No limit                       | Long lists overflow toast viewport             |
| Duration             | 8000ms                            | Plugin list needs reading time; longer than default 5000ms | 5000ms default                 | May feel long for short lists                  |
| Name extraction      | Inline in handler                 | Simple logic, no new file needed                           | Shared utility function        | Slight duplication with dialog-status          |
| Scope display        | `[global]` / `[local]` suffix     | Clear, concise indicator                                   | Icon, color, separate sections | Text-only toast limits formatting options      |
| No MCP servers shown | Excluded by design                | PLAN explicitly prohibits; MCP has own `/mcps` command     | Include all plugin-like things | Users must use `/mcps` for MCP servers         |
| File touched         | Only `app.tsx`                    | Single command entry addition, upstream-rebase safe        | New file for handler           | Keeps handler inline; acceptable for ~30 lines |

## Risks

| Risk                             | Impact                             | Likelihood | Mitigation                                                                            |
| -------------------------------- | ---------------------------------- | ---------- | ------------------------------------------------------------------------------------- |
| Toast overflow with many plugins | Plugin names cut off or unreadable | Low        | Truncate at 10 entries with "and N more" suffix                                       |
| `plugin_origins` undefined       | TypeError on access                | Low        | Nullish coalescing: `?? []`; empty state handled                                      |
| Long plugin names                | Wrap awkwardly in 60-char toast    | Med        | Toast has `wrapMode="word"`; names naturally short                                    |
| SDK Config type mismatch         | `plugin_origins` not in SDK type   | Med        | Field exists in JSON response; access via `as any` or type assertion on config object |
| Stale data at command time       | Shows plugins from last bootstrap  | Low        | Acceptable; config rarely changes mid-session                                         |

## Test Plan

### Unit Tests

**Plugin name extraction logic:**

- String spec `"@scope/pkg@1.0.0"` → name `"@scope/pkg"`
- String spec `"simple-plugin"` → name `"simple-plugin"` (version "latest" implied)
- Tuple spec `["my-plugin", { key: "val" }]` → name `"my-plugin"`
- File URL `"file:///path/to/my-plugin/index.ts"` → name `"my-plugin"`
- File URL `"file:///path/to/custom.ts"` → name `"custom"`

**Formatting logic:**

- Empty array → `"No plugins loaded"`
- Single plugin → `"plugin-name [global]"`
- Multiple plugins → newline-separated list
- 11+ plugins → first 10 shown + `"... and 1 more"`

### Integration Tests

**Command registration:**

- `/plugins` slash command exists in command palette
- Selecting it triggers toast (not dialog)
- Toast variant is "info"
- Toast has title "Plugins"

**Data flow:**

- When `sync.data.config.plugin_origins` has entries → toast shows them
- When `sync.data.config.plugin_origins` is undefined → toast shows "No plugins loaded"
- When `sync.data.config.plugin_origins` is empty array → toast shows "No plugins loaded"

### End-to-End Tests

**Critical user journey:**

1. User has plugins configured in `opencode.json`
2. User opens TUI, waits for sync to complete
3. User types `/plugins` in prompt
4. Toast appears with correct plugin names and scopes
5. Toast auto-dismisses after 8 seconds

**Edge case journey:**

1. User has no plugins configured
2. User types `/plugins`
3. Toast shows "No plugins loaded"

### Non-Functional Tests

- **Performance**: Handler executes synchronously (no async); no measurable latency
- **Security**: No user input processed; read-only display of config data
- **Accessibility**: Toast is visible at standard terminal sizes (≥80 cols)
