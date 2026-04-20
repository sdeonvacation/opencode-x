# HLD: Hybrid Routing v4 — Local Model as Output Compressor

## Tech Stack

| Category  | Technology         | Purpose                                        |
| --------- | ------------------ | ---------------------------------------------- |
| Language  | TypeScript 5.8     | Type-safe implementation with strict inference |
| Framework | Effect-ts 4.0-beta | Structured async, error handling, services     |
| AI SDK    | Vercel AI SDK 6.x  | generateText (non-streaming), model wrapping   |
| Runtime   | Bun 1.3.11         | Fast execution, native TypeScript support      |
| Database  | SQLite (Drizzle)   | Session persistence (no schema changes)        |
| Config    | Zod schemas        | Type-safe configuration validation             |

## Components

| Component                        | Responsibility                                       | Dependencies                                   |
| -------------------------------- | ---------------------------------------------------- | ---------------------------------------------- |
| **LLMCompress**                  | Non-streaming text generation for output compression | Provider, Auth, Config, Log                    |
| **CompressionTemplate**          | Template selection logic (EXTRACT/SUMMARIZE/FILTER)  | route-classifier (new helpers)                 |
| **SessionProcessor**             | Integration hook into tool completion flow           | LLMCompress, route-classifier, session storage |
| **RouteClassifier**              | Template mapping + threshold check (new helpers)     | route-classifier (unchanged logic)             |
| **Config.Hybrid**                | Compression config schema extension                  | Zod                                            |
| **LLM.stream()**                 | Remove local agent turn path (cleanup)               | llm.ts (minor edits)                           |
| **tool-filter.filterForRoute()** | Remove dead code for local route                     | tool-filter.ts (minor edits)                   |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    SessionProcessor                         │
│                  (completeToolCall flow)                    │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
        ┌────────────────────────────────┐
        │  shouldCompress(output, cfg)?  │ ← RouteClassifier
        └────────────────┬───────────────┘
                         │
                    ┌────┴────┐
                    ▼         ▼
                  YES        NO
                    │         │
                    ▼         ▼
            ┌──────────────┐  │
            │ LLMCompress  │  │
            │              │  │
            │ ┌──────────┐ │  │
            │ │ template │ │  │
            │ │ selection│ │  │
            │ └──────────┘ │  │
            │              │  │
            │ ┌──────────┐ │  │
            │ │generateText
            │ │(local LLM)│ │  │
            │ └──────────┘ │  │
            │              │  │
            │ ┌──────────┐ │  │
            │ │  stats   │ │  │
            │ │ + fallback
            │ └──────────┘ │  │
            └──────┬───────┘  │
                   │          │
                   └────┬─────┘
                        ▼
            ┌─────────────────────────┐
            │ Update tool result part │
            │ with compressed output  │
            │ + metadata tag          │
            └──────────┬──────────────┘
                       ▼
            ┌─────────────────────────┐
            │   Continue loop         │
            │   CLOUD gets result     │
            └─────────────────────────┘
```

**Description:**

Compression is **preprocessing**, not routing. It runs after tool execution completes and before the result enters the message history. The flow is:

1. **Tool executes** → raw output captured
2. **shouldCompress check** → line count > threshold?
3. **If yes**: Call LLMCompress.compress() with:
   - System message: anti-hallucination constraint (always present)
   - User message: template instruction + raw tool output
   - No session history, no prior reasoning, no tools
   - Local model from config
4. **generateText call** → compressed text returned
5. **validateCompression** → expansion check + empty check
6. **If valid**: replace raw output with compressed, tag metadata
7. **If invalid**: keep raw output, tag metadata with `validated: false`
8. **Continue loop** → CLOUD model receives result in history

**Key boundaries:**

- Compression is **independent of route decision** (classifier unchanged)
- Local model **never sees session history** (only system message + template + raw output)
- **Async but awaited** in loop (deterministic sequencing)
- **Fallback to raw** on any error or validation failure (zero data loss)
- **Post-compression validation** rejects expansion and empty output
- **Feature-gated** behind hybrid.enabled + OPENCODE_HYBRID_ROUTING flag

## Interfaces

### LLMCompress Namespace

```typescript
export namespace LLMCompress {
  // Input to compress function
  export type Input = {
    tool: string // "grep", "read", "bash", etc.
    output: string // raw tool output
    template: CompressionTemplate // EXTRACT | SUMMARIZE | FILTER
    model: Provider.Model // local model reference
    threshold: number // compression line threshold
  }

  // Output statistics
  export type Stats = {
    input_lines: number // line count of raw output
    output_lines: number // line count of compressed output
    ratio: number // output_lines / input_lines
    template: string // template name used
    model: string // model ID
    fallback: boolean // true if compression failed, used raw
    validated: boolean // true if passed post-compression validation
    duration_ms: number // compression latency
  }

