# Plan: OpenAI Response Chaining (`previousResponseId`)

## Overview

Enable server-side conversation threading via OpenAI Responses API `previousResponseId`. OpenAI retains conversation context server-side — the SDK skips re-sending historical messages, reducing input tokens and latency. Always-on for native OpenAI provider (`store: true`). No feature flag.

## Tech Stack

- TypeScript, Effect-ts
- `@ai-sdk/openai` 3.0.71+ (Responses API already default)
- SQLite (Drizzle) for response ID persistence
- Existing message schema extension

## Testing Strategy

- Unit: `transform.test.ts` — verify `store: true` for openai, `previousResponseId` injected when response_id available
- Unit: `processor.ts` — verify response ID extracted and persisted in step-finish metadata
- Integration: `llm.test.ts` — verify response ID flows from response → storage → next request
- Done when: full cycle (respond → store → replay → verify in request body) passes

## Phases

### Phase 1: Store + Capture Response ID

- Step 1: In `options()` (`transform.ts`), change `store: false` → `store: true` for openai/`@ai-sdk/openai` (NOT copilot, NOT openai-compatible)
- Step 2: Add optional `response_id` field to `StepFinishPart` schema (`message-v2.ts`)
- Step 3: In `processor.ts` finish-step handler (line 642), extract `value.providerMetadata?.openai?.responseId` and include in `updatePart()` call

### Phase 2: Replay Response ID

- Step 1: Add `lastResponseId?: string` to `StreamInput` interface in `llm.ts`
- Step 2: Caller (session processor) reads last assistant message's final step-finish part for `response_id`, passes it to `LLM.stream()`
- Step 3: In `llm.ts`, if `lastResponseId` present AND provider is native openai, inject `previousResponseId` into options before `providerOptions()` wraps them

### Phase 3: Invalidation

- Step 1: After any compaction (sliding-window, microcompact, context-collapse, reactive-compact), do NOT pass the stale `response_id` — compaction resets the chain
- Step 2: Simple guard: if messages were compacted/summarized since the last response, skip `previousResponseId`
- Step 3: Track via existing `CompactionPart` — if a compaction part exists after the last step-finish with response_id, the chain is broken

## Risks/Edge cases

- **Stale response ID**: If OpenAI purges stored responses (unknown TTL), request may fail — need retry without `previousResponseId` (catch error, clear ID, retry)
- **Provider switching mid-session**: Response ID from OpenAI invalid for other providers — already gated by provider check in Phase 2
- **Compaction breaks chain**: Handled by Phase 3 — compaction part acts as chain-break sentinel
- **Multi-step (tool loop)**: Each step produces new response ID; use the LAST step-finish's response_id for next turn
- **GitHub Copilot**: Keeps `store: false` — different provider, no chaining
- **Cost visibility**: `store: true` means responses appear in OpenAI dashboard — informational, not a bug
