# HLD: Hybrid Routing (v3 — Complexity Classifier)

## Tech Stack

| Category  | Technology                 | Purpose                                              |
| --------- | -------------------------- | ---------------------------------------------------- |
| Language  | TypeScript 5.8             | Existing codebase language                           |
| Runtime   | Bun 1.3.11                 | Existing runtime                                     |
| Framework | Effect-ts 4.0-beta         | Service/layer patterns                               |
| AI SDK    | Vercel AI SDK 6.x          | `streamText()`, `LanguageModelV3`, tool dispatch     |
| Schema    | Zod                        | Config schema extension for `hybrid` section         |
| Local LLM | OpenAI-compatible (Ollama) | Local model via existing `@ai-sdk/openai-compatible` |
| Pub/Sub   | Bus (`BusEvent.define`)    | Routing decision events for observability            |
| Test      | bun:test                   | Unit + integration tests                             |

## Components

| Component               | Responsibility                                                    | Dependencies                           |
| ----------------------- | ----------------------------------------------------------------- | -------------------------------------- |
| `route-classifier`      | Complexity classifier: tool result → route decision               | None (pure, stateless)                 |
| `route-logger`          | Structured logging of routing decisions; Bus event                | `Bus`, `BusEvent`, `Log`, `Config`     |
| `flag.ts` (done)        | `OPENCODE_HYBRID_ROUTING` env flag                                | None                                   |
| `config.ts` (done)      | `hybrid` config section schema                                    | Zod                                    |
| `llm.ts` (update)       | Extract tool result from messages; pass to classifier; swap model | `route-classifier`, `Provider.Service` |
| `tool-filter.ts` (done) | Restrict tools to LOCAL_ONLY when routing to local                | `route-classifier`                     |

## Architecture

### Execution Flow

```
User message
     │
     ▼
┌─────────────────────────┐
│  Step 1: CLOUD          │  always — reasoning + tool selection
│  all tools available    │
└─────────────────────────┘
     │ generates tool call(s)
     ▼
┌─────────────────────────┐
│  Tool executes           │  model-agnostic, runs on user machine
│  (grep/bash/read/edit…) │
└─────────────────────────┘
     │ tool-result appended to messages
     ▼
┌──────────────────────────────────────────────────────────────┐
│  complexityClassify(toolName, output, input)                 │
│                                                              │
│  IMMEDIATE CLOUD triggers?        ──────────────────────► CLOUD
│  Tool ∈ CLOUD_ONLY?               ──────────────────────► CLOUD
│  Output ≥ 200 lines?              ──────────────────────► CLOUD
│  Complexity signals in output?    ──────────────────────► CLOUD
│  Tool ∈ LOCAL_ONLY                ──────────────────────► LOCAL
│    AND output < 200 lines           reason="simple"
│  Tool = bash AND bashKind=simple  ──────────────────────► LOCAL
│    AND output < 200 lines           reason="bash_simple"
│  Fail-safe (unknown/complex)      ──────────────────────► CLOUD
└──────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────┐     ┌─────────────────────────┐
│  LOCAL model            │     │  CLOUD model            │
│  LOCAL_ONLY tools only  │     │  all tools available    │
└─────────────────────────┘     └─────────────────────────┘
     │                                    │
     └──────────────┬─────────────────────┘
                    ▼
               repeat loop
```

### Complexity Signals