  // Result type
  export type Result = {
    compressed: string // compressed output (or raw if fallback)
    stats: Stats
  }

  // Main compression function — returns Effect (never fails, fallback on error)
  // Uses Effect.fn for tracing, catches all errors internally
  export const compress: (input: Input) => Effect.Effect<Result>
}
```

### RouteClassifier Extensions

```typescript
// Compression template type
export type CompressionTemplate = "extract" | "summarize" | "filter"

// System message (anti-hallucination constraint, always present in generateText call)
export const COMPRESSION_SYSTEM = `You are a lossless compression tool. Rules:
- Output ONLY facts present in the input
- Never add information, analysis, or recommendations
- Never infer intent or suggest next steps
- Preserve all identifiers: file paths, line numbers, symbol names, error codes
- If unsure whether to keep or drop, keep it`

// Template strings (hard-coded, optional config override)
export const COMPRESSION_TEMPLATES: Record<CompressionTemplate, string> = {
  extract: `Extract only the key lines from the following tool output.
Return file paths, line numbers, matching content, and error messages.
Use bullet format. Max 20 items.
Do NOT add commentary, analysis, or recommendations.
Do NOT infer what the results mean.`,

  summarize: `Summarize the following content in 3-6 bullets.
Preserve all identifiers (file paths, line numbers, function names, class names).
Keep code structure references (which function, which class, which module).
Do NOT add interpretation, analysis, or recommendations.
Do NOT speculate about purpose or intent.`,

  filter: `Return only the relevant items from the following output.
Drop duplicate entries, empty lines, and boilerplate.
Keep error codes, file paths, test names, and status indicators.
Do NOT add summary, analysis, or recommendations.
Do NOT reorder or reinterpret the items.`,
}

// Tool → template mapping
export function templateFor(toolName: string): CompressionTemplate {
  // grep, glob, bash, list → EXTRACT
  // read → SUMMARIZE (or EXTRACT if JSON-like)
  // Default → EXTRACT
}

// Threshold check
export function shouldCompress(output: string, threshold: number): boolean {
  return listLines(output) > threshold
}

// Post-compression validation
export function validateCompression(raw: string, compressed: string): boolean {
  const rawLines = listLines(raw)
  const compLines = listLines(compressed)
  // Expansion check: compressed must be strictly shorter than raw
  // Note: equality (==) is allowed — 1-line compression of 1-line input is valid
  if (compLines > rawLines) return false
  // Empty check: compressed must have content
  if (!compressed.trim()) return false
  return true
}
```

### SessionProcessor Integration

```typescript
// ProcessorContext additions (add to existing interface at line 67)
interface ProcessorContext extends Input {
  // ... existing fields (toolcalls, shouldBreak, snapshot, blocked, etc.) ...
  localModel?: Provider.Model // resolved local model for compression
  compressionThreshold: number // from config, default 10
}

// Local model resolution in create() (add to existing Effect.gen at line 95)
// Uses same pattern as route-classifier.ts resolve():
const cfg = yield * Config.Service
const ref = cfg.hybrid?.local_model
const localModel = ref
  ? yield *
    Effect.tryPromise(() => Provider.getModel(ProviderID.make(ref.providerID), ModelID.make(ref.modelID))).pipe(
      Effect.option,
    ) // None on error → skip compression
  : Option.none()

