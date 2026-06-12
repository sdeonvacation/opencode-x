# PLAN: Hybrid Routing v4 — Local as Output Compressor

## Summary

Replace "local model as reasoning agent" with "local model as tool output compressor". Compression is **preprocessing** — triggered by output size, not route. Local model receives only tool output + narrow instruction template. Never sees session history.

## Compression Templates (3 canonical)

| Template      | Goal                                                     | Used by                              |
| ------------- | -------------------------------------------------------- | ------------------------------------ |
| **EXTRACT**   | Key lines/items, bullets, file/line refs, no speculation | grep, glob, bash (test/build output) |
| **SUMMARIZE** | 3–6 bullets capturing key facts, keep identifiers        | read (prose/code), large bash output |
| **FILTER**    | Return only matching items, drop noise                   | logs, error output, diffs            |

Tool → template mapping:

```
grep       → EXTRACT
glob       → EXTRACT
read       → SUMMARIZE (or EXTRACT if structured like JSON)
bash       → EXTRACT (+ "top errors" if error patterns detected)
list       → EXTRACT
```

Override hook: `compressionTemplate` field in hybrid config (optional, per-tool override map).

## Compression Trigger

**Independent of route decision.** Compression is preprocessing:

```
if output_lines > threshold (default 10, configurable):
    compress(local LLM) → replace output
else:
    pass raw
```

Both compressed and raw results go to CLOUD for reasoning. Route classifier stays unchanged — it still controls whether CLOUD or LOCAL model runs the next reasoning step. But since LOCAL model no longer runs reasoning steps at all, the classifier effectively becomes: "should we compress this output?"

## What Changes

### New File: `src/session/llm-compress.ts`

Single namespace, ~80 lines:

```
LLMCompress.compress(input) → { compressed, stats }
```

- `generateText` call (not streaming)
- Input: system message (COMPRESSION_SYSTEM anti-hallucination constraint) + template instruction + raw tool output
- No session history, no tools
- Max 1024 output tokens, temperature 0, 5s timeout
- On error: return raw output (fallback)
- Returns stats: `{ input_tokens, output_tokens, ratio, template, fallback, duration_ms }`

### Modified: `src/session/route-classifier.ts` (~30 lines)

Add:

- `CompressionTemplate` type + 3 template strings (EXTRACT, SUMMARIZE, FILTER)
- `templateFor(toolName: string): CompressionTemplate` — tool→template mapping
- `shouldCompress(output: string, threshold: number): boolean` — line count check
- Remove: nothing. Classifier logic untouched.

### Modified: `src/session/processor.ts` (~40 lines)

In `completeToolCall` (line 169–192):

- After storing raw output, check `shouldCompress`
- If yes: `await LLMCompress.compress(...)` → update part with compressed output
- Tag metadata: `{ compressed: true, template, ratio }`

Add context fields to `ProcessorContext`:

- `localModel?: Provider.Model`
- `compressionThreshold: number`

Populate in `create()` from config.

### Modified: `src/config/config.ts` (~5 lines)

Add to `Hybrid` schema:

```
compression_threshold?: number  // default 10
compression_templates?: Record<string, string>  // optional per-tool override
```

### Modified: `src/session/llm.ts` (~15 lines)

- Remove `filterForRoute` call for route === "local" (no more local agent turns)
- Keep `resolveHybridRoute` for model resolution (used by compress)
- Export helper to resolve local model for compression

### Modified: `src/tool/tool-filter.ts` (~5 lines)

Remove `filterForRoute` for local (dead code now).

## What Gets Removed

The current "local agent turn" behavior:

- `filterForRoute` for `route === "local"` filtering tools → no longer needed (local model never gets tools)
- `streamText` with local model as full agent → replaced by `generateText` for compression only
- LOCAL model receiving full message history → gone entirely

## Attachment/Diff Handling

Preserve in compressed output:

- File paths, line numbers, test names, error codes, symbol names

Drop:

- Full unchanged context, bulk payloads, full file contents

For diffs:

```
Changed files:
- src/A.java (method foo, lines 23–41)
- src/B.java (imports updated)

Key changes:
- condition inverted in foo()
- added null-check in bar()
```

