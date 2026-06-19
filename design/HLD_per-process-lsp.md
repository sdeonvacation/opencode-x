# HLD: Per-Process LSP (Multi-Root Workspace)

## Tech Stack

| Category  | Technology     | Purpose                                      |
| --------- | -------------- | -------------------------------------------- |
| Language  | TypeScript 5.8 | Existing codebase language                   |
| Framework | Effect-ts 4.0  | InstanceState, ScopedCache, service layers   |
| Protocol  | vscode-jsonrpc | JSON-RPC transport for LSP communication     |
| LSP       | LSP 3.17+      | `workspace/didChangeWorkspaceFolders` notify |

## Components

| Component                  | Responsibility                                                         | Dependencies                   |
| -------------------------- | ---------------------------------------------------------------------- | ------------------------------ |
| `index.ts` (getClients)    | Route files to clients; add workspace folders dynamically              | LSPClient, LSPServer, Instance |
| `client.ts` (create)       | Declare multi-root capability; track folders; filter diagnostics       | vscode-jsonrpc, Filesystem     |
| `server.ts` (nearest/root) | Resolve project root for external files without Instance stop boundary | Filesystem.up, Instance        |

## Architecture

```
                        ┌─────────────────────────────────────────┐
                        │            LSP.touchFile(file)           │
                        └────────────────────┬────────────────────┘
                                             │
                                             ▼
                        ┌─────────────────────────────────────────┐
                        │           getClients(file)               │
                        │                                         │
                        │  1. Check extension match per server    │
                        │  2. Resolve root (internal OR external) │
                        │  3. If root in client.folders → reuse   │
                        │  4. If root new → addWorkspaceFolder()  │
                        │  5. Fallback: spawn if non-multi-root   │
                        └────────────────────┬────────────────────┘
                                             │
                          ┌──────────────────┼──────────────────┐
                          │                  │                  │
                          ▼                  ▼                  ▼
                  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
                  │  TS Client   │  │ Gopls Client │  │  Rust Client │
                  │              │  │              │  │              │
                  │ folders:     │  │ folders:     │  │ folders:     │
                  │  Set<string> │  │  Set<string> │  │  Set<string> │
                  │              │  │              │  │              │
                  │ opened:      │  │ opened:      │  │ opened:      │
                  │  Set<string> │  │  Set<string> │  │  Set<string> │
                  │              │  │              │  │              │
                  │ multiRoot:   │  │ multiRoot:   │  │ multiRoot:   │
                  │  boolean     │  │  boolean     │  │  boolean     │
                  └──────────────┘  └──────────────┘  └──────────────┘
                          │                  │                  │
                          └──────────────────┼──────────────────┘
                                             │
                                             ▼
                  ┌───────────────────────────────────────────────────┐
                  │  publishDiagnostics handler (FILTERED)            │
                  │                                                   │
                  │  if filePath NOT in client.opened → DISCARD       │
                  │  else → store in pushDiagnostics map as before    │
                  └───────────────────────────────────────────────────┘
```

**Description**: The existing single-client-per-server model is extended so each client tracks multiple workspace folders. When `getClients()` receives a file outside the current Instance directory, it resolves the external project root and dynamically adds it as a workspace folder via `workspace/didChangeWorkspaceFolders` notification. Diagnostics are filtered to only files explicitly opened via `didOpen` (agent-touched), preventing flood from the new workspace folder. If a server doesn't support multi-root, a separate process is spawned as fallback (existing behavior).

## Interfaces

### LSPClient.Info (additions to returned object)

| Method/Property      | Input          | Output        | Behavior                                                                                                                              | Errors |
| -------------------- | -------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `folders`            | —              | `Set<string>` | Current workspace folders tracked by this client                                                                                      | —      |
| `opened`             | —              | `Set<string>` | Files that have been opened via didOpen                                                                                               | —      |
| `multiRoot`          | —              | `boolean`     | Whether server supports multi-root workspaces                                                                                         | —      |
| `addFolder(root)`    | `root: string` | `void`        | Sends `workspace/didChangeWorkspaceFolders` with added folder; updates `folders` set. No-op if `!multiRoot` or folder already tracked | —      |
| `removeFolder(root)` | `root: string` | `void`        | Sends notification with removed folder; updates `folders` set. No-op if folder is the primary root or `!multiRoot`                    | —      |

