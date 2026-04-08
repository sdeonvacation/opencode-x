# Graph Report - packages/opencode/src  (2026-04-08)

## Corpus Check
- Large corpus: 437 files · ~276,572 words. Semantic extraction will be expensive (many Claude tokens). Consider running on a subfolder, or use --no-semantic to run AST-only.

## Summary
- 1701 nodes · 3442 edges · 41 communities detected
- Extraction: 85% EXTRACTED · 15% INFERRED · 0% AMBIGUOUS · INFERRED: 517 edges (avg confidence: 0.51)
- Token cost: 0 input · 0 output

## God Nodes (most connected - your core abstractions)
1. `Agent` - 23 edges
2. `McpOAuthProvider` - 14 edges
3. `inline()` - 12 edges
4. `ACPSessionManager` - 11 edges
5. `argPath()` - 9 edges
6. `Read Tool` - 9 edges
7. `OpenCode Agent Identity` - 9 edges
8. `body()` - 8 edges
9. `OpenAICompatibleChatLanguageModel` - 8 edges
10. `parsePatch()` - 8 edges

## Surprising Connections (you probably didn't know these)
- `Conversation Compaction Prompt` --semantically_similar_to--> `Conversation Summary Prompt`  [INFERRED] [semantically similar]
  packages/opencode/src/agent/prompt/compaction.txt → packages/opencode/src/agent/prompt/summary.txt
- `Conversation Compaction Prompt` --semantically_similar_to--> `Event Sourcing System`  [INFERRED] [semantically similar]
  packages/opencode/src/agent/prompt/compaction.txt → packages/opencode/src/sync/README.md
- `Thread Title Generator Prompt` --semantically_similar_to--> `Conversation Summary Prompt`  [INFERRED] [semantically similar]
  packages/opencode/src/agent/prompt/title.txt → packages/opencode/src/agent/prompt/summary.txt
- `Apply Patch Tool` --semantically_similar_to--> `MultiEdit Tool`  [INFERRED] [semantically similar]
  packages/opencode/src/tool/apply_patch.txt → packages/opencode/src/tool/multiedit.txt
- `Glob Tool` --semantically_similar_to--> `LS Tool`  [INFERRED] [semantically similar]
  packages/opencode/src/tool/glob.txt → packages/opencode/src/tool/ls.txt

## Hyperedges (group relationships)
- **Agent Prompt Suite for Conversation Lifecycle** — agent_compaction_prompt, agent_title_prompt, agent_summary_prompt [INFERRED 0.85]
- **ACP Core Architecture Components** — acp_agent, acp_client, acp_session, acp_server [EXTRACTED 1.00]
- **File Search and Navigation Tool Trio** — tool_glob, tool_grep, tool_ls [INFERRED 0.82]
- **Plan-to-Build Mode Transition Flow** — concept_planmode, concept_buildmode, prompt_plan, prompt_buildswitch, tool_planenter [INFERRED 0.88]
- **Safe File Modification Chain (Read -> Edit/Write)** — tool_read, tool_edit, tool_write, concept_readbeforeedit [EXTRACTED 0.95]
- **Web Research Tool Suite** — tool_websearch, tool_webfetch, tool_codesearch, concept_internetresearch [INFERRED 0.82]

## Communities

### Community 0 - "Plugin System & Auth"
Cohesion: 0.01
Nodes (66): add(), Api, applyHunksToFiles(), applyPatch(), applyPlugin(), applyReplacements(), AuthError, BusyError (+58 more)

### Community 1 - "TUI Plugin API"
Cohesion: 0.02
Nodes (53): appApi(), createTuiApi(), stateApi(), expandDirectory(), hide(), move(), moveTo(), onInput() (+45 more)

### Community 2 - "Session Storage & Events"
Cohesion: 0.02
Nodes (63): Conversation Compaction Prompt, Conversation Summary Prompt, Thread Title Generator Prompt, effect(), transaction(), use(), errorData(), errorFormat() (+55 more)

### Community 3 - "CLI Commands & Tools"
Cohesion: 0.03
Nodes (38): abortAfter(), abortAfterAny(), scan(), scanSync(), toGlobOptions(), get(), use(), useEffect() (+30 more)

### Community 4 - "Copilot SDK Adapters"
Cohesion: 0.03
Nodes (12): convertToOpenAICompatibleChatMessages(), getOpenAIMetadata(), GitHub Copilot SDK README, createOpenAICompatibleChatChunkSchema(), OpenAICompatibleChatLanguageModel, getResponsesModelConfig(), isResponseOutputItemAddedChunk(), isResponseOutputItemAddedReasoningChunk() (+4 more)

