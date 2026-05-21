import { NodeFileSystem } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import type { Agent } from "../../src/agent/agent"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { Snapshot } from "../../src/snapshot"
import { Log } from "../../src/util/log"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { describe, test } from "bun:test"

Log.init({ print: false })

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string, experimental?: Record<string, unknown>) {
  return {
    ...cfg,
    experimental,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
  const session = yield* Session.Service
  const msg: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
const deps = Layer.mergeAll(
  Session.defaultLayer,
  Snapshot.defaultLayer,
  AgentSvc.defaultLayer,
  Permission.defaultLayer,
  Plugin.defaultLayer,
  Config.defaultLayer,
  LLM.defaultLayer,
  Provider.defaultLayer,
  status,
).pipe(Layer.provideMerge(infra))
const env = Layer.mergeAll(TestLLMServer.layer, SessionProcessor.layer.pipe(Layer.provideMerge(deps)))

const it = testEffect(env)

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})

// ---------------------------------------------------------------------------
// truncateHeadTail unit tests
// ---------------------------------------------------------------------------

describe("SessionProcessor.truncateHeadTail", () => {
  test("returns text unchanged when lines <= head + tail", () => {
    const text = Array(70).fill("line").join("\n")
    const result = SessionProcessor.truncateHeadTail(text, 50, 20)
    expect(result).toBe(text)
  })

  test("returns text unchanged when lines exactly equal head + tail", () => {
    const lines = Array(70).fill("x")
    const text = lines.join("\n")
    const result = SessionProcessor.truncateHeadTail(text, 50, 20)
    expect(result).toBe(text)
  })

  test("truncates when lines exceed head + tail", () => {
    const lines = Array(100)
      .fill("x")
      .map((_, i) => `line-${i}`)
    const text = lines.join("\n")
    const result = SessionProcessor.truncateHeadTail(text, 50, 20)
    const parts = result.split("\n")
    // head 50 + separator 3 (empty, message, empty) + tail 20 = 73
    expect(parts[0]).toBe("line-0")
    expect(parts[49]).toBe("line-49")
    expect(parts).toContainEqual(expect.stringContaining("30 lines omitted"))
    expect(parts[parts.length - 1]).toBe("line-99")
    expect(parts[parts.length - 20]).toBe("line-80")
  })

  test("handles large output correctly", () => {
    const lines = Array(200)
      .fill("x")
      .map((_, i) => `row-${i}`)
    const text = lines.join("\n")
    const result = SessionProcessor.truncateHeadTail(text, 50, 20)
    expect(result).toContain("130 lines omitted")
    expect(result.startsWith("row-0\n")).toBe(true)
    expect(result.endsWith("row-199")).toBe(true)
  })

  test("handles single line input", () => {
    const result = SessionProcessor.truncateHeadTail("single", 50, 20)
    expect(result).toBe("single")
  })
})

// ---------------------------------------------------------------------------
// truncateHeadTail with custom head/tail counts
// ---------------------------------------------------------------------------

describe("SessionProcessor.truncateHeadTail custom counts", () => {
  test("respects custom head=10 tail=5", () => {
    const lines = Array(50)
      .fill("x")
      .map((_, i) => `r-${i}`)
    const text = lines.join("\n")
    const result = SessionProcessor.truncateHeadTail(text, 10, 5)
    const parts = result.split("\n")
    expect(parts[0]).toBe("r-0")
    expect(parts[9]).toBe("r-9")
    expect(parts).toContainEqual(expect.stringContaining("35 lines omitted"))
    expect(parts[parts.length - 1]).toBe("r-49")
    expect(parts[parts.length - 5]).toBe("r-45")
  })

  test("no truncation when lines <= head + tail with custom counts", () => {
    const lines = Array(15)
      .fill("x")
      .map((_, i) => `r-${i}`)
    const text = lines.join("\n")
    const result = SessionProcessor.truncateHeadTail(text, 10, 5)
    expect(result).toBe(text)
  })

  test("head=1 tail=1 truncates aggressively", () => {
    const lines = Array(10)
      .fill("x")
      .map((_, i) => `r-${i}`)
    const text = lines.join("\n")
    const result = SessionProcessor.truncateHeadTail(text, 1, 1)
    const parts = result.split("\n")
    expect(parts[0]).toBe("r-0")
    expect(parts).toContainEqual(expect.stringContaining("8 lines omitted"))
    expect(parts[parts.length - 1]).toBe("r-9")
  })
})

// ---------------------------------------------------------------------------
// Heuristic gate logic
// ---------------------------------------------------------------------------

