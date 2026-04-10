# Requirement: Orchestration Quick Wins

## Summary

Adopt low-risk, high-value orchestration features from oh-my-openagent plugin directly into opencode core. All features must be **additive** (new files preferred), **config-gated**, and **rebase-safe** against upstream.

## Features

### R1: Loop Detector / Circuit Breaker

Detect when a tool (or subagent) repeatedly invokes the same tool with the same input. After a configurable threshold (default 5 consecutive identical calls), abort/escalate rather than loop forever.

- Must track per-session tool call signatures (tool name + deterministic JSON of input).
- Must be a standalone module consumed by session/tool execution path.
- Config: `experimental.loop_detector_threshold` (number, default 5).

### R2: Subagent Spawn Guardrails

Prevent infinite subagent recursion and runaway descendant counts.

- Enforce max subagent depth (default 3).
- Enforce max total descendants per root session (default 50).
- Config: `experimental.max_subagent_depth`, `experimental.max_subagent_descendants`.
- Fail with clear error message when limit hit.

### R3: Provider/Model Concurrency Limiter

Queue-based semaphore keyed by provider+model to prevent API rate-limit violations when multiple subagents run concurrently.

- Default concurrency per key: 5.
- Config: `experimental.model_concurrency` (Record<string, number>).
- Must support acquire/release/cancel semantics.
- Wire into task tool and batch tool execution paths.

### R4: Orchestration Bus Events

Publish typed events for orchestration lifecycle (spawn, complete, abort, loop detected, concurrency queued/released) via existing Bus infrastructure.

- New event definitions only; no changes to Bus internals.
- Enable observability without modifying core event flow.

### R5: Category-Based Model Routing (Config Only)

Allow config to map task categories to specific model+provider combos.

- Config: `experimental.task_categories` (Record<string, { providerID, modelID }>).
- When task tool receives a matching category hint, override model selection.
- Fallback: current behavior (inherit parent model).

### R6: Ultrawork-Style Model Override Keyword

Detect "ulw" or "ultrawork" keyword in user prompt and temporarily override to a configured high-reasoning model.

- Config: `experimental.ultrawork_model` ({ providerID, modelID }).
- Implement via existing plugin hook on message transform.
- No-op if config not set.

## Non-Functional Requirements

- All features behind `experimental.*` config flags.
- All core logic in **new files** — minimize edits to existing hot files.
- Each feature independently testable with unit tests in new test files.
- No changes to existing tool interfaces or session state machine.
- No changes to database schema or migrations.

## Out of Scope

- Hash-anchored edits (separate feature).
- LSP integration (separate feature).
- Tmux visual orchestration (separate feature).
- Fallback model chain with error classification (separate feature).
- Agent babysitter / todo enforcer (separate feature).