### Community 5 - "Effect Context & Tokens"
Cohesion: 0.04
Nodes (41): NotFound, activatePlugin(), activatePluginById(), activatePluginEntry(), addExternalPluginEntries(), addPlugin(), addPluginBySpec(), addPluginEntry() (+33 more)

### Community 6 - "LSP & Error Handling"
Cohesion: 0.04
Nodes (28): get(), truthy(), publish(), unpublish(), entryCore(), fileTarget(), fingerprint(), list() (+20 more)

### Community 7 - "File Utilities & Clipboard"
Cohesion: 0.04
Nodes (37): copy(), fromClipboard(), isValidImageBuffer(), writeOsc52(), exists(), findUp(), isEnoent(), normalizePath() (+29 more)

### Community 8 - "Permission Evaluation"
Cohesion: 0.04
Nodes (23): create(), modelKey(), samePrefix(), ascending(), create(), descending(), generateID(), randomBase62() (+15 more)

### Community 9 - "Plugin Installation"
Cohesion: 0.06
Nodes (41): exportOptions(), exportTarget(), exportValue(), hasMainTarget(), packageTargets(), patch(), patchDir(), patchName() (+33 more)

### Community 10 - "Account & Workspace UI"
Cohesion: 0.05
Nodes (25): activeSuffix(), dim(), formatAccountLabel(), formatOrgChoiceLabel(), formatOrgLine(), deduplicatePluginOrigins(), installDependencies(), isWritable() (+17 more)

### Community 11 - "Session Compaction & Loops"
Cohesion: 0.05
Nodes (21): Service, create(), isTerminal(), Service, pick(), questions(), reject(), rejectQuestionRequest() (+13 more)

### Community 12 - "Agent Execution Engine"
Cohesion: 0.09
Nodes (16): Agent, buildAvailableModels(), buildConfigOptions(), buildVariantMeta(), defaultModel(), formatModelIdWithVariant(), getContextLimit(), getUsedTokens() (+8 more)

### Community 13 - "Skill Discovery & HTTP"
Cohesion: 0.05
Nodes (11): Index, IndexSkill, Service, cleanup(), init(), cleanupStateIndex(), ensureRunning(), handleRequest() (+3 more)

### Community 14 - "Copilot Auth Plugin"
Cohesion: 0.07
Nodes (24): base(), normalizeDomain(), acquire(), acquireLockDir(), code(), jitter(), mono(), sleep() (+16 more)

### Community 15 - "Orchestration & Concurrency"
Cohesion: 0.08
Nodes (18): acquire(), cancelWaiter(), cancelWaiters(), cleanup(), ConcurrencyCancelledError, getSlot(), release(), assertCanSpawn() (+10 more)

### Community 16 - "Tool Permissions & Bash"
Cohesion: 0.09
Nodes (20): argPath(), collect(), commands(), cygpath(), dynamic(), expand(), home(), noncwd() (+12 more)

### Community 17 - "Agent Prompts & Templates"
Cohesion: 0.12
Nodes (34): File Search Specialist Prompt, Code Review Command Template, AGENTS.md Convention, Exa AI API, Internet Research via WebFetch, OpenCode Agent Identity, Parallel Tool Calls, Read Before Edit Constraint (+26 more)

### Community 18 - "Session Revert & ACP"
Cohesion: 0.08
Nodes (4): Service, ACPSessionManager, Service, Service

### Community 19 - "Provider Authentication"
Cohesion: 0.08
Nodes (8): Service, base64UrlEncode(), extractAccountId(), extractAccountIdFromClaims(), generatePKCE(), generateRandomString(), generateState(), parseJwtClaims()

### Community 20 - "Companion/Buddy System"
Cohesion: 0.2
Nodes (16): companionUserId(), getCompanion(), hashString(), mulberry32(), pick(), roll(), rollFrom(), rollRarity() (+8 more)

### Community 21 - "ACP Protocol Integration"
Cohesion: 0.14
Nodes (15): ACP Agent Component, ACP Client Component, Rationale: Use Official ACP SDK Library, Agent Client Protocol (ACP) v1, ACP QuestionTool Opt-In, ACP Implementation README, @agentclientprotocol/sdk, ACP Server Component (+7 more)

### Community 22 - "Effect-Zod Utilities"
Cohesion: 0.6
Nodes (9): array(), body(), decl(), fail(), object(), opt(), union(), walk() (+1 more)