```
IMMEDIATE CLOUD triggers (checked first, fail-fast):
  Intent keywords (in user messages):
    "why", "how", "root cause", "explain", "debug"
  Domain keywords (in tool input or output):
    "auth", "concurrency", "distributed", "race", "deadlock", "security"
  Output patterns (in tool result):
    /\bError[:\s]/, /\bException[:\s]/, /\bFAILED\b/, /\bpanic[:\s]/,
    /\bstack trace\b/i, /\bat .+ \(.+:\d+:\d+\)/  (stack frame pattern)

LOCAL signals (ALL must be true):
  1. Tool ∈ LOCAL_ONLY_TOOLS
     OR (tool = "bash" AND bashKind(command) = "simple")
       Simple bash: ls, echo, env, cat, pwd, tree, find, grep,
                    git status/log/diff/branch/show,
                    npm/bun/yarn/pnpm test, npm/bun run, make,
                    cargo test, go test, pytest
       Complex bash: anything with |, >, &&, ||, $(...), \n, ;
  2. lineCount(output) < 200
  3. No IMMEDIATE_CLOUD triggers in output
  4. No IMMEDIATE_CLOUD domain keywords in tool input

CLOUD (default/fail-safe):
  Any condition not matching LOCAL signals above
```

## Interfaces

### route-classifier (`src/session/route-classifier.ts`)

#### `complexityClassify(input: ClassifyInput): RouteDecision`

**Input**:

```typescript
export type ClassifyInput = {
  enabled: boolean
  toolName?: string // name of tool that just executed (undefined = first turn)
  toolOutput?: string // string content of tool-result
  toolInput?: Record<string, unknown> // input args to the tool call
  userMessages?: string[] // recent user message text (for intent keywords)
}
```

**Output** (extended `RouteDecision`):

```typescript
export type RouteDecision = {
  route: Route // "cloud" | "local"
  reason: string // human-readable reason code
  tool?: string
  complexity?: "simple" | "complex" | "unknown"
  lineCount?: number
  trigger?: string // which signal fired (for logging)
}
```

**Classification logic**:

```
1. !enabled                               → cloud, reason="disabled"
2. !toolName                              → cloud, reason="reasoning"  (first turn)
3. toolName ∈ CLOUD_ONLY_TOOLS           → cloud, reason="cloud_only"
4. immediateCloudTrigger(output, input, userMessages)
                                          → cloud, reason="trigger(<keyword>)"
5. toolName ∈ LOCAL_ONLY_TOOLS
   AND lineCount(output) < 200
   AND !complexitySignals(output)         → local, reason="simple"
6. toolName = "bash"
   AND bashKind(toolInput.command) = "simple"
   AND lineCount(output) < 200
   AND !complexitySignals(output)         → local, reason="bash_simple"
7. default                               → cloud, reason="complex"  (fail-safe)
```

#### `immediateCloudTriggers` (internal)

```typescript
const INTENT_KEYWORDS = ["why", "how", "root cause", "explain", "debug"]
const DOMAIN_KEYWORDS = ["auth", "concurrency", "distributed", "race", "deadlock", "security"]
const ERROR_PATTERNS = [
  /\bError[:\s]/,
  /\bException[:\s]/,
  /\bFAILED\b/,
  /\bpanic[:\s]/i,
  /\bstack trace\b/i,
  /\bat .+\(.+:\d+:\d+\)/, // stack frame: "at foo (file.ts:10:5)"
]

// Match whole words only — prevents "authority" triggering "auth"
function hasKeyword(text: string, keywords: string[]): string | undefined {
  const lower = text.toLowerCase()
  return keywords.find((kw) => {
    const re = new RegExp(`\\b${kw.replace(/\s+/g, "\\s+")}\\b`)
    return re.test(lower)
  })
}
```

#### `resolveHybridRoute` (updated)

Same function name and signature. Updated to:

1. Extract tool result from `messages` (last `tool-result` in current step)
2. Extract tool input from matching `tool-call`
3. Extract recent user messages for intent keyword check
4. Call `complexityClassify()` instead of old `classify()`

### route-logger (`src/session/route-logger.ts`) — minor update

Add `complexity` and `trigger` fields to `RouteDecided` event:

```typescript
export const RouteDecided = BusEvent.define(
  "hybrid.route.decided",
  z.object({
    sessionID: z.string(),
    step: z.number(),
    route: z.enum(["cloud", "local"]),
    reason: z.string(),
    tool: z.string().optional(),
    modelID: z.string(),
    providerID: z.string(),
    complexity: z.enum(["simple", "complex", "unknown"]).optional(),
    lineCount: z.number().optional(),
    trigger: z.string().optional(),
  }),
)
```

### tool-filter.ts — unchanged

`filterForRoute` allowlist already correct.

### llm.ts — minimal update

Current hybrid block (lines ~139-155) passes `messages` to `resolveHybridRoute`. No change to call signature needed — `resolveHybridRoute` already receives full messages and extracts what it needs internally.

## Data Flow

### Flow 1: First Turn → CLOUD

```
messages has no tool-result
→ complexityClassify({ enabled: true, toolName: undefined })
→ reason="reasoning", route="cloud"
→ streamText with cloud model, all tools
```

### Flow 2: After grep with small output → LOCAL

```
last tool-result: { toolName: "grep", output: "src/foo.ts:10:  const x = 1\n..." (15 lines) }
→ complexityClassify({ toolName: "grep", toolOutput: "...", lineCount: 15 })
→ LOCAL_ONLY_TOOLS.has("grep") ✓
→ lineCount < 200 ✓
→ no triggers ✓
→ reason="simple", route="local"
→ streamText with local model, LOCAL_ONLY tools
```

### Flow 2b: After bash `ls -la` with small output → LOCAL

```
last tool-result: { toolName: "bash", input: { command: "ls -la" }, output: "total 48\n-rw-r--r-- 1 ..." (12 lines) }
→ complexityClassify({ toolName: "bash", toolInput: { command: "ls -la" }, lineCount: 12 })
→ bashKind("ls -la") = "simple" ✓
→ lineCount < 200 ✓
→ no triggers ✓
→ reason="bash_simple", route="local"
→ streamText with local model, LOCAL_ONLY tools
```

### Flow 3: After grep with "Error:" in output → CLOUD

```
last tool-result: { toolName: "grep", output: "Error: cannot open file foo" }
→ complexityClassify(...)
→ immediateCloudTrigger: /\bError[:\s]/.test(output) ✓
→ reason="trigger(Error:)", route="cloud"
```

### Flow 4: After bash with stack trace → CLOUD

```
last tool-result: { toolName: "bash", output: "TypeError: ...\n  at foo (bar.ts:10:5)..." }
→ complexityClassify({ toolName: "bash", toolOutput: "...", lineCount: 12 })
→ stack frame pattern matched ✓
→ reason="trigger(stack_frame)", route="cloud"
```

### Flow 5: User asks "why" → CLOUD

```
userMessages: ["why is this test failing?"]
→ complexityClassify({ ..., userMessages: ["why is this test failing?"] })
→ INTENT_KEYWORDS: "why" matched ✓
→ reason="trigger(why)", route="cloud"
```

### Flow 6: Local model unavailable → Fallback

No change to existing fallback chain in `resolveHybridRoute`.

## Test Plan

### Unit Tests — `test/session/route-classifier.test.ts`

