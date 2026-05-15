import { NodeFileSystem } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Command } from "../../src/command"
import { Config } from "../../src/config/config"
import { FileTime } from "../../src/file/time"
import { AppFileSystem } from "../../src/filesystem"
import { LSP } from "../../src/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { Snapshot } from "../../src/snapshot"
import { Instruction } from "../../src/session/instruction"
import { LLM } from "../../src/session/llm"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionStatus } from "../../src/session/status"
import { ToolRegistry } from "../../src/tool/registry"
import { Todo } from "../../src/session/todo"
import { Question } from "../../src/question"
import { Truncate } from "../../src/tool/truncate"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { BackgroundJob } from "../../src/background/job"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { Skill } from "../../src/skill"

const ref = {
  providerID: ProviderID.openai,
  modelID: ModelID.make("gpt-5.2"),
}

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in parallel execution tests"),
    authenticate: () => Effect.die("unexpected MCP auth in parallel execution tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in parallel execution tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const filetime = Layer.succeed(
  FileTime.Service,
  FileTime.Service.of({
    read: () => Effect.void,
    get: () => Effect.succeed(undefined),
    assert: () => Effect.void,
    withLock: (_filepath, fn) => Effect.promise(fn),
  }),
)

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer, FetchHttpClient.layer)

function makeHttp() {
  const deps = Layer.mergeAll(
    Session.defaultLayer,
    Snapshot.defaultLayer,
    LLM.defaultLayer,
    AgentSvc.defaultLayer,
    Command.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
    Config.defaultLayer,
    ProviderSvc.defaultLayer,
    filetime,
    lsp,
    mcp,
    AppFileSystem.defaultLayer,
    status,
  ).pipe(Layer.provideMerge(infra))
  const question = Question.layer.pipe(Layer.provideMerge(deps))
  const todo = Todo.layer.pipe(Layer.provideMerge(deps))
  const registry = ToolRegistry.layer.pipe(
    Layer.provide(BackgroundJob.defaultLayer),
    Layer.provideMerge(todo),
    Layer.provideMerge(question),
    Layer.provideMerge(deps),
  )
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const proc = SessionProcessor.layer.pipe(Layer.provideMerge(deps))
  const compact = SessionCompaction.layer.pipe(Layer.provideMerge(proc), Layer.provideMerge(deps))
  const runState = SessionRunState.layer.pipe(Layer.provide(BackgroundJob.defaultLayer), Layer.provideMerge(deps))
  const revert = SessionRevert.defaultLayer
  return Layer.mergeAll(
    TestLLMServer.layer,
    SessionPrompt.layer.pipe(
      Layer.provideMerge(compact),
      Layer.provideMerge(proc),
      Layer.provideMerge(registry),
      Layer.provideMerge(trunc),
      Layer.provideMerge(runState),
      Layer.provide(revert),
      Layer.provide(Instruction.defaultLayer),
      Layer.provide(Skill.defaultLayer),
      Layer.provideMerge(deps),
    ),
  )
}

const it = testEffect(makeHttp())

function cfg(url: string, experimental?: Partial<NonNullable<Config.Info["experimental"]>>) {
  return {
    enabled_providers: ["openai"],
    experimental,
    provider: {
      openai: {
        options: {
          apiKey: "test-key",
          baseURL: url,
        },
      },
    },
    agent: {
      parallel_safe: {
        mode: "subagent",
        permission: {
          "*": "deny",
          grep: "allow",
          glob: "allow",
        },
      },
      parallel_mixed: {
        mode: "subagent",
        permission: {
          "*": "deny",
          grep: "allow",
          bash: "allow",
        },
      },
      parallel_read_only: {
        mode: "subagent",
        permission: {
          "*": "deny",
          read: "allow",
        },
      },
      parallel_read_scoped: {
        mode: "subagent",
        permission: {
          "*": "deny",
          read: {
            "*": "allow",
            "*.env": "ask",
          },
        },
      },
    },
  } satisfies Partial<Config.Info>
}

function toolNames(body: Record<string, unknown>) {
  const tools = body.tools
  if (!Array.isArray(tools)) return []
  return tools.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    if ("name" in item && typeof item.name === "string") return [item.name]
    const fn = "function" in item && item.function && typeof item.function === "object" ? item.function : undefined
    const name = fn && "name" in fn && typeof fn.name === "string" ? fn.name : undefined
    return name ? [name] : []
  })
}

function isToolResultFollowUp(body: Record<string, unknown>) {
  if (Array.isArray(body.messages)) {
    const last = body.messages[body.messages.length - 1]
    return !!last && typeof last === "object" && "role" in last && last.role === "tool"
  }
  if (Array.isArray(body.input)) {
    return body.input.some(
      (item) => !!item && typeof item === "object" && "type" in item && item.type === "function_call_output",
    )
  }
  return false
}

function toolResultIDs(body: Record<string, unknown>) {
  if (Array.isArray(body.messages)) {
    return body.messages.flatMap((msg) => {
      if (!msg || typeof msg !== "object") return []
      if (!("role" in msg) || msg.role !== "tool") return []
      return "tool_call_id" in msg && typeof msg.tool_call_id === "string" ? [msg.tool_call_id] : []
    })
  }
  if (Array.isArray(body.input)) {
    return body.input.flatMap((item) => {
      if (!item || typeof item !== "object") return []
      if (!("type" in item) || item.type !== "function_call_output") return []
      return "call_id" in item && typeof item.call_id === "string" ? [item.call_id] : []
    })
  }
  return []
}

