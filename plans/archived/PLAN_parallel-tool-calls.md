# Plan: Safe Tool-Call Parallelization

## Overview

Enable parallel execution of read-only tool calls (grep, glob, read) in subagent sessions when permissions are pre-approved, while preserving serial execution as fallback for interactive/stateful scenarios. Phased rollout: grep/glob first, read later, with explicit safety gates and opt-out.

## Tech Stack

- TypeScript 5.8.2 + Bun 1.3.11
- Effect 4.0.0-beta.43 (existing concurrency primitives)
- Vercel AI SDK 6.0.138 (provider-specific `providerOptions` support for `parallelToolCalls`)
- Existing tool registry, session processor, and permission system

## Testing Strategy

- Unit: per-tool concurrency safety, permission-gate logic, toolCallId tracking
- Integration: multi-tool-call session loop, subagent-through-task parity, mixed allow/deny races
- Done when: grep/glob parallel by default for subagents with pre-approved permissions; read parallel behind flag; serial fallback proven; no regression in existing test suites

## Phases

### Phase 1: Permission-Aware Parallel Gate

- Step 1: Add a `canParallelize(tool, agent)` check in the tool registry that returns true only when the tool's required permissions are already allowed (no `ctx.ask` prompt needed)
- Step 2: Add provider-option wiring in `session/llm.ts`, defaulting to serial behavior unless the parallel gate enables it
- Step 3: Wire `parallelToolCalls` to resolve dynamically: enabled when all tools in the current step pass `canParallelize`, disabled otherwise
- Step 4: Unit tests for gate logic with allow/ask/deny permission combinations

### Phase 2: Grep + Glob Parallel Execution

- Step 1: Mark grep and glob as parallel-safe in the tool registry (they are near-side-effect-free)
- Step 2: Enable provider-specific `parallelToolCalls` request options in `session/llm.ts` when all pending tool calls in a step are parallel-safe and permissions are pre-approved
- Step 3: Integration test: session with 3 concurrent grep/glob calls, assert correct `toolCallId` mapping and result ordering
- Step 4: Integration test: mixed grep + bash call in same step, assert fallback to serial
- Step 5: Subagent-through-task parity test: same parallel behavior via `task.ts`

### Phase 3: Read Parallel (Guarded)

- Step 1: Audit read tool's stateful side effects (LSP warm, file-time, instruction overlay) for concurrency safety
- Step 2: Add concurrency guards where needed (e.g., file-time writes)
- Step 3: Mark read as parallel-safe behind an experimental config flag (`experimental.parallel_read`)
- Step 4: Read-specific concurrency test: 3 concurrent reads, assert no state corruption in LSP/file-time
- Step 5: Mixed read + grep parallel test

### Phase 4: Configuration and Opt-Out

- Step 1: Add `experimental.parallel_tool_calls` config option (default: `true` for subagents, `false` for primary agent)
- Step 2: Add per-provider override capability via `config.provider.<id>.parallelToolCalls` (including explicit disable for problematic providers)
- Step 3: Add per-agent override in agent config (`parallelToolCalls: true/false`)
- Step 4: Documentation update for config options

## Risks

- **Permission race conditions**: Mitigated by Phase 1 gate — only parallelize when no interactive prompt is needed
- **Stop-on-deny with concurrent tools**: Mitigated by serial fallback when any tool requires `ctx.ask`
- **Read state corruption under concurrency**: Mitigated by Phase 3 audit and experimental flag gate
- **Provider incompatibility**: Mitigated by Phase 4 per-provider override and default-off for primary agent
- **Result ordering affects model reasoning**: Low risk — AI SDK handles tool result association by `toolCallId`, not position