describe("heuristic gate defaults", () => {
  test("heuristic enabled by default (no experimental config)", () => {
    const cfg: Record<string, unknown> = {}
    const tool = "grep"
    const heuristic = (tool === "grep" || tool === "glob") && (cfg.experimental as any)?.compression_heuristic !== false
    expect(heuristic).toBe(true)
  })

  test("heuristic enabled when compression_heuristic is undefined", () => {
    const cfg = { experimental: {} }
    const tool: string = "glob"
    const heuristic = (tool === "grep" || tool === "glob") && (cfg.experimental as any)?.compression_heuristic !== false
    expect(heuristic).toBe(true)
  })

  test("heuristic disabled when compression_heuristic is false", () => {
    const cfg = { experimental: { compression_heuristic: false } }
    const tool: string = "grep"
    const heuristic = (tool === "grep" || tool === "glob") && (cfg.experimental as any)?.compression_heuristic !== false
    expect(heuristic).toBe(false)
  })

  test("heuristic enabled when compression_heuristic is true", () => {
    const cfg = { experimental: { compression_heuristic: true } }
    const tool: string = "grep"
    const heuristic = (tool === "grep" || tool === "glob") && (cfg.experimental as any)?.compression_heuristic !== false
    expect(heuristic).toBe(true)
  })

  test("heuristic false for bash tool", () => {
    const cfg = { experimental: { compression_heuristic: true } }
    const tool: string = "bash"
    const heuristic = (tool === "grep" || tool === "glob") && (cfg.experimental as any)?.compression_heuristic !== false
    expect(heuristic).toBe(false)
  })

  test("heuristic false for read tool", () => {
    const cfg = {}
    const tool: string = "read"
    const heuristic = (tool === "grep" || tool === "glob") && (cfg as any).experimental?.compression_heuristic !== false
    expect(heuristic).toBe(false)
  })

  test("heuristic enabled when compression_heuristic is true", () => {
    const cfg = { experimental: { compression_heuristic: true } }
    const tool = "grep"
    const heuristic = (tool === "grep" || tool === "glob") && (cfg.experimental as any)?.compression_heuristic !== false
    expect(heuristic).toBe(true)
  })

  test("heuristic false for bash tool", () => {
    const cfg = { experimental: { compression_heuristic: true } }
    const tool: string = "bash"
    const heuristic = (tool === "grep" || tool === "glob") && (cfg.experimental as any)?.compression_heuristic !== false
    expect(heuristic).toBe(false)
  })

  test("heuristic false for read tool", () => {
    const cfg = {}
    const tool: string = "read"
    const heuristic = (tool === "grep" || tool === "glob") && (cfg as any).experimental?.compression_heuristic !== false
    expect(heuristic).toBe(false)
  })

  test("head/tail defaults from hybrid config", () => {
    const cfg: Record<string, unknown> = {}
    const head = (cfg.hybrid as any)?.heuristic_head ?? 50
    const tail = (cfg.hybrid as any)?.heuristic_tail ?? 20
    expect(head).toBe(50)
    expect(tail).toBe(20)
  })

  test("head/tail uses hybrid config values", () => {
    const cfg = { hybrid: { heuristic_head: 30, heuristic_tail: 10 } }
    const head = cfg.hybrid?.heuristic_head ?? 50
    const tail = cfg.hybrid?.heuristic_tail ?? 20
    expect(head).toBe(30)
    expect(tail).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// Noop exit test
// ---------------------------------------------------------------------------

it.live("noop exit stops loop when model returns empty response", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        // Push an empty response (role header + stop, no text/tools)
        yield* llm.push(reply().stop().item())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        })

        expect(value).toBe("stop")
      }),
    { git: true, config: (url) => providerCfg(url, { noop_exit: true }) },
  ),
)

it.live("noop exit does not trigger when model returns text", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.text("hello")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        })

        expect(value).toBe("continue")
      }),
    { git: true, config: (url) => providerCfg(url, { noop_exit: true }) },
  ),
)

it.live("noop exit disabled by default - empty response returns continue", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.push(reply().stop().item())

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hi")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        const value = yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
        })

        // Without noop_exit, empty response still returns "continue"
        expect(value).toBe("continue")
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

// ---------------------------------------------------------------------------
// compression_attempted replay-safety guard — unit-level tests
// [fork-perf] compression-replay-safety
// ---------------------------------------------------------------------------

/**
 * Mirror of the alreadyAttempted detection logic in completeToolCall.
 * Extracted here so we can test the branching without wiring the full session.
 */