const ctx: ProcessorContext = {
  // ... existing fields ...
  localModel: Option.getOrUndefined(localModel),
  compressionThreshold: cfg.hybrid?.compression_threshold ?? 10,
}
```

```typescript
// completeToolCall enhancement — uses Effect.fn pattern matching codebase
// Insert BETWEEN session.updatePart (line 179) and settleToolCall (line 191)
// Placement: after raw output is stored, before tool call is settled
const completeToolCall = Effect.fn("SessionProcessor.completeToolCall")(function* (
  toolCallID: string,
  output: { title: string; metadata: Record<string, any>; output: string; attachments?: MessageV2.FilePart[] },
) {
  const match = yield* readToolCall(toolCallID)
  if (!match || match.part.state.status !== "running") return

  // Step 1: Store raw output (existing code, unchanged)
  yield* session.updatePart({
    ...match.part,
    state: {
      status: "completed",
      input: match.part.state.input,
      output: output.output,
      metadata: output.metadata,
      title: output.title,
      time: { start: match.part.state.time.start, end: Date.now() },
      attachments: output.attachments,
    },
  })

  // Step 2: Compress if threshold exceeded + local model configured + feature enabled
  // NEW CODE — inserted between updatePart and settleToolCall
  if (shouldCompress(output.output, ctx.compressionThreshold) && ctx.localModel) {
    const result = yield* LLMCompress.compress({
      tool: match.part.state.tool,
      output: output.output,
      template: templateFor(match.part.state.tool),
      model: ctx.localModel,
      threshold: ctx.compressionThreshold,
    })
    // Overwrite part with compressed output + metadata tags (all snake_case)
    yield* session.updatePart({
      ...match.part,
      state: {
        status: "completed",
        input: match.part.state.input,
        output: result.compressed,
        metadata: {
          ...output.metadata,
          compressed: true,
          compression_template: result.stats.template,
          compression_ratio: result.stats.ratio,
          compression_fallback: result.stats.fallback,
          compression_validated: result.stats.validated,
        },
        title: output.title,
        time: { start: match.part.state.time.start, end: Date.now() },
        attachments: output.attachments,
      },
    })
  }

  // Step 3: Settle tool call (existing code, unchanged)
  yield* settleToolCall(toolCallID)
})
```

**Key Effect-ts patterns used:**

- `Effect.fn("name")(function* (...) { ... })` — traced named effect (matches lines 168, 131, 137)
- `yield*` — compose effects (not `await`)
- `Effect.tryPromise()` — wrap async model resolution
- `Effect.option` — convert error to Option.none (skip compression on resolution failure)
- `LLMCompress.compress()` returns `Effect<Result, never, never>` — errors caught internally, always returns fallback

## Data Flow

| Step | Component                         | Action                                                         | Next        |
| ---- | --------------------------------- | -------------------------------------------------------------- | ----------- |
| 1    | Tool (bash/grep/read/etc)         | Execute, capture raw output                                    | Step 2      |
| 2    | SessionProcessor.completeToolCall | Check shouldCompress(output, threshold) && localModel          | Step 3 or 8 |
| 3    | LLMCompress.compress              | Select template via templateFor(toolName)                      | Step 4      |
| 4    | LLMCompress                       | generateText(system=COMPRESSION_SYSTEM, user=template+output)  | Step 5      |
| 5    | LLMCompress                       | validateCompression(raw, compressed) — expansion + empty check | Step 6 or 7 |
| 6    | LLMCompress (valid)               | Return compressed text + stats(validated=true)                 | Step 8      |
| 7    | LLMCompress (invalid)             | Return raw text + stats(fallback=true, validated=false)        | Step 8      |
| 8    | SessionProcessor                  | Update part: replace output, tag metadata                      | Step 9      |
| 9    | SessionPrompt loop                | Continue: CLOUD model receives result in history               | Step 10     |
| 10   | Route classifier                  | Decide next action (unchanged)                                 | End         |

**Error Flows:**

- **LLMCompress error** (network, model unavailable, timeout):
  - Catch exception
  - Log warning with tool, error message
  - Return raw output (fallback=true)
  - Tag metadata: `compression_fallback: true`
  - Continue loop with raw output (zero data loss)

- **Local model unconfigured**:
  - Skip compression entirely
  - Pass raw output to CLOUD (existing behavior)

- **Compression disabled (flag off or hybrid.enabled=false)**:
  - Skip compression
  - Pass raw output (zero behavior change)

## Prompt Structure

### How the Local Model Is Prompted

The local model receives exactly **two messages** via `generateText`. No session history, no prior reasoning, no tools.

#### Message 1: System (always present)

```
You are a lossless compression tool. Rules:
- Output ONLY facts present in the input
- Never add information, analysis, or recommendations
- Never infer intent or suggest next steps
- Preserve all identifiers: file paths, line numbers, symbol names, error codes
- If unsure whether to keep or drop, keep it
```

This is `COMPRESSION_SYSTEM` constant. It acts as the primary hallucination guard.

#### Message 2: User (template + raw output)

```
<TEMPLATE_INSTRUCTION>

<RAW_TOOL_OUTPUT>
```

Example (grep with EXTRACT template):

```
Extract only the key lines from the following tool output.
Return file paths, line numbers, matching content, and error messages.
Use bullet format. Max 20 items.
Do NOT add commentary, analysis, or recommendations.
Do NOT infer what the results mean.

