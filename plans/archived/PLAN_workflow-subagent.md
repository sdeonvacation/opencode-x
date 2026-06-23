# Plan: Deterministic Workflow Execution as Background Subagent

## Overview

Create a standalone workflow tool that behaves identically to the Task tool's background mode from a UX perspective (navigable child session, background counter, toast notifications) but uses deterministic execution internally. The Task tool is NOT modified. The workflow tool replicates the same infrastructure patterns (spawnSubagent, BackgroundJob, TuiEvent) to achieve matching TUI behavior.

## Tech Stack

- Runtime: Bun
- Language: TypeScript
- Framework: Effect-ts
- Sandbox: QuickJS (existing)
- TUI: @opentui/solid (existing)
- Database: SQLite/Drizzle (existing)

## Testing Strategy

- Unit: Task tool deterministic mode (runner param, no LLM call, session created)
- Unit: Workflow session message writing (synthetic messages appear in session)
- Unit: Agent inline execution (SessionPrompt.prompt called in workflow session)
- Integration: Full workflow: trigger → background session → phases/bash/agent steps → completion toast
- Done when: User triggers /workflow → sees background task → navigates in → sees full transcript with phases, tool calls, agent responses

## Phases

### Phase 1: Workflow Tool as Background Subagent (standalone)

Rewrite workflow tool to spawn a background subagent session using the same infrastructure as Task tool.

- Step 1: Use `spawnSubagent` to create child session (same as Task tool does)
- Step 2: Use `BackgroundJob.Service` to register the background job (same fiber/Effect pattern)
- Step 3: Publish `TuiEvent.BackgroundTaskUpdate` with `state: "running"` (same event)
- Step 4: Set `ctx.metadata({ sessionId, background: true })` (same metadata shape — triggers `<Task>` component)
- Step 5: Return `backgroundOutput(sessionID)` format (same output shape as Task tool)
- Step 6: On complete/error: publish BackgroundTaskUpdate + ToastShow (same pattern)
- Step 7: Use `Tool.defineEffect` for proper Effect runtime context

### Phase 2: WorkflowSessionWriter

New module that writes synthetic messages and tool parts into the workflow session.

- Step 1: `writePhase(sessionID, phase)` — creates synthetic assistant message with phase header
- Step 2: `appendLog(sessionID, level, message)` — appends text part to current message
- Step 3: `writeTool(sessionID, { tool, args, output, title })` — writes a tool part (bash/read/write)
- Step 4: `writeStatus(sessionID, status, error?)` — writes final completion/failure message
- Step 5: All writes via `SyncEvent.run(MessageV2.Event.Updated/PartUpdated)` (synchronous, no Effect overhead)

### Phase 3: Runtime executeInSession with Session Writing

Refactor WorkflowRuntime.executeInSession to write a full transcript into the session.

- Step 1: `phase()` hook → `WorkflowSessionWriter.writePhase()`
- Step 2: `log()` hook → `WorkflowSessionWriter.appendLog()`
- Step 3: `bash()` hook → spawn process, `WorkflowSessionWriter.writeTool("bash", ...)`
- Step 4: `readFile()`/`writeFile()` hooks → `WorkflowSessionWriter.writeTool("read"/"write", ...)`
- Step 5: `agent()` hook → call `SessionPrompt.prompt({ sessionID: workflowSession, parts })` — LLM responds inline
- Step 6: After agent completes, extract result text from response

### Phase 4: TUI Rendering (already done)

Verify the TUI renders workflow tool parts as navigable subagents.

- Step 1: `<Match when={props.part.tool === "task" || props.part.tool === "workflow"}>` (already applied)
- Step 2: "view subagents" link includes workflow parts (already applied)
- Step 3: Session ID resolution includes workflow parts (already applied)
- Step 4: Verify background counter shows correctly

### Phase 5: Slash Command Integration

Wire /workflow slash command to trigger the workflow tool.

- Step 1: /workflow command shows list of available scripts (already exists)
- Step 2: On selection, invoke workflow tool programmatically
- Step 3: Toast shows "Workflow started", background counter increments

## Risks/Edge cases

- **Agent step timeout**: agent() calls SessionPrompt.prompt inline — if the LLM hangs, the whole workflow blocks. Mitigation: wrap with timeout from workflow config.
- **Multiple agent steps share context**: Since all agent() calls happen in the same session, the LLM accumulates context from previous steps. This is a FEATURE (agents see previous work) but can overflow context. Mitigation: compaction between steps if needed.
- **Task tool parameter exposure**: `runner: "deterministic"` should NOT be exposed to the LLM (it can't call task with this mode). Only internal/programmatic callers use it. Mitigation: strip from schema shown to LLM, only accept via extra.
- **Concurrent agent steps**: Workflow scripts can call agent() sequentially but not in parallel (QuickJS asyncify limitation — one eval at a time). Mitigation: document this; parallel workflows still serialize sandbox access.
- **Session state on failure**: If workflow fails mid-execution, the session shows partial transcript. Mitigation: final synthetic message marks failure with error.
