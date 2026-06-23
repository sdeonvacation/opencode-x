# Plan: Per-Process LSP (Multi-Root Workspace)

## Overview

Make LSP servers process-global singletons that serve all projects via multi-root workspace support. One `typescript-language-server` process (spawned for the launching project) dynamically adds workspace folders when the agent touches files in external projects. Zero additional server processes spawned.

## Tech Stack

TypeScript, Effect-ts (Layer, ServiceMap, InstanceState), vscode-jsonrpc, LSP `workspace/didChangeWorkspaceFolders` protocol.

## Testing Strategy

- Unit: workspace folder add/remove notifications, capability detection, root resolution for external files
- Integration: launch in project A, touchFile in project B, verify diagnostics returned from same server process
- Done when: editing external project file returns diagnostics without spawning additional server processes

## Phases

### Phase 1: Multi-Root Capability Declaration

- In `LSPClient.create()` initialize request: add `workspace.workspaceFolders` capability
- Declare `changeNotifications: true` in capabilities
- Store server's response `capabilities.workspace.workspaceFolders.supported` flag
- Track active workspace folders as `Set<string>` on each client

### Phase 2: Dynamic Workspace Folder Management

- Add `client.addWorkspaceFolder(root: string)` method on LSPClient.Info
- Sends `workspace/didChangeWorkspaceFolders` notification with `{ added: [{ uri, name }] }`
- Add `client.removeWorkspaceFolder(root: string)` — sends notification with `{ removed: [...] }`
- No-op if server doesn't support multi-root (capability flag check)

### Phase 3: Remove Instance Boundary Gate

- Remove `if (!Instance.containsPath(file)) return []` from `getClients()`
- Replace with: resolve root for file → if root matches existing client's tracked folders → use it
- If root is new: call `client.addWorkspaceFolder(root)` on matching server, then proceed
- Root resolution: decouple `nearest()` from `Instance.directory` stop boundary → walk up to `.git` or filesystem root

### Phase 4: Root Resolution for External Files

- Current `server.root(file)` uses `projectRoot()` which reads `Instance.current`
- Add `server.resolveExternalRoot(file)` — finds nearest project marker (package.json, go.mod, Cargo.toml, etc.) without Instance context
- For files matching server's extensions but outside any known root → detect root by walking up to VCS boundary
- Cache resolved roots to avoid repeated filesystem walks

### Phase 5: Fallback for Non-Multi-Root Servers

- If server's initialize response lacks `workspace.workspaceFolders.supported`:
  - Spawn separate process for the external root (current behavior, but only as fallback)
  - Track as additional client in state
- Known multi-root servers: typescript-language-server, gopls, rust-analyzer, pyright, clangd
- Known single-root: some linters (eslint may need separate instance per config root)

### Phase 6: Diagnostic Filtering (Critical Mitigation)

- Adding workspace folder causes server to push diagnostics for ALL files in that folder
- **Filter**: only store diagnostics for files that have been explicitly opened via `didOpen` (agent-touched files)
- Maintain `openedFiles: Set<string>` on client — `publishDiagnostics` handler ignores files not in this set
- This prevents diagnostic flood from untouched external project files
- Agent gets diagnostics only for files it actively edits — same UX as current project

### Phase 7: Lifecycle & Cleanup

- Workspace folders tracked per client: `folders: Set<string>`
- Instance disposal: remove that instance's root from all clients' folder sets
- Server process lifetime: unchanged — still killed on instance dispose / idle timeout
- External folders are "best effort" — if server crashes, respawn only adds launching project's root (not external ones until next touch)
- Optional: remove external workspace folder after inactivity (no didOpen/didChange for 10min) to reclaim server memory

## Risks/Edge cases

- **Diagnostic flood** (MITIGATED): server pushes diagnostics for all files in added folder. Mitigated by filtering to only agent-touched files (Phase 6).
- **Server memory growth**: adding workspace folder → server indexes all files in that folder. Accepted tradeoff. Mitigated by inactivity-based folder removal.
- **Server crash blast radius**: shared server crash affects all projects. Mitigated by respawn logic (re-add only launching project root; external roots re-added on next touch).
- **TypeScript version mismatch**: `tsserver.path` set once (project A's version). External project B analyzed with A's TS. Could produce false diagnostics if versions differ significantly. Acceptable: agent still gets useful-enough feedback.
- **Server doesn't support multi-root**: fallback to per-root spawn (Phase 5). Only impacts that specific server type.
- **Config locality (eslint, biome)**: these resolve config from `cwd` or workspace folder root. Multi-root should work since each folder is declared separately. If issues arise, these servers can be excluded from multi-root.
- **Root resolution ambiguity**: file in deeply nested monorepo could resolve to wrong root. Mitigation: prefer nearest `tsconfig.json`/`package.json` as root marker.
- **Re-indexing stall**: adding large workspace folder → server busy for seconds. Existing project diagnostics may be delayed. Acceptable for the coverage gain.
- **No extra servers guarantee**: if agent only edits current project, behavior is identical to today. External folder notifications are lightweight (no spawn, no binary resolution).