| Scenario                       | Input                                                           | Expected Route                     |
| ------------------------------ | --------------------------------------------------------------- | ---------------------------------- |
| Disabled                       | `enabled: false`                                                | cloud, reason=disabled             |
| First turn                     | `toolName: undefined`                                           | cloud, reason=reasoning            |
| grep, 10 lines, no triggers    | `{toolName:"grep", toolOutput:"...", lineCount:10}`             | local, reason=simple               |
| grep, 250 lines                | `{toolName:"grep", lineCount:250}`                              | cloud, reason=complex              |
| read, 5 lines                  | `{toolName:"read", lineCount:5}`                                | local, reason=simple               |
| edit                           | `{toolName:"edit"}`                                             | cloud, reason=cloud_only           |
| task                           | `{toolName:"task"}`                                             | cloud, reason=cloud_only           |
| bash `ls -la`, 10 lines        | `{toolName:"bash", toolInput:{command:"ls -la"}, lineCount:10}` | local, reason=bash_simple          |
| bash `sed -i ...`              | `{toolName:"bash", toolInput:{command:"sed -i 's/a/b/'"}}`      | cloud, reason=complex              |
| grep output with "Error:"      | `{toolName:"grep", toolOutput:"Error: foo"}`                    | cloud, reason=trigger(Error:)      |
| bash output with stack trace   | `{toolName:"bash", toolOutput:"  at foo (bar.ts:10:5)"}`        | cloud, reason=trigger(stack_frame) |
| bash output with FAILED        | `{toolName:"bash", toolOutput:"1 test FAILED"}`                 | cloud, reason=trigger(FAILED)      |
| user message "why"             | `{userMessages:["why is X broken?"]}`                           | cloud, reason=trigger(why)         |
| user message "root cause"      | `{userMessages:["find root cause"]}`                            | cloud, reason=trigger(root cause)  |
| domain keyword "auth" in input | `{toolInput:{path:"src/auth.ts"}}`                              | cloud, reason=trigger(auth)        |
| unknown tool, small output     | `{toolName:"mcp_foo", lineCount:5}`                             | cloud, reason=complex (fail-safe)  |
| `listLines()` helper           | "a\nb\nc"                                                       | 3                                  |
| `bashKind` unchanged           | "ls -la"                                                        | simple                             |
| `bashKind` unchanged           | "sed -i 's/a/b/'"                                               | complex                            |

### Integration Tests — `test/session/llm.test.ts` (hybrid section)

| Scenario                                             | Verify                                              |
| ---------------------------------------------------- | --------------------------------------------------- |
| First turn → CLOUD                                   | stream uses cloud model, all tools                  |
| After grep, small output → LOCAL                     | stream uses local model, LOCAL_ONLY tools           |
| After grep, large output → CLOUD                     | stream uses cloud model                             |
| After grep, "Error:" output → CLOUD                  | trigger fires                                       |
| After bash `ls -la`, small output → LOCAL            | stream uses local model, reason=bash_simple         |
| After bash with pipes `cat file \| grep foo` → CLOUD | bash_complex, stream uses cloud model               |
| Local unavailable → fallback                         | cloud model used, `reason=local_unavailable` logged |
| Flag OFF → no routing change                         | session model used, no RouteDecided event           |

## Decisions

| Decision                 | Choice                                 | Reason                                                                |
| ------------------------ | -------------------------------------- | --------------------------------------------------------------------- |
| 200-line threshold       | Hard-coded constant `LINE_LIMIT = 200` | Adjustable single point; conservative default                         |
| Keyword whole-word match | `\b` word boundary regex               | Prevents "authority" matching "auth"                                  |
| Intent keyword scope     | Last N user messages only (N=3)        | Avoids stale context from old turns                                   |
| Fail-safe → CLOUD        | Unknown/uncertain always routes cloud  | Correctness > cost savings                                            |
| No output truncation     | Pass full output string to classifier  | Classifier only scans, doesn't store                                  |
| `local()` guard removed  | Removed — was semantically wrong       | Was checking session tools not model health; health check is separate |

## Upstream-Rebase Safety

| File                  | Change                                                            | Risk                              |
| --------------------- | ----------------------------------------------------------------- | --------------------------------- |
| `route-classifier.ts` | Rewrite `classify()` → `complexityClassify()`; keep all helpers   | 🟡 Medium — new file logic, clean |
| `route-logger.ts`     | Add 2 optional fields to Zod schema                               | 🟢 Low                            |
| `llm.ts`              | No change to call site — `resolveHybridRoute` signature unchanged | 🟢 Low                            |
| `tool-filter.ts`      | No change                                                         | 🟢 Low                            |
| `config.ts`           | No change                                                         | 🟢 Low                            |
| `flag.ts`             | No change                                                         | 🟢 Low                            |