### LSPServer.Info (additions)

| Method/Property     | Input          | Output                         | Behavior                                                                                                                                                                  | Errors |
| ------------------- | -------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `resolveRoot(file)` | `file: string` | `Promise<string \| undefined>` | Resolves project root without Instance.directory stop boundary. Walks up to `.git` or fs root looking for server-specific markers. Falls back to nearest `.git` directory | —      |

### index.ts getClients (modified behavior)

| Method             | Input          | Output                     | Behavior                                                                                                                                                                                                                      | Errors |
| ------------------ | -------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `getClients(file)` | `file: string` | `Effect<LSPClient.Info[]>` | Removes `containsPath` early-return. For external files: resolves root via `server.resolveRoot(file)`, finds existing client for same server type, calls `addFolder(root)` if multi-root capable, or spawns new client if not | —      |

## Data Flow

| Step | Component                                        | Action                                                                                          | Next                |
| ---- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------- |
| 1    | `LSP.touchFile(file)`                            | Entry point — passes file to getClients                                                         | getClients          |
| 2    | `getClients(file)`                               | Check extension match per server                                                                | root resolution     |
| 3    | `server.root(file)` / `server.resolveRoot(file)` | Internal: use existing `root()`. External (containsPath fails): use `resolveRoot()`             | client lookup       |
| 4    | `getClients`                                     | Look for existing client with matching serverID whose `folders` contains resolved root          | add folder or spawn |
| 5a   | `client.addFolder(root)`                         | If existing client found and multiRoot: send `workspace/didChangeWorkspaceFolders` notification | return client       |
| 5b   | `schedule(server, root, key)`                    | If no multi-root client or server lacks capability: spawn new process (existing path)           | return client       |
| 6    | `client.notify.open({path})`                     | Sends `didOpen`, adds file to `opened` set                                                      | diagnostics         |
| 7    | `publishDiagnostics` handler                     | Receives notification; checks `opened.has(filePath)`; discards if not opened                    | store/emit          |

**Error Flows**:

- `resolveRoot()` returns undefined → file has no detectable project root → `getClients` returns `[]` (no LSP coverage, same as today for unrecognized files)
- `addFolder()` on crashed connection → existing reconnect/respawn logic handles it; external folder re-added on next `touchFile`
- Server crashes → respawn adds only primary root; external folders re-added lazily on next touch

## Data Model

| Entity                         | Fields                                                                                          | Relationships                       | Constraints                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------- |
| LSPClient.Info (extended)      | `root: string, serverID: string, folders: Set<string>, opened: Set<string>, multiRoot: boolean` | One per (server, primary-root) pair | `root` always in `folders`; `opened` is subset of files within any folder |
| State.clients (unchanged type) | `LSPClient.Info[]`                                                                              | Per-instance via InstanceState      | Multiple clients may exist for same serverID if non-multi-root            |

## Decisions

| Decision                           | Choice                                                                               | Reason                                                                           | Alternatives                                           | Tradeoffs                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Diagnostic filter strategy         | Filter by `opened` set (files sent `didOpen`)                                        | Prevents flood when workspace folder added; agent only cares about touched files | Filter by Instance containsPath; Filter by time window | Misses background errors in external project (acceptable — agent gets them on touch) |
| Root resolution for external files | Walk up to `.git` or filesystem root using server-specific markers                   | VCS boundary is natural project boundary; reuses existing `Filesystem.up`        | Use only `.git`; Ask user for root                     | Might misidentify monorepo boundaries (mitigated by preferring nearest marker)       |
| Multi-root detection               | Read `capabilities.workspace.workspaceFolders.supported` from initialize response    | Standard LSP capability negotiation                                              | Hardcode known servers                                 | Robust for custom/future servers                                                     |
| Fallback for non-multi-root        | Spawn separate process per root (existing behavior)                                  | No behavior change for servers that can't multi-root                             | Refuse to serve external files                         | More processes but correct behavior                                                  |
| Keep InstanceState pattern         | InstanceState still provides per-instance cleanup; change is within getClients logic | Minimal diff; existing idle-timeout and disposal still work                      | Global singleton map                                   | Would break existing lifecycle guarantees                                            |
| No new files/modules               | All changes in existing files                                                        | Upstream-rebase safety; minimal diff surface                                     | Extract workspace-folder logic to new file             | Merge conflicts on restructure                                                       |