src/A.java:23: error: cannot resolve symbol 'foo'
src/A.java:45: error: cannot resolve symbol 'bar'
src/B.java:12: warning: unused import
src/C.java:67: error: method not found
... (400 more lines)
```

#### generateText Call

```typescript
const response = await generateText({
  model: wrapLanguageModel({ model: language, middleware: [...] }),
  system: COMPRESSION_SYSTEM,
  messages: [
    {
      role: "user",
      content: `${COMPRESSION_TEMPLATES[template]}\n\n${rawOutput}`
    }
  ],
  temperature: 0,          // Deterministic — no randomness
  maxTokens: 1024,         // Hard cap — see token budget analysis below
  abortSignal: AbortSignal.timeout(5000), // 5s timeout — prevents hanging
  // No tools — model cannot call any tools
  // No history — model cannot read prior reasoning
  // No streaming — single response
})
```

**Token budget analysis (maxTokens: 1024):**

| Template  | Max output spec                          | Estimated tokens      | 512 sufficient?         | 1024 sufficient? |
| --------- | ---------------------------------------- | --------------------- | ----------------------- | ---------------- |
| EXTRACT   | "Max 20 items" in bullet format          | ~20 × 15 = 300 tokens | ✅ Yes                  | ✅ Yes           |
| SUMMARIZE | "3–6 bullets" with identifiers           | ~6 × 30 = 180 tokens  | ✅ Yes                  | ✅ Yes           |
| FILTER    | "Return only relevant items" (unbounded) | Variable, up to ~800  | ⚠️ Risky on large input | ✅ Yes           |

FILTER template has no explicit item cap. With large inputs (e.g., 500-line diff with many relevant changes), 512 tokens risks truncation. 1024 provides 2× safety margin while still enforcing a hard cap against rambling. The `validateCompression()` check ensures truncated output (if shorter than raw) still passes.

**Timeout rationale:** 5 seconds covers typical local model inference (200–800ms) with margin for cold start. On timeout, the catch block returns raw output (fallback).

## Anti-Hallucination Guards

Six layered guards prevent the local model from inventing information:

### Guard 1: System Message (Primary)

The `COMPRESSION_SYSTEM` message explicitly forbids:

- Adding information not in the input
- Inference or speculation
- Recommendations or next-step suggestions
- Dropping identifiers

This is the strongest guard — it constrains model behavior at the instruction level.

### Guard 2: Template Negative Constraints (Secondary)

Each template includes explicit "Do NOT" clauses:

- EXTRACT: "Do NOT add commentary, analysis, or recommendations. Do NOT infer what the results mean."
- SUMMARIZE: "Do NOT add interpretation, analysis, or recommendations. Do NOT speculate about purpose or intent."
- FILTER: "Do NOT add summary, analysis, or recommendations. Do NOT reorder or reinterpret the items."

### Guard 3: No Session History (Structural)

The local model **never sees**:

- Prior user messages
- Prior assistant reasoning
- System prompts from other steps
- Conversation context

This prevents the original bug: the model cannot follow instructions from CLOUD reasoning because it never sees them.

### Guard 4: Temperature 0 (Deterministic)

`temperature: 0` produces deterministic output — no randomness, consistent behavior across runs.

### Guard 5: Max Tokens 1024 (Hard Cap)

`maxTokens: 1024` prevents the model from generating lengthy fabrications. See token budget analysis in §Prompt Structure for per-template breakdown. Combined with `validateCompression()`, even if the model uses all 1024 tokens, expansion is caught and rejected.

### Guard 6: Post-Compression Validation (Tertiary)

After `generateText` returns, before updating the part:

```typescript
export function validateCompression(raw: string, compressed: string): boolean {
  const rawLines = listLines(raw)
  const compLines = listLines(compressed)

  // Expansion check: compressed must be strictly shorter than raw
  // Equality allowed — 1-line compression of 1-line input is valid
  if (compLines > rawLines) return false

  // Empty check: compressed must have content
  if (!compressed.trim()) return false

  return true
}
```

**If validation fails:**

- Use raw output instead of compressed
- Set `stats.fallback = true`, `stats.validated = false`
- Log warning with reason (`"expansion"` or `"empty_output"`)
- Tag metadata: `compression_validated: false`

This catches two failure modes:

1. Model expanded instead of compressing (hallucinated extra content)
2. Model returned empty output (failed to produce anything useful)

### Guard Summary

| Guard                       | What it prevents                                     | When it acts                   |
| --------------------------- | ---------------------------------------------------- | ------------------------------ |
| System message              | Fabrication, inference, recommendations              | During generation              |
| Template "Do NOT"           | Template-specific hallucination patterns             | During generation              |
| No session history          | Following prior reasoning, calling unavailable tools | Before generation (structural) |
| Temperature 0               | Random/creative output                               | During generation              |
| Max tokens 1024             | Lengthy fabrication, rambling                        | During generation              |
| Post-compression validation | Expansion, empty output                              | After generation               |

### Known Limitation: Semantic Hallucination

Post-compression validation catches **structural** failures (expansion, empty output) but NOT **semantic** hallucination (e.g., model returns "The answer is 42" when input was grep output). This is accepted because:

1. Guards 1–5 make semantic hallucination unlikely (system message forbids it, template constrains it, no history prevents reasoning drift, temp=0 removes randomness, token cap limits scope)
2. Adding semantic validation (e.g., token overlap scoring) would add latency and complexity disproportionate to the risk
3. If semantic hallucination occurs, CLOUD model receives wrong context but the session continues — no data loss, no crash
4. Structured logging captures `compression_ratio` — anomalous ratios (e.g., 0.01 on a 20-line input) can be flagged in post-hoc analysis

## Data Model

### Tool Result Part (existing MessageV2.ToolPart.state)

**Metadata naming convention:** All compression metadata keys use **snake_case** (matching Drizzle schema convention and existing `providerExecuted` pattern). The `metadata` field is typed as `Record<string, any>` — no schema change needed.

```typescript
state: {
  status: "completed"
  input: Record<string, unknown>
  output: string                    // ← compressed output replaces raw
  metadata: {
    // existing fields...

    // NEW compression metadata:
    compressed?: boolean            // true if compression applied
    compression_template?: string   // "extract" | "summarize" | "filter"
    compression_ratio?: number      // output_lines / input_lines
    compression_fallback?: boolean  // true if compression failed, used raw
    compression_validated?: boolean // true if passed post-compression validation

    // existing fields (unchanged):
    providerExecuted?: boolean
    // ... other metadata ...
  }
  title: string
  time: { start: number; end: number }
  attachments?: FilePart[]
}
```

### Config Extension (Hybrid schema)

```typescript
export const Hybrid = z.object({
  enabled: z.boolean().optional().default(false),
  local_model: HybridModelRef.optional(),
  cloud_model: HybridModelRef.optional(),
  log_routing: z.boolean().optional().default(false),

  // NEW fields:
  compression_threshold: z
    .number()
    .int()
    .min(1)
    .optional()
    .default(10)
    .describe("Line count threshold for compression (default: 10)"),

  compression_templates: z
    .record(z.string(), z.string())
    .optional()
    .describe("Per-tool template override map (optional)"),
})
```

## Decisions

| Decision                       | Choice                                   | Reason                                                  | Alternatives                                 | Tradeoffs                                                                            |
| ------------------------------ | ---------------------------------------- | ------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Compression timing**         | After tool execution, before history     | Captures real output, deterministic                     | During tool execution, as annotation         | After-execution allows error recovery; annotation doesn't affect CLOUD reasoning     |
| **Local model scope**          | Output only, no history                  | Prevents "reasoning agent" bug, faster                  | Full history + system prompt                 | No history means less context for compression, but prevents cloud-tool hallucination |
| **generateText vs streamText** | generateText (non-streaming)             | Simpler, no streaming overhead for small outputs        | streamText                                   | generateText sufficient for max 512 output tokens                                    |
| **Template selection**         | Hard-coded + optional config override    | 3 templates cover 95% of tools, override for edge cases | Dynamic ML-based selection, per-tool prompts | Hard-coded is predictable; override hook allows customization                        |
| **Threshold heuristic**        | Line count > 10 (default)                | Conservative: uncertain = pass raw                      | Token count, file size                       | Line count is simple, tool-independent; token count requires model knowledge         |
| **Fallback strategy**          | Return raw output on any error           | Zero data loss, deterministic                           | Omit output, skip tool                       | Raw output preserves information; omitting would break reasoning                     |
| **Feature gate**               | hybrid.enabled + OPENCODE_HYBRID_ROUTING | Existing pattern, explicit opt-in                       | Config only, flag only                       | Dual gate ensures both config and runtime flag must enable                           |
| **Metadata tagging**           | In part.state.metadata                   | Preserves in history, queryable                         | Separate logging only                        | Metadata in state allows downstream analysis, debugging                              |

## Risks

| Risk                                         | Impact                                       | Likelihood | Mitigation                                                                                  |
| -------------------------------------------- | -------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------- |
| **Compression loses critical info**          | CLOUD reasoning fails, wrong next step       | Medium     | Templates preserve identifiers; fallback to raw on error; test with real outputs            |
| **Local model unavailable**                  | Fallback to raw, no compression              | Low        | Config validation; skip compression if model not configured; log warning                    |
| **Latency per tool call**                    | Adds ~500ms-1s per compressed output         | Medium     | Only compress large outputs (>10 lines); savings on CLOUD tokens offset cost                |
| **Template mismatch**                        | Compressed output doesn't fit tool semantics | Low        | 3 general templates cover 95% of cases; override hook for edge cases; test coverage         |
| **Line count threshold false positives**     | Compress small structured output (JSON)      | Low        | Conservative default (10 lines); config override; test with common tool outputs             |
| **Upstream rebase conflicts**                | Merge conflicts in processor.ts, llm.ts      | Medium     | New logic in llm-compress.ts (no conflicts); surgical edits in processor.ts (minimal lines) |
| **Feature flag not respected**               | Compression runs even when disabled          | Low        | Check hybrid.enabled && OPENCODE_HYBRID_ROUTING before calling compress                     |
| **Compression timeout/hang**                 | Tool call blocked waiting for local model    | Low        | AbortSignal.timeout(5000) on generateText; fallback to raw on timeout                       |
| **Binary/non-text tool output**              | generateText fails on non-UTF8 input         | Low        | listLines() produces ≤threshold for binary → skipped; if not, catch block → fallback to raw |
| **Semantic hallucination passes validation** | CLOUD receives fabricated compressed output  | Low        | 6 guards prevent; validation catches structural failures; anomalous ratios logged for audit |

## Test Plan

### Unit Tests: `test/session/llm-compress.test.ts`

**Test: Template Selection**

- grep output → EXTRACT template
- read output → SUMMARIZE template
- bash output → EXTRACT template
- list output → EXTRACT template
- Config override: "grep" → SUMMARIZE (custom override)
- Unknown tool → EXTRACT (default)

**Test: Threshold Check**

- 5 lines, threshold 10 → shouldCompress = false
- 10 lines, threshold 10 → shouldCompress = false
- 11 lines, threshold 10 → shouldCompress = true
- 200 lines, threshold 10 → shouldCompress = true
- Empty output → shouldCompress = false

**Test: Compression Success**

- Input: grep output (50 lines)
- Template: EXTRACT
- Output: compressed result (5-8 lines)
- Stats: ratio ~0.1-0.2, fallback=false
- Verify: compressed output contains file paths, line numbers (identifiers preserved)

**Test: Compression Error → Fallback**

- Mock local model error (network failure)
- Input: read output (100 lines)
- Expected: raw output returned, fallback=true, warning logged
- Verify: output unchanged, stats.fallback=true

**Test: Local Model Unconfigured**

- Config: hybrid.enabled=true, local_model=undefined
- Input: grep output (50 lines)
- Expected: skip compression, return raw output
- Verify: no compress call, no error

**Test: Feature Disabled**

- Config: hybrid.enabled=false
- Input: grep output (50 lines)
- Expected: skip compression, return raw output
- Verify: no compress call

**Test: Output Format**

- Verify Result shape: { compressed: string, stats: Stats }
- Verify Stats fields: input_lines, output_lines, ratio, template, model, fallback
- Verify ratio calculation: output_lines / input_lines
- Verify template in stats matches used template

### Integration Tests: `test/session/processor.test.ts`

**Test: Compression Integrated into Tool Flow**

- Tool: grep (output 50 lines)
- Threshold: 10
- Expected: completeToolCall triggers compress, part.state.output is compressed
- Verify: metadata.compressed=true, metadata.compression_template="extract"

**Test: Small Output Bypasses Compression**

- Tool: grep (output 5 lines)
- Threshold: 10
- Expected: completeToolCall skips compress, part.state.output is raw
- Verify: metadata.compressed not set or false

**Test: Compression Metadata Persisted**

- Tool: bash (output 100 lines)
- Compress: success
- Query: session.getPart(toolPartID)
- Verify: part.state.metadata.compressed=true, ratio, template, fallback fields present

**Test: Fallback Metadata on Error**

- Tool: read (output 80 lines)
- Mock: local model error
- Expected: part.state.output is raw, metadata.compressed=true, fallback=true
- Verify: part.state.metadata.compression_fallback=true

**Test: Compression Context Fields**

- ProcessorContext: localModel, compressionThreshold populated from config
- Verify: localModel resolved correctly
- Verify: compressionThreshold defaults to 10 if not in config

### End-to-End Tests: `test/session/prompt.test.ts` (existing)

**Test: Compressed Output in CLOUD Turn**

- User: "grep for TODO"
- Tool: grep (output 50 lines)
- Compress: success (10 lines)
- CLOUD turn: receives compressed output in message history
- Verify: CLOUD reasoning uses compressed output, not raw
- Verify: CLOUD can still identify files, line numbers from compressed output

**Test: Full Session with Compression**

- Multi-turn session with grep, read, bash tools
- Large outputs (>10 lines) → compressed
- Small outputs (<10 lines) → raw
- Verify: session completes successfully
- Verify: all tool results in history have correct metadata

**Test: Compression Disabled (Zero Behavior Change)**

- Same session with hybrid.enabled=false
- Expected: identical behavior, all raw outputs
- Verify: no compression metadata in parts
- Verify: CLOUD reasoning unchanged

### Non-Functional Tests

**Performance:**

- Compression adds ~500ms per large output (local model inference)
- Savings on CLOUD tokens: ~20-30% reduction for large outputs
- Net latency: neutral or positive for multi-turn sessions

**Security:**

- Local model receives only tool output (no auth tokens, no session history)
- No new network calls (local model already configured)
- Config validation: compression_threshold is positive integer

**Scalability:**

- Compression is per-tool (no session-level aggregation)
- No new database queries
- Memory: compressed output typically 1/5 to 1/10 of raw

## Implementation Phases

### Phase 1: Create `src/session/llm-compress.ts` (~2 hours)

**Deliverables:**

- LLMCompress namespace with compress() function
- Template strings (EXTRACT, SUMMARIZE, FILTER) with negative "Do NOT" constraints
- COMPRESSION_SYSTEM constant (anti-hallucination system message)
- validateCompression() function (expansion check, empty check)
- templateFor() mapping (tool → template)
- generateText call with:
  - System message: COMPRESSION_SYSTEM (always present)
  - User message: template instruction + raw output
  - Local model from input
  - Max 1024 output tokens, temperature 0
  - AbortSignal.timeout(5000) — 5s hard timeout
  - No session history, no tools
- Post-compression validation before returning result
- Error handling + fallback to raw
- Stats collection (input_lines, output_lines, ratio, template, model, fallback, validated, duration_ms)

**Dependencies:**

- Provider (model resolution)
- Auth (authentication)
- Config (local model ref)
- Log (logging)
- AI SDK (generateText)

**Testing:**

- Unit tests for template selection, threshold, success, error, fallback

### Phase 2: Update `src/session/route-classifier.ts` (~1 hour)

**Deliverables:**

- CompressionTemplate type
- COMPRESSION_TEMPLATES constant (3 templates with negative constraints)
- COMPRESSION_SYSTEM constant (anti-hallucination system message)
- templateFor(toolName: string) function
- shouldCompress(output: string, threshold: number) function
- validateCompression(raw: string, compressed: string) function

**No changes to:**

- complexityClassify() (unchanged)
- LOCAL_ONLY_TOOLS, CLOUD_ONLY_TOOLS (unchanged)
- resolveHybridRoute() (unchanged)

**Testing:**

- Verify existing classifier tests still pass
- Unit tests for templateFor, shouldCompress

### Phase 3: Integrate into `src/session/processor.ts` (~2 hours)

**Deliverables:**

- Add to ProcessorContext:
  - localModel?: Provider.Model
  - compressionThreshold: number
- Populate in create() from config:
  - Resolve local model via `Effect.tryPromise(() => Provider.getModel(...)).pipe(Effect.option)`
  - Read `compression_threshold` from `cfg.hybrid?.compression_threshold ?? 10`
- In completeToolCall (between updatePart and settleToolCall):
  - Check shouldCompress(output.output, ctx.compressionThreshold) && ctx.localModel
  - If yes: yield\* LLMCompress.compress(...)
  - Second yield\* session.updatePart with compressed output
  - Tag metadata (snake_case): compressed, compression_template, compression_ratio, compression_fallback, compression_validated
- Logging: per-compression event with stats

**Integration point:**

- Lines 168-192 (completeToolCall function)
- Insert between session.updatePart (line 179) and settleToolCall (line 191)
- Compression is a second updatePart call — overwrites raw with compressed

**Testing:**

- Integration tests for compression hook
- Verify metadata persisted in parts
- Verify fallback on error

### Phase 4: Config + Cleanup (~1 hour)

**Config changes in `src/config/config.ts`:**

- Add to Hybrid schema:
  - compression_threshold: z.number().int().min(1).optional().default(10)
  - compression_templates: z.record(z.string(), z.string()).optional()

**Cleanup in `src/session/llm.ts`:**

- Line 253: Remove filterForRoute call for local route (dead code)
- Keep resolveHybridRoute (used by compress for model resolution)
- Export helper to resolve local model for compression

**Cleanup in `src/tool/tool-filter.ts`:**

- Lines 41-49: Remove filterForRoute for local route (dead code)
- Keep cloud route filtering

**Testing:**

- Verify config validation (threshold > 0)
- Verify existing tests still pass

### Phase 5: Tests (~2 hours)

**New test files:**

- test/session/llm-compress.test.ts (unit tests for compression)
- Extend test/session/processor.test.ts (integration tests)
- Extend test/session/prompt.test.ts (end-to-end tests)

**Existing tests:**

- Verify all route-classifier tests still pass
- Verify all processor tests still pass
- Verify all prompt tests still pass

**Coverage:**

- LLMCompress: template selection, threshold, success, error, fallback
- SessionProcessor: compression hook, metadata, context fields
- End-to-end: compressed output in CLOUD turn, disabled flag

## What Gets Removed

### From `src/session/llm.ts` (line 253)

**Current code:**

```typescript
const active = filterForRoute(all, hybrid.route)
```

**After:** Remove this line entirely. The filterForRoute call for local route is dead code because:

- Local model no longer runs reasoning steps (no tools needed)
- CLOUD model always gets all tools (no filtering)
- Route decision is for logging/metrics only, not tool filtering

### From `src/tool/tool-filter.ts` (lines 41-49)

**Current code:**

```typescript
export function filterForRoute(tools: Tool.Info[], route: Route): Tool.Info[]
export function filterForRoute<T extends ModelTool>(tools: Record<string, T>, route: Route): Record<string, T>
export function filterForRoute<T extends ModelTool>(tools: Tool.Info[] | Record<string, T>, route: Route) {
  if (route === "cloud") return tools
  if (Array.isArray(tools))
    return tools.filter((tool) => LOCAL_ONLY_TOOLS.has(tool.id) || tool.id === "bash" || tool.id === "invalid")
  return Object.fromEntries(
    Object.entries(tools).filter(([id]) => LOCAL_ONLY_TOOLS.has(id) || id === "bash" || id === "invalid"),
  )
}
```

**After:** Remove the local route filtering logic. Keep the function signature but simplify:

```typescript
export function filterForRoute(tools: Tool.Info[], route: Route): Tool.Info[]
export function filterForRoute<T extends ModelTool>(tools: Record<string, T>, route: Route): Record<string, T>
export function filterForRoute<T extends ModelTool>(tools: Tool.Info[] | Record<string, T>, route: Route) {
  if (route === "cloud") return tools
  // Local route no longer filters tools (local model doesn't get tools)
  return Array.isArray(tools) ? [] : {}
}
```

**Rationale:** The local model never receives tools anymore, so filtering is unnecessary.

## Logging Specification

### Structured Log Format (per compression event)

```json
{
  "service": "llm.compress",
  "level": "info",
  "message": "compression",
  "compression": true,
  "tool": "grep",
  "input_lines": 420,
  "output_lines": 32,
  "ratio": 0.076,
  "template": "extract",
  "model": "claude-haiku-4-5",
  "fallback": false,
  "validated": true,
  "duration_ms": 450
}
```

### Validation Failure Log

```json
{
  "service": "llm.compress",
  "level": "warn",
  "message": "compression_validation_failed",
  "tool": "read",
  "reason": "expansion",
  "input_lines": 100,
  "output_lines": 150,
  "fallback": true,
  "validated": false
}
```

### Error Log (on compression failure)

```json
{
  "service": "llm.compress",
  "level": "warn",
  "message": "compression_error",
  "tool": "read",
  "error": "Model unavailable",
  "fallback": true,
  "duration_ms": 2000
}
```

### No Raw Outputs Logged

- Raw tool outputs are NOT logged (privacy, size)
- Compressed outputs are NOT logged (privacy, size)
- Only metadata (tool, lines, ratio, template, model, fallback) is logged

## Error Handling & Fallback Behavior

**Compression Error Scenarios:**

1. **Local model unavailable** (not configured)
   - Skip compression
   - Return raw output
   - No error logged (expected behavior)

2. **Local model connection error** (network, timeout)
   - Catch exception
   - Log warning: "compression_error", error message
   - Return raw output
   - Tag metadata: fallback=true

3. **generateText call error** (model error, invalid response)
   - Catch exception
   - Log warning: "compression_error", error message
   - Return raw output
   - Tag metadata: fallback=true

4. **Output parsing error** (unexpected response format)
   - Catch exception
   - Log warning: "compression_error"
   - Return raw output
   - Tag metadata: fallback=true

5. **Feature disabled** (hybrid.enabled=false or flag off)
   - Skip compression entirely
   - Return raw output
   - No logging

6. **Post-compression validation failure** (expansion or empty output)
   - Log warning: "compression_validation_failed", reason ("expansion" or "empty_output")
   - Return raw output
   - Tag metadata: fallback=true, validated=false

7. **Binary/non-text output** (null bytes, non-UTF8)
   - `shouldCompress()` calls `listLines()` which splits on `\n` — binary data produces 1 "line" or garbage lines
   - If line count ≤ threshold → skipped (correct: don't compress binary)
   - If line count > threshold → `generateText()` may fail or return garbage → caught by catch block → fallback to raw
   - No special handling needed — existing error path covers this

8. **Compression timeout** (local model hangs)
   - `AbortSignal.timeout(5000)` on `generateText()` call
   - Timeout triggers AbortError → caught by catch block → fallback to raw
   - Log warning: "compression_error", error: "AbortError: signal timed out"

**Fallback Result:**

```typescript
{
  compressed: rawOutput,    // unchanged
  stats: {
    input_lines: listLines(rawOutput),
    output_lines: listLines(rawOutput),
    ratio: 1.0,
    template: templateFor(tool),
    model: model.id,
    fallback: true,          // indicates error occurred
    validated: false          // validation skipped on fallback
  }
}
```

## Upstream Rebase Safety

**All new logic in `src/session/llm-compress.ts`:**

- No conflicts with existing files
- Can be merged independently

**Surgical edits only:**

- `processor.ts`: Add ~30 lines in completeToolCall (between updatePart at line 179 and settleToolCall at line 191)
- `route-classifier.ts`: Add ~30 lines (new functions, no changes to existing)
- `config.ts`: Add ~5 lines to Hybrid schema
- `llm.ts`: Remove 1 line (line 253), no additions
- `tool-filter.ts`: Remove 5 lines (local route filtering)

**No broad refactors:**

- Message schema unchanged
- Session storage unchanged
- Route classifier logic unchanged
- Outer loop unchanged
