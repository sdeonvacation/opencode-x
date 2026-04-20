# Plan: Hybrid Routing (v3 — Complexity Classifier)

## Overview

Cloud thinks, local executes. Routing is now driven by a **complexity classifier** applied to tool results: after every tool execution, the classifier evaluates the result's complexity and routes the _interpretation_ step accordingly. First step (reasoning + tool selection) is always CLOUD. Tool execution itself is model-agnostic (runs locally regardless). Subsequent interpretation steps route based on output complexity.

## Core Execution Flow

```
User message
  ↓
Step 1: CLOUD (reasoning + tool selection)
  → model picks tools, generates tool calls
  ↓
Tool execution (runs on user machine — no LLM)
  ↓
Step 2: Evaluate tool result → Complexity Classifier
  ↓
IF simple   → LOCAL  (deterministic, small output, no inference)
IF complex  → CLOUD  (logs, multi-file, ambiguity, inference)
IF uncertain → CLOUD (fail-safe)
  ↓
Repeat
```

## Complexity Classifier — Concrete Signals

### Route to LOCAL if ALL of:

- Output < 200 lines
- Tool is deterministic read-only: `grep`, `glob`, `read`, `list`
  **OR** tool is `bash` and command is simple (see `bashKind` — `ls`, `echo`, `git status`, test runners, etc.)
- No cross-file reasoning required (single file or flat list)
- No inference needed (structured data: file list, line matches, JSON)
- No complexity signals in output (no error patterns, no stack traces)

### Route to CLOUD if ANY of:

- Output ≥ 200 lines
- Tool is `bash` and command is complex (pipes `|`, redirects `>`, `&&`, `$(`, multi-step)
- Multi-file reasoning required (e.g. diff spanning many files)
- Output requires interpretation or inference (logs, stack traces, prose)
- Tool is mutation: `edit`, `write`, `multiedit`, `apply_patch`, `task`, `todowrite`

### Immediate CLOUD triggers (keyword/pattern in tool input or output):

- Intent keywords: `"why"`, `"how"`, `"root cause"`, `"explain"`, `"debug"`
- Domain keywords: `"auth"`, `"concurrency"`, `"distributed"`, `"race"`, `"deadlock"`, `"security"`
- Output patterns: stack traces, error messages, `Error:`, `Exception:`, `FAILED`, `panic:`
- Anything involving inference about system behavior

## Tech Stack

- Language: TypeScript 5.8
- Framework: Effect-ts 4.0
- AI SDK: Vercel AI SDK 6.x
- Local LLM: OpenAI-compatible (Ollama, llama.cpp)
- Schema: Zod
- Config: `.opencode/opencode.jsonc`

## Sample Config

```jsonc
{
  "hybrid": {
    "enabled": true,
    "local_model": {
      "providerID": "openai-compatible",
      "modelID": "llama3.2:8b",
    },
    "log_routing": true,
  },
}
```

## Phases

### Phase 1: Feature Flag & Config (DONE ✅)

### Phase 2: Complexity Classifier (REWRITE)

Replace `classify()` with `complexityClassify()`:

- Input: `{ enabled, toolName, toolOutput, toolInput, lineCount }`
- Output: `{ route, reason, complexity }`
- Logic:
  1. `enabled === false` → `cloud`, reason=`disabled`
  2. No previous tool (first turn) → `cloud`, reason=`reasoning`
  3. Tool ∈ CLOUD_ONLY → `cloud`, reason=`cloud_only`
  4. IMMEDIATE_CLOUD triggers in tool input or output → `cloud`, reason=`trigger(<keyword>)`
  5. Tool ∈ LOCAL_ONLY AND lineCount < 200 AND no complexity signals → `local`, reason=`simple`
  6. Tool = bash AND bashKind = simple AND lineCount < 200 AND no complexity signals → `local`, reason=`bash_simple`
  7. Everything else → `cloud`, reason=`complex` (fail-safe)

### Phase 3: Route Logger (minor update)

- Add `complexity` and `lineCount` to log entry

### Phase 4: Session Loop Integration (update)

- Pass tool result output + line count into `complexityClassify()`
- Extract from `tool-result` content in message history

### Phase 5: Tests (rewrite)

- Unit: `complexityClassify()` for each signal type
- Integration: end-to-end routing trace

## Testing Strategy

Done when:

- Flag OFF = zero behavior change
- First turn always → CLOUD
- After `grep` with small output → LOCAL
- After `grep` with 200+ lines → CLOUD
- After `bash ls -la` with small output → LOCAL (`bash_simple`)
- After `bash 'cat file | grep foo'` → CLOUD (`bash_complex`, pipes)
- After `bash` with stack trace output → CLOUD (trigger)
- After `edit` → CLOUD
- `"why"` keyword in prior user message → CLOUD
- `"Error:"` in tool output → CLOUD

## Risks

- **Output size heuristic**: 200-line threshold may misclassify — conservative default (uncertain = cloud) mitigates
- **Keyword false positives**: e.g. variable named `auth` in grep output — use exact-match on standalone words not substrings
- **Upstream rebase safety**: all new logic in route-classifier.ts; llm.ts gets minimal additional wiring only
