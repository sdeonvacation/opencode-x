import { NodeFileSystem } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { tool } from "ai"
import z from "zod"
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

function providerCfg(url: string) {
  return {
    ...cfg,
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
    // Auto-allow all permissions including doom_loop
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

// A simple tool that auto-completes with a fixed output
const loopTool = tool({
  description: "test tool",
  inputSchema: z.object({ cmd: z.string() }),
  execute: async () => ({ output: "done", title: "bash", metadata: {} }),
})

describe("doom loop hard cap", () => {
  it.live(
    "hard-fails tool after doom loop fires more than DOOM_LOOP_HARD_CAP times",
    () =>
      provideTmpdirServer(
        ({ dir, llm }) =>
          Effect.gen(function* () {
            const { processors, session, provider } = yield* boot()

            // Queue repeated single-tool responses.
            // Doom loop starts after the 3rd matching tool part, then increments on each loop.
            // Step 6 exceeds DOOM_LOOP_HARD_CAP=3 → hard fail.
            for (let i = 0; i < 6; i++) {
              yield* llm.push(reply().tool("bash", { cmd: "echo loop" }))
            }
            // Final response after hard cap (won't be reached if process stops)
            yield* llm.push(reply().text("final").stop())

            const chat = yield* session.create({})
            const parent = yield* user(chat.id, "doom loop test")
            const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
            const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
            const handle = yield* processors.create({
              assistantMessage: msg,
              sessionID: chat.id,
              model: mdl,
            })

            const input = {
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
              messages: [{ role: "user" as const, content: "doom loop test" }],
              tools: { bash: loopTool },
            }

            // Call process() in a loop like prompt.ts does.
            // Each call consumes one LLM response with one matching tool call.
            let result: SessionProcessor.Result = "continue"
            for (let i = 0; i < 7 && result === "continue"; i++) {
              result = yield* handle.process(input)
            }

            const parts = MessageV2.parts(msg.id)
            const tools = parts.filter((p): p is MessageV2.ToolPart => p.type === "tool")
            const failed = tools.filter((t) => t.state.status === "error")
            const doom = failed.filter(
              (t) => t.state.status === "error" && t.state.error.includes("Doom loop detected"),
            )

            // Hard cap triggered — at least one tool failed with doom loop message
            expect(doom.length).toBeGreaterThan(0)
            expect(doom[0].state.status === "error" && doom[0].state.error).toContain("Doom loop detected")
            expect(doom[0].state.status === "error" && doom[0].state.error).toContain("bash")
            // Process returns "stop" because ctx.blocked was set
            expect(result).toBe("stop")
          }),
        { git: true, config: (url) => providerCfg(url) },
      ),
    30000,
  )

  it.live(
    "does not hard-fail when doom loop count is at or below cap",
    () =>
      provideTmpdirServer(
        ({ dir, llm }) =>
          Effect.gen(function* () {
            const { processors, session, provider } = yield* boot()

            // Queue repeated single-tool responses up to the hard cap.
            // Step 5 reaches count=3, which is allowed.
            for (let i = 0; i < 5; i++) {
              yield* llm.push(reply().tool("bash", { cmd: "echo ok" }))
            }
            yield* llm.push(reply().text("done").stop())

            const chat = yield* session.create({})
            const parent = yield* user(chat.id, "under cap")
            const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
            const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
            const handle = yield* processors.create({
              assistantMessage: msg,
              sessionID: chat.id,
              model: mdl,
            })

            const input = {
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
              messages: [{ role: "user" as const, content: "under cap" }],
              tools: { bash: loopTool },
            }

            // Call process() in a loop — 5 tool responses + 1 text stop
            let result: SessionProcessor.Result = "continue"
            for (let i = 0; i < 6 && result === "continue"; i++) {
              result = yield* handle.process(input)
            }

            const parts = MessageV2.parts(msg.id)
            const tools = parts.filter((p): p is MessageV2.ToolPart => p.type === "tool")
            const doom = tools.filter((t) => t.state.status === "error" && t.state.error.includes("Doom loop detected"))

            // No hard-fail doom loop errors
            expect(doom.length).toBe(0)
            // Process returns "continue" after final text+stop (caller decides to stop)
            expect(result).toBe("continue")
          }),
        { git: true, config: (url) => providerCfg(url) },
      ),
    30000,
  )

  it.live(
    "tracks different tool+input keys independently",
    () =>
      provideTmpdirServer(
        ({ dir, llm }) =>
          Effect.gen(function* () {
            const { processors, session, provider } = yield* boot()

            // Queue 4 responses alternating between two different inputs.
            // Key A fires at steps 1,3 (count=1,2). Key B fires at steps 2,4 (count=1,2).
            // Neither exceeds cap of 3.
            yield* llm.push(
              reply().tool("bash", { cmd: "echo a" }).tool("bash", { cmd: "echo a" }).tool("bash", { cmd: "echo a" }),
            )
            yield* llm.push(
              reply().tool("bash", { cmd: "echo b" }).tool("bash", { cmd: "echo b" }).tool("bash", { cmd: "echo b" }),
            )
            yield* llm.push(
              reply().tool("bash", { cmd: "echo a" }).tool("bash", { cmd: "echo a" }).tool("bash", { cmd: "echo a" }),
            )
            yield* llm.push(
              reply().tool("bash", { cmd: "echo b" }).tool("bash", { cmd: "echo b" }).tool("bash", { cmd: "echo b" }),
            )
            yield* llm.push(reply().text("done").stop())

            const chat = yield* session.create({})
            const parent = yield* user(chat.id, "independent keys")
            const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
            const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
            const handle = yield* processors.create({
              assistantMessage: msg,
              sessionID: chat.id,
              model: mdl,
            })

            const input = {
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
              messages: [{ role: "user" as const, content: "independent keys" }],
              tools: { bash: loopTool },
            }

            // Call process() in a loop — 4 tool responses + 1 text stop
            let result: SessionProcessor.Result = "continue"
            for (let i = 0; i < 6 && result === "continue"; i++) {
              result = yield* handle.process(input)
            }

            const parts = MessageV2.parts(msg.id)
            const tools = parts.filter((p): p is MessageV2.ToolPart => p.type === "tool")
            const doom = tools.filter((t) => t.state.status === "error" && t.state.error.includes("Doom loop detected"))

            // No hard-fail — each key only reaches count 2
            expect(doom.length).toBe(0)
            expect(result).toBe("continue")
          }),
        { git: true, config: (url) => providerCfg(url) },
      ),
    30000,
  )
})