## Risks

| Risk                                            | Impact                                                                       | Likelihood            | Mitigation                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------- |
| Diagnostic flood from added folder              | Memory spike; irrelevant diagnostics pollute output                          | High (without filter) | Phase 6: filter to `opened` set only                                |
| Server memory growth on large external projects | Server indexes all files in new folder                                       | Medium                | Optional: remove folder after inactivity timeout                    |
| TypeScript version mismatch                     | False diagnostics for external project using different TS version            | Low                   | Acceptable tradeoff; diagnostics still useful for syntax/type shape |
| Shared server crash blast radius                | All projects lose LSP temporarily                                            | Low                   | Respawn only primary root; external re-added on next touch          |
| Root resolution ambiguity in monorepos          | Wrong root chosen → wrong tsconfig used                                      | Medium                | Prefer nearest specific marker (tsconfig.json) over generic (.git)  |
| ESLint config locality                          | ESLint resolves config from workspace folder root; multi-root may confuse it | Low                   | ESLint can be excluded from multi-root via fallback path            |

## Test Plan

### Unit Tests

**client.ts — multi-root capability:**

- Initialize with `workspace.workspaceFolders` in capabilities → verify sent in request
- Parse `capabilities.workspace.workspaceFolders.supported` from response → `multiRoot` flag set correctly
- `addFolder(root)` sends correct `workspace/didChangeWorkspaceFolders` notification shape
- `addFolder(root)` is no-op when `multiRoot === false`
- `addFolder(root)` is no-op when folder already in `folders` set
- `removeFolder(root)` sends correct notification; no-op for primary root

**client.ts — diagnostic filtering:**

- `publishDiagnostics` for file in `opened` set → stored normally
- `publishDiagnostics` for file NOT in `opened` set → discarded
- After `notify.open({path})` → path added to `opened` set
- Diagnostics for opened files in external folders → stored correctly

**server.ts — resolveRoot:**

- File with `package.json` above → returns that directory
- File with `go.mod` above → returns that directory
- File with no markers but `.git` above → returns `.git` parent
- File at filesystem root with no markers → returns undefined
- Does NOT use `Instance.directory` as stop boundary

**index.ts — getClients routing:**

- External file with existing multi-root client → `addFolder` called, client returned
- External file with non-multi-root server → new process spawned
- External file with no detectable root → returns `[]`
- Internal file → existing behavior unchanged (no `resolveRoot` called)

### Integration Tests

- Launch instance in project A (TypeScript), touch file in project B → same `typescript-language-server` PID serves both
- Verify only 1 process spawned (check `pids` set size)
- Touch file in project B → diagnostics returned for that file
- Diagnostics from untouched files in project B → NOT present in `LSP.diagnostics()` output

### End-to-End Tests

- Agent edits file in external project → gets diagnostics without user noticing additional spawn
- Agent touches multiple external projects → all served by same server process
- Server crash → respawn → touch external file again → works

### Non-Functional Tests

- Performance: `addFolder` notification is <1ms (just a JSON-RPC send)
- Memory: monitor server RSS after adding workspace folder (informational, not gating)
- No regression: existing single-project workflow unchanged in timing and behavior

---

## Detailed Change Spec

### Phase 1: Multi-Root Capability Declaration (`client.ts`)

**Location**: `create()` function, initialize request (lines 224-264)

**Change**: Add `workspace.workspaceFolders` to client capabilities in the initialize request:

```typescript
capabilities: {
  workspace: {
    configuration: true,
    workspaceFolders: true,  // NEW
    didChangeWatchedFiles: { ... },
    ...
  },
  ...
}
```

**Location**: After `initialized` response parsed (line 276)

**Change**: Extract multi-root support flag from server response:

```typescript
const multiRoot = Boolean(initialized.capabilities?.workspace?.workspaceFolders?.supported)
```