## Logging

Structured, per compression event:

```json
{
  "compression": true,
  "tool": "grep",
  "input_lines": 420,
  "output_lines": 32,
  "ratio": 0.076,
  "template": "extract",
  "model": "claude-haiku-4-5",
  "fallback": false
}
```

No raw outputs logged.

## Sequencing

```
tool executes
↓
if shouldCompress(output, threshold):
    compressed = await LLMCompress.compress(...)
    update tool result part with compressed output
↓
loop continues → CLOUD gets compressed result
```

Async but awaited — loop blocks until compression completes.

## Files Summary

| File                              | Action                                                    | Lines |
| --------------------------------- | --------------------------------------------------------- | ----- |
| `src/session/llm-compress.ts`     | **NEW**                                                   | ~80   |
| `src/session/route-classifier.ts` | Add templates + shouldCompress                            | ~30   |
| `src/session/processor.ts`        | Hook compression into completeToolCall                    | ~40   |
| `src/config/config.ts`            | Add compression_threshold                                 | ~5    |
| `src/session/llm.ts`              | Remove local agent turn path, export local model resolver | ~15   |
| `src/tool/tool-filter.ts`         | Remove `filterForRoute` for local (dead code)             | ~5    |

## Tests

| Test                                | What                                                                  |
| ----------------------------------- | --------------------------------------------------------------------- |
| `test/session/llm-compress.test.ts` | Template selection, threshold check, fallback on error, output format |
| `test/session/processor.test.ts`    | Compression integrated into tool-result flow                          |
| Existing classifier tests           | Must still pass (classifier unchanged)                                |

## Risks

| Risk                            | Mitigation                                                           |
| ------------------------------- | -------------------------------------------------------------------- |
| Compression loses critical info | Templates preserve identifiers; fallback to raw on error             |
| Latency per tool call           | Only for large outputs; savings on CLOUD tokens offset cost          |
| Local model unavailable         | Skip compression, pass raw (existing behavior)                       |
| Template mismatch               | 3 general templates cover 95% of cases; override hook for edge cases |

## Migration

- Feature-gated behind `hybrid.enabled` + `OPENCODE_HYBRID_ROUTING` flag (existing)
- No local model configured → compression skipped entirely (zero behavior change)
- Existing sessions unaffected — compression only applies to new tool results

## Tech Stack

- Language: TypeScript 5.8
- Framework: Effect-ts 4.0
- AI SDK: Vercel AI SDK 6.x
- Local LLM: OpenAI-compatible (Ollama, llama.cpp)
- Config: `.opencode/opencode.jsonc`

## Testing Strategy

Done when:

- Compression disabled (flag off) = zero behavior change
- Large grep output (>10 lines) → compressed via EXTRACT template
- Small grep output (<10 lines) → passed raw
- Compression error → fallback to raw, log warning
- Compressed output included in next CLOUD turn
- Metadata tagged with `compressed: true, template, ratio`
- All existing tests still pass

## Phases

### Phase 1: Create `llm-compress.ts` (2 hours)

- Implement `LLMCompress.compress()` function
- Template strings + templateFor() mapping
- Error handling + fallback logic
- Stats collection

### Phase 2: Update `route-classifier.ts` (1 hour)

- Add `CompressionTemplate` type
- Add `shouldCompress()` helper
- Add `templateFor()` mapping

### Phase 3: Integrate into `processor.ts` (2 hours)

- Add context fields
- Hook compression into `completeToolCall`
- Update part with compressed output
- Logging

### Phase 4: Config + cleanup (1 hour)

- Add `compression_threshold` to config
- Remove local agent turn code from `llm.ts`
- Remove dead code from `tool-filter.ts`

### Phase 5: Tests (2 hours)

- Unit tests for compression
- Integration tests for processor hook
- Verify existing tests still pass

## Risks

- **Output size heuristic**: 10-line threshold may misclassify — conservative default (uncertain = pass raw) mitigates
- **Template false positives**: Generic templates may not fit all tools — override hook allows customization
- **Upstream rebase safety**: All new logic in llm-compress.ts; processor.ts gets minimal surgical hook only
