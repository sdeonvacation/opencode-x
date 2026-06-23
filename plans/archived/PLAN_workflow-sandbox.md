# Plan: QuickJS Sandboxed Workflows

## Overview

Port a deterministic QuickJS-emscripten sandbox that executes user-authored workflow scripts in complete isolation. Scripts call host-injected hooks (e.g. `agent()`, file I/O) via a sync-promise bridge, enabling multi-agent orchestration pipelines (fan-out, pipeline, nested workflows) with resume-safe journaling. The sandbox enforces memory caps, wall-clock deadlines, and a seeded PRNG so replayed runs produce identical sequences.

## Tech Stack

- TypeScript 5.8, Bun 1.3.11, Effect-ts 4.0.0-beta
- **New dependency**: `quickjs-emscripten` (WASM-based QuickJS, zero native compilation)
- SQLite via drizzle-orm for run persistence
- BusEvent for workflow lifecycle events
- Existing orchestration (task-spawn, concurrency) for agent hook implementation

## Testing Strategy

- Unit: sandbox eval (determinism, memory limit, deadline kill, hook injection, marshal round-trip, PRNG reproducibility, prelude helpers)
- Unit: meta parser (valid scripts, malformed, edge cases)
- Unit: persistence (journal append/load/clear, DB CRUD)
- Integration: end-to-end workflow run (start → agent hooks → journal → completion), resume replay, cancel, nested workflows
- Done when: sandbox passes all determinism invariants, a builtin script runs to completion with mocked agent hooks, resume replays journal without re-executing completed agents

## Phases

### Phase 1: Sandbox Core (`src/workflow/sandbox.ts`)

- Step 1: Add `quickjs-emscripten` to `packages/opencode/package.json`
- Step 2: Port `sandbox.ts` — `evalScript()`, `injectHooks()`, `marshalIn()` functions; adapt naming to style guide (single-word vars where possible)
- Step 3: Port `PRELUDE` (parallel/pipeline/URL polyfill) and determinism strip (Date delete, seeded PRNG, WeakRef/FinalizationRegistry delete)
- Step 4: Write unit tests: basic eval, hook injection (sync + async), memory limit OOM, deadline timeout, PRNG determinism with same/different seeds

### Phase 2: Meta Parser & Script Resolution (`src/workflow/meta.ts`, `src/workflow/resolve.ts`)

- Step 1: Port `meta.ts` — recursive-descent data-literal parser, `parseMeta()` returning `{meta, body}` or error
- Step 2: Port `resolve.ts` — `resolveWorkflowScript()` walking up from project dir checking `.opencode/workflows/<name>.js`
- Step 3: Port `builtin.ts` — registry of bundled scripts (start empty, structure only)
- Step 4: Write unit tests: meta parse valid/invalid, resolve walk-up, safe-name validation

### Phase 3: Persistence & Schema (`src/workflow/persistence.ts`, `src/workflow/workflow.sql.ts`)

- Step 1: Create `src/workflow/workflow.sql.ts` — `workflow_run` table (id, session_id, name, status, running, succeeded, failed, current_phase, parent_actor_id, args, script_sha, agent_timeout_ms, error, time_created, time_updated)
- Step 2: Generate Drizzle migration: `bun run db generate --name workflow_run`
- Step 3: Port `persistence.ts` — `WorkflowPersistence` namespace with recordStart, recordPhase, flushCounters, recordTerminal, list, load, writeScript, readScript, appendJournalSync, loadJournal, clearJournal
- Step 4: Write unit tests: DB CRUD, journal round-trip, content-keyed dedup

### Phase 4: Runtime & Workspace (`src/workflow/runtime.ts`, `src/workflow/workspace.ts`)

- Step 1: Port `workspace.ts` — `resolveInWorkspace()` jail check, `makeFileHooks()` (readFile, writeFile, exists, glob)
- Step 2: Create `src/workflow/events.ts` — BusEvent definitions (WorkflowStarted, WorkflowFinished, WorkflowPhase, WorkflowLog, WorkflowAgentFailed, WorkflowChildFailed)
- Step 3: Port `runtime.ts` as Effect Context.Service — `WorkflowRuntime.Service` with start/status/wait/cancel/list/resume interface; implement launch logic with global semaphore, journal replay, agent hook (spawning subagents via existing task-spawn), phase tracking
- Step 4: Create `src/workflow/runtime-ref.ts` — late-bound module reference (same pattern as MiMo) so tool layer avoids hard dependency
- Step 5: Wire WorkflowRuntime.layer with Bus, Config dependencies; populate runtime-ref on init

### Phase 5: Feature Flag & Config Integration

- Step 1: Add `OPENCODE_EXPERIMENTAL_WORKFLOWS` flag to `src/flag/flag.ts` (gated by `enabledByExperimental`)
- Step 2: Add `workflow` section to config experimental schema: `workflow: z.boolean()`, plus `workflow_max_concurrent_agents`, `workflow_agent_timeout_ms`, `workflow_max_depth`
- Step 3: Gate runtime layer initialization on flag (no-op when disabled)

### Phase 6: Workflow Tool (`src/tool/workflow.ts`)

- Step 1: Create `workflow.ts` tool definition — parameters: `script` (name or inline), `args`, `wait` (bool), `max_concurrent_agents`
- Step 2: Implement execute: resolve script → start run → optionally wait → return runID + status
- Step 3: Create `workflow.txt` tool description
- Step 4: Register tool in `src/tool/registry.ts` (additive, gated on flag)
- Step 5: Write integration test: tool invocation with mocked sandbox

### Phase 7: TUI Integration (additive)

- Step 1: Add `/workflow` slash command — list, start, status, cancel subcommands
- Step 2: Wire WorkflowStarted/Finished/Phase events to TUI toast notifications
- Step 3: Surface run status in session metadata

## Risks/Edge cases

- **quickjs-emscripten WASM size**: ~2MB added to binary; mitigation: lazy-load only when workflow flag enabled, WASM loaded on first eval
- **Host promise starvation**: Guest parked on async hook can idle-spin the pump timer; mitigation: adaptive pump cadence (fast→slow backoff, same as MiMo)
- **Journal corruption on crash**: appendFileSync is not atomic; mitigation: JSONL format, skip malformed lines on reload (same resilience as MiMo)
- **Symlink jail escape**: workspace file hooks use lexical path check only; mitigation: document limitation, defer realpath hardening to post-flag graduation
- **Upstream rebase safety**: All new files in `src/workflow/`; only additive touches to flag.ts (one const), config schema (one optional key), tool registry (one gated entry); no existing signatures modified
- **Resume determinism**: Seeded PRNG keyed on runID hash; if script changes between runs, sha mismatch triggers fresh journal (no stale replay)
- **Memory leaks in QuickJS handles**: Arena + deferred tracking pattern ensures all handles disposed in finally block; unit test asserts no alive handles post-eval