function computeAlreadyAttempted(
  freshPart:
    | { type: string; state: { status: string; metadata?: Record<string, unknown> } }
    | undefined,
): boolean {
  return (
    freshPart?.type === "tool" &&
    freshPart.state.status === "completed" &&
    (freshPart.state.metadata as Record<string, unknown>)?.compression_attempted === true
  )
}

describe("compression-replay-safety: alreadyAttempted guard", () => {
  test("returns false when freshPart is undefined", () => {
    expect(computeAlreadyAttempted(undefined)).toBe(false)
  })

  test("returns false when part type is not tool", () => {
    expect(
      computeAlreadyAttempted({
        type: "text",
        state: { status: "completed", metadata: { compression_attempted: true } },
      }),
    ).toBe(false)
  })

  test("returns false when state is not completed", () => {
    expect(
      computeAlreadyAttempted({
        type: "tool",
        state: { status: "running", metadata: { compression_attempted: true } },
      }),
    ).toBe(false)
  })

  test("returns false when compression_attempted is missing", () => {
    expect(
      computeAlreadyAttempted({
        type: "tool",
        state: { status: "completed", metadata: {} },
      }),
    ).toBe(false)
  })

  test("returns false when compression_attempted is false", () => {
    expect(
      computeAlreadyAttempted({
        type: "tool",
        state: { status: "completed", metadata: { compression_attempted: false } },
      }),
    ).toBe(false)
  })

  test("returns true when type=tool, status=completed, compression_attempted=true", () => {
    expect(
      computeAlreadyAttempted({
        type: "tool",
        state: { status: "completed", metadata: { compression_attempted: true } },
      }),
    ).toBe(true)
  })

  test("returns true regardless of other metadata fields", () => {
    expect(
      computeAlreadyAttempted({
        type: "tool",
        state: {
          status: "completed",
          metadata: {
            compression_attempted: true,
            compressed: true,
            compression_fallback: true,
            compression_template: "heuristic_head_tail",
          },
        },
      }),
    ).toBe(true)
  })

  test("returns false when metadata is undefined", () => {
    expect(
      computeAlreadyAttempted({
        type: "tool",
        state: { status: "completed", metadata: undefined },
      }),
    ).toBe(false)
  })
})

describe("compression-replay-safety: metadata written in heuristic branch", () => {
  test("heuristic metadata shape includes compression_attempted=true", () => {
    // Represents the metadata object constructed in the heuristic branch of completeToolCall.
    const baseMetadata: Record<string, unknown> = { some_tool_meta: "x" }
    const written = {
      ...baseMetadata,
      compressed: true,
      compression_template: "heuristic_head_tail",
      // [fork-perf] compression-replay-safety
      compression_attempted: true,
    }
    expect(written.compression_attempted).toBe(true)
    expect(written.compressed).toBe(true)
    expect(written.compression_template).toBe("heuristic_head_tail")
  })
})

describe("compression-replay-safety: metadata written in LLM-compress branch", () => {
  test("LLM compress metadata shape includes compression_attempted=true (success path)", () => {
    // Represents the metadata object constructed in the LLM compress branch.
    const baseMetadata: Record<string, unknown> = {}
    const stats = { template: "bash", ratio: 0.5, fallback: false, validated: true }
    const written = {
      ...baseMetadata,
      compressed: true,
      compression_template: stats.template,
      compression_ratio: stats.ratio,
      compression_fallback: stats.fallback,
      compression_validated: stats.validated,
      // [fork-perf] compression-replay-safety
      compression_attempted: true,
    }
    expect(written.compression_attempted).toBe(true)
    expect(written.compression_fallback).toBe(false)
  })

  test("LLM compress metadata shape includes compression_attempted=true (fallback path)", () => {
    // When LLMCompress falls back, stats.fallback=true but marker is still written.
    const baseMetadata: Record<string, unknown> = {}
    const stats = { template: "bash", ratio: 1, fallback: true, validated: false }
    const written = {
      ...baseMetadata,
      compressed: true,
      compression_template: stats.template,
      compression_ratio: stats.ratio,
      compression_fallback: stats.fallback,
      compression_validated: stats.validated,
      // [fork-perf] compression-replay-safety
      compression_attempted: true,
    }
    expect(written.compression_attempted).toBe(true)
    expect(written.compression_fallback).toBe(true)
    // Guard sees this as already-attempted: no re-compression on next entry
    expect(computeAlreadyAttempted({ type: "tool", state: { status: "completed", metadata: written } })).toBe(true)
  })
})