const runSession = Effect.fn("ParallelExecutionTest.runSession")(function* (input: {
  agent: string
  sessionPermission?: Permission.Ruleset
}) {
  const prompt = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  const llm = yield* TestLLMServer

  const chat = yield* sessions.create({
    title: "Pinned",
    ...(input.sessionPermission ? { permission: input.sessionPermission } : {}),
  })

  yield* prompt.prompt({
    sessionID: chat.id,
    agent: input.agent,
    model: ref,
    noReply: true,
    parts: [{ type: "text", text: "hello" }],
  })
  yield* llm.text("done")

  const result = yield* prompt.loop({ sessionID: chat.id })
  expect(result.info.role).toBe("assistant")

  const inputs = yield* llm.inputs
  expect(inputs).toHaveLength(1)
  return {
    body: inputs[0],
    inputs,
    result,
    sessionID: chat.id,
  }
})

describe("session parallel execution", () => {
  it.live("enables parallel tool calls for safe subagent sessions", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        const { body } = yield* runSession({ agent: "parallel_safe" })
        expect(body.parallel_tool_calls).toBe(true)
        expect(toolNames(body)).toEqual(expect.arrayContaining(["grep", "glob"]))
        expect(toolNames(body)).not.toContain("bash")
      }),
      { config: (url) => cfg(url) },
    ),
  )

  it.live("falls back to serial execution when any active tool is unsafe", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        const { body } = yield* runSession({ agent: "parallel_mixed" })
        expect(body.parallel_tool_calls ?? false).toBe(false)
        expect(toolNames(body)).toEqual(expect.arrayContaining(["grep", "bash"]))
      }),
      { config: (url) => cfg(url) },
    ),
  )

  it.live("keeps read gated until parallel_read is enabled", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        const { body } = yield* runSession({ agent: "parallel_read_only" })
        expect(body.parallel_tool_calls ?? false).toBe(false)
        expect(toolNames(body)).toEqual(expect.arrayContaining(["read"]))
      }),
      { config: (url) => cfg(url) },
    ),
  )

  it.live("falls back when merged permissions still contain path-scoped read prompts", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* () {
        const { body } = yield* runSession({
          agent: "parallel_read_scoped",
          sessionPermission: [{ permission: "read", pattern: "*", action: "allow" }],
        })
        expect(body.parallel_tool_calls ?? false).toBe(false)
        expect(toolNames(body)).toEqual(expect.arrayContaining(["read"]))
      }),
      {
        config: (url) =>
          cfg(url, {
            parallel_read: true,
          }),
      },
    ),
  )

  it.live("preserves mocked toolCallId mappings for parallel tool-result follow-up", () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => Bun.write(`${dir}/alpha.txt`, "alpha needle\n"))
          yield* Effect.promise(() => Bun.write(`${dir}/beta.txt`, "beta needle\n"))
          yield* Effect.promise(() => Bun.write(`${dir}/notes.md`, "# parallel glob\n"))

          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const chat = yield* sessions.create({ title: "Pinned" })

          yield* prompt.prompt({
            sessionID: chat.id,
            agent: "parallel_safe",
            model: ref,
            noReply: true,
            parts: [{ type: "text", text: "search in parallel" }],
          })

          yield* llm.push(
            reply()
              .tool("grep", { pattern: "alpha", path: dir, include: "*.txt" })
              .tool("glob", { pattern: "*.md", path: dir })
              .tool("grep", { pattern: "beta", path: dir, include: "*.txt" }),
          )
          yield* llm.text("done")

          const result = yield* prompt.loop({ sessionID: chat.id })
          expect(result.info.role).toBe("assistant")
          expect(result.parts.some((part) => part.type === "text" && part.text === "done")).toBe(true)

          const inputs = yield* llm.inputs
          expect(inputs).toHaveLength(2)
          const hits = yield* llm.hits
          expect(hits).toHaveLength(2)

          const turns = inputs.filter((body) => !isToolResultFollowUp(body))
          expect(turns).toHaveLength(1)
          expect(turns[0]?.parallel_tool_calls).toBe(true)
          expect(hits.filter((hit) => !isToolResultFollowUp(hit.body))).toHaveLength(1)
          expect(hits[0]?.url.pathname).toBe(hits[1]?.url.pathname)
          expect(toolResultIDs(inputs[1] ?? {})).toEqual(["call_1", "call_2", "call_3"])

          const msgs = yield* MessageV2.filterCompactedEffect(chat.id)
          const tools = msgs
            .flatMap((msg) => msg.parts)
            .filter((part): part is MessageV2.ToolPart => part.type === "tool")
          expect(tools).toHaveLength(3)

          const byCall = Object.fromEntries(tools.map((part) => [part.callID, part]))
          expect(Object.keys(byCall)).toEqual(["call_1", "call_2", "call_3"])

          expect(byCall.call_1?.tool).toBe("grep")
          expect(byCall.call_1?.state.status).toBe("completed")
          if (byCall.call_1?.state.status === "completed") {
            expect(byCall.call_1.state.input).toEqual({ pattern: "alpha", path: dir, include: "*.txt" })
            expect(byCall.call_1.state.output).toContain("alpha.txt")
          }

          expect(byCall.call_2?.tool).toBe("glob")
          expect(byCall.call_2?.state.status).toBe("completed")
          if (byCall.call_2?.state.status === "completed") {
            expect(byCall.call_2.state.input).toEqual({ pattern: "*.md", path: dir })
            expect(byCall.call_2.state.output).toContain("notes.md")
          }

          expect(byCall.call_3?.tool).toBe("grep")
          expect(byCall.call_3?.state.status).toBe("completed")
          if (byCall.call_3?.state.status === "completed") {
            expect(byCall.call_3.state.input).toEqual({ pattern: "beta", path: dir, include: "*.txt" })
            expect(byCall.call_3.state.output).toContain("beta.txt")
          }
        }),
      { config: (url) => cfg(url) },
    ),
  )
})
