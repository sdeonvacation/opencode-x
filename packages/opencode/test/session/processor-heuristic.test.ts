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