**Location**: After `files` declaration (line 287)

**Change**: Add tracking sets:

```typescript
const folders = new Set<string>([input.root])
const opened = new Set<string>()
```

**Location**: `result` object (line 554)

**Change**: Expose new properties:

```typescript
get folders() { return folders },
get opened() { return opened },
get multiRoot() { return multiRoot },
```

### Phase 2: Dynamic Workspace Folder Management (`client.ts`)

**Location**: `result` object, after `notify` property

**Change**: Add `addFolder` and `removeFolder` methods:

```typescript
async addFolder(root: string) {
  if (!multiRoot) return
  if (folders.has(root)) return
  folders.add(root)
  await connection.sendNotification("workspace/didChangeWorkspaceFolders", {
    event: {
      added: [{ uri: pathToFileURL(root).href, name: path.basename(root) }],
      removed: [],
    },
  })
},
async removeFolder(root: string) {
  if (!multiRoot) return
  if (root === input.root) return  // never remove primary
  if (!folders.has(root)) return
  folders.delete(root)
  await connection.sendNotification("workspace/didChangeWorkspaceFolders", {
    event: {
      added: [],
      removed: [{ uri: pathToFileURL(root).href, name: path.basename(root) }],
    },
  })
},
```

**Location**: `workspace/workspaceFolders` handler (line 214)

**Change**: Update handler to return all tracked folders instead of only primary root:

```typescript
connection.onRequest("workspace/workspaceFolders", async () =>
  [...folders].map((f) => ({ name: path.basename(f), uri: pathToFileURL(f).href })),
)
```

### Phase 3: Diagnostic Filtering (`client.ts`)

**Location**: `notify.open()` method (line 563)

**Change**: Add file to `opened` set after path normalization:

```typescript
// After: request.path = Filesystem.normalizePath(...)
opened.add(request.path)
```

**Location**: `publishDiagnostics` handler (line 168)

**Change**: Add filter gate before storing:

```typescript
connection.onNotification("textDocument/publishDiagnostics", (params) => {
  const filePath = getFilePath(params.uri)
  if (!filePath) return
  // Filter: only store diagnostics for files we explicitly opened
  if (!opened.has(filePath)) return // NEW
  // ... rest unchanged
})
```

### Phase 4: Root Resolution for External Files (`server.ts`)

**Location**: After `nearest()` helper (line 28-38)

**Change**: Add `resolveExternal()` helper that walks without Instance stop, with a resolved-root cache to avoid repeated filesystem walks:

```typescript
const rootCache = new Map<string, string | undefined>()

const resolveExternal = async (file: string, targets: string[]) => {
  const key = file + "\0" + targets.join(",")
  if (rootCache.has(key)) return rootCache.get(key)
  const files = Filesystem.up({
    targets,
    start: path.dirname(file),
    // no stop — walk to filesystem root
  })
  const first = await files.next()
  await files.return()
  const result = first.value ? path.dirname(first.value) : undefined
  rootCache.set(key, result)
  return result
}
```

**Location**: Each `Info` definition that uses `NearestRoot` or custom `root()`

**Change**: Add `resolveRoot` function per server. For `NearestRoot`-based servers, generate it from the include patterns. For custom servers (Typescript, Gopls, Deno), add explicit implementations.

Example for `Typescript`:

```typescript
export const Typescript: Info = {
  ...
  resolveRoot: async (file) => {
    // Walk up without Instance boundary, look for tsconfig or package.json
    return (
      (await resolveExternal(file, ["tsconfig.json", "tsconfig.base.json"])) ??
      (await resolveExternal(file, ["package.json"])) ??
      (await resolveExternal(file, [".git"]))
    )
  },
}
```

**Location**: `Info` interface (line 62-68)

**Change**: Add optional `resolveRoot` to interface:

```typescript
export interface Info {
  id: string
  extensions: string[]
  global?: boolean
  root: RootFunction
  resolveRoot?: RootFunction // NEW — for external files
  spawn(root: string): Promise<Handle | undefined>
}
```

### Phase 5: Remove Instance Boundary Gate (`index.ts`)

**Location**: `getClients()` (line 396-498)

**Change**: Replace the `containsPath` early-return with conditional root resolution:

```typescript
const getClients = Effect.fnUntraced(function* (file: string) {
  const internal = Instance.containsPath(file) // CHANGED: store result, don't return
  const s = yield* InstanceState.get(state)
  if (s.disposing) return [] as LSPClient.Info[]
  return yield* Effect.promise(async () => {
    const extension = path.parse(file).ext || file
    const result: LSPClient.Info[] = []

    const ctx = Instance.current
    const isolated = ctx.isolated && ctx.parent
    const lookup = isolated ? file.replace(ctx.directory, ctx.parent!) : file

    for (const server of Object.values(s.servers)) {
      if (server.extensions.length && !server.extensions.includes(extension)) continue

      // Root resolution: internal uses existing path; external uses resolveRoot
      let root: string | undefined
      if (internal) {
        root = await server.root(lookup)
      } else {
        root = server.resolveRoot ? await server.resolveRoot(file) : undefined
      }
      if (!root) continue
      if (s.broken.has(root + server.id)) continue

      // Check if any existing client already has this root in its folders
      const folderMatch = s.clients.find((x) => x.serverID === server.id && x.folders.has(root!))
      if (folderMatch) {
        result.push(folderMatch)
        continue
      }

      // Try to add folder to existing client (same server type, multi-root)
      if (!internal) {
        const candidate = s.clients.find((x) => x.serverID === server.id && x.multiRoot)
        if (candidate) {
          await candidate.addFolder(root)
          result.push(candidate)
          continue
        }
      }

      // Existing spawn path (for internal, or fallback for non-multi-root external)
      const match = s.clients.find((x) => x.root === root && x.serverID === server.id)
      if (match) {
        result.push(match)
        continue
      }

      // ... existing spawning logic (inflight check + schedule) unchanged ...
    }
    return result
  })
})
```

### Phase 6: Lifecycle & Cleanup (minor additions)

**Location**: `index.ts` — instance disposal finalizer (line 293-341)

**Change**: Before shutting down clients, remove this instance's root from other clients' folder sets (in case this instance added folders to a client owned by another instance):

```typescript
// In the graceful() function, before shutdown:
for (const client of s.clients) {
  // Remove our root from any other instance's client folder tracking
  // (the client object itself is cleaned up by its owning instance)
}
```

No actual code needed here — when InstanceState is invalidated, the entire `State` including `s.clients` is destroyed. External folders added to clients in OTHER instances are fine to leave (server handles the folder presence gracefully; it's cleaned up when that client shuts down).

**Crash recovery**: No code change needed. Existing respawn logic in `schedule()` creates a fresh client with only the primary root. External folders are lazily re-added on next `touchFile()`.

### Phase 7: Optional Inactivity Removal (deferred)

Not implemented in initial phases. If server memory becomes problematic:

- Track `lastTouched: Map<string, number>` per folder
- Timer checks every 10min; removes folders idle > 10min via `removeFolder()`
- Low priority; can be a follow-up PR

---

## Migration Path (Independent PRs)

| PR  | Phase       | Content                                                                                                       | Shippable alone?                                                                                                  | Risk                                                                |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1   | Phase 1 + 2 | Declare multi-root capability; add `addFolder`/`removeFolder` to client; expose `folders`/`multiRoot` on Info | Yes — adds methods but nothing calls them yet                                                                     | None — no behavior change                                           |
| 2   | Phase 3     | Diagnostic filter (opened set); add `opened` tracking                                                         | Yes — filter is safe (only files we didOpen get diagnostics, which is already the normal flow for internal files) | Low — verify no path that expects diagnostics without explicit open |
| 3   | Phase 4     | Add `resolveRoot` to server interface and implementations; add `resolveExternal` helper                       | Yes — adds optional method, nothing calls it yet                                                                  | None — no behavior change                                           |
| 4   | Phase 5     | Remove `containsPath` gate; wire `resolveRoot` + `addFolder` in `getClients`                                  | Yes — enables the feature end-to-end                                                                              | Medium — integration testing needed                                 |
| 5   | Phase 7     | Inactivity cleanup (optional)                                                                                 | Yes — optimization only                                                                                           | Low                                                                 |