### Community 23 - "Model Selection & Transcript"
Cohesion: 0.33
Nodes (6): get(), name(), formatAssistantHeader(), formatMessage(), formatPart(), formatTranscript()

### Community 24 - "Spinner & Mood System"
Cohesion: 0.39
Nodes (7): colorSpecFor(), forTool(), global(), mood(), next(), nextColor(), random()

### Community 25 - "Plan/Build Mode Prompts"
Cohesion: 0.43
Nodes (7): Build Mode, Plan Mode, Read-Only Plan Phase, Build-Switch Prompt, Plan Mode Prompt, Plan Reminder Anthropic Prompt, Plan-Enter Tool

### Community 26 - "File Locking"
Cohesion: 0.7
Nodes (4): get(), process(), read(), write()

### Community 27 - "Async Queue"
Cohesion: 0.5
Nodes (1): AsyncQueue

### Community 28 - "Provider Origin Labels"
Cohesion: 0.7
Nodes (4): consoleManagedProviderLabel(), consoleManagedProviderSuffix(), contains(), isConsoleManagedProvider()

### Community 29 - "Color Utilities"
Cohesion: 0.83
Nodes (3): hexToAnsiBold(), hexToRgb(), isValidHex()

### Community 30 - "Terminal Color Detection"
Cohesion: 1.0
Nodes (2): colors(), getTerminalBackgroundColor()

### Community 31 - "Agent Generation Prompts"
Cohesion: 0.67
Nodes (3): Agent Architect Expert Persona, Agent Generate JSON Output Schema, Agent Generation Prompt

### Community 32 - "External Module Types"
Cohesion: 1.0
Nodes (1): Arborist

### Community 33 - "Bun DB Adapter"
Cohesion: 1.0
Nodes (0): 

### Community 34 - "Node DB Adapter"
Cohesion: 1.0
Nodes (0): 

### Community 35 - "LSP Tool Spec"
Cohesion: 1.0
Nodes (2): Language Server Protocol Server, LSP Tool

### Community 36 - "Max Steps Constraint"
Cohesion: 1.0
Nodes (2): Max Steps Constraint, Max Steps Prompt

### Community 37 - "SQL Type Declarations"
Cohesion: 1.0
Nodes (0): 

### Community 38 - "OpenTUI Trait Types"
Cohesion: 1.0
Nodes (0): 

### Community 39 - "Models Snapshot (JS)"
Cohesion: 1.0
Nodes (0): 

### Community 40 - "Models Snapshot (TS)"
Cohesion: 1.0
Nodes (0): 

## Knowledge Gaps
- **79 isolated node(s):** `Service`, `Arborist`, `IndexSkill`, `Index`, `Service` (+74 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `External Module Types`** (2 nodes): `external-modules.d.ts`, `Arborist`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Bun DB Adapter`** (2 nodes): `db.bun.ts`, `init()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Node DB Adapter`** (2 nodes): `db.node.ts`, `init()`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `LSP Tool Spec`** (2 nodes): `Language Server Protocol Server`, `LSP Tool`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Max Steps Constraint`** (2 nodes): `Max Steps Constraint`, `Max Steps Prompt`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `SQL Type Declarations`** (1 nodes): `sql.d.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `OpenTUI Trait Types`** (1 nodes): `opentui-traits.d.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Models Snapshot (JS)`** (1 nodes): `models-snapshot.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Models Snapshot (TS)`** (1 nodes): `models-snapshot.d.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `ACPSessionManager` connect `Session Revert & ACP` to `Session Storage & Events`?**
  _High betweenness centrality (0.011) - this node is a cross-community bridge._
- **Are the 11 inferred relationships involving `inline()` (e.g. with `block()` and `fallback()`) actually correct?**
  _`inline()` has 11 INFERRED edges - model-reasoned connections that need verification._
- **Are the 8 inferred relationships involving `argPath()` (e.g. with `expand()` and `home()`) actually correct?**
  _`argPath()` has 8 INFERRED edges - model-reasoned connections that need verification._
- **What connects `Service`, `Arborist`, `IndexSkill` to the rest of the system?**
  _79 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Plugin System & Auth` be split into smaller, more focused modules?**
  _Cohesion score 0.01 - nodes in this community are weakly interconnected._
- **Should `TUI Plugin API` be split into smaller, more focused modules?**
  _Cohesion score 0.02 - nodes in this community are weakly interconnected._
- **Should `Session Storage & Events` be split into smaller, more focused modules?**
  _Cohesion score 0.02 - nodes in this community are weakly interconnected._