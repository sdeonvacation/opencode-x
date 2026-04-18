import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { TaskTool } from "../../src/tool/task"
import { ToolRegistry } from "../../src/tool/registry"
import { provideTmpdirInstance, tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { resolveTaskModel } from "../../src/orchestration/task-model-resolver"
import { route as hybridRoute } from "../../src/orchestration/hybrid-router"
import * as HybridPreflight from "../../src/orchestration/hybrid-preflight"
import { hint } from "../../src/tool/task"
import type { HybridRoutingConfig, ModelRef } from "../../src/orchestration/hybrid-types"

// Helper: initialize TaskTool (Tool.defineEffect) for non-Effect test contexts
const initTask = () =>
  Effect.runPromise(
    Effect.flatMap(Effect.provide(TaskTool, Layer.mergeAll(Agent.defaultLayer, Config.defaultLayer)), (info) =>
      Effect.promise(() => info.init()),
    ),
  )

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    ToolRegistry.defaultLayer,
  ),
)

const seed = Effect.fn("TaskToolTest.seed")(function* (title = "Pinned") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

function reply(input: Parameters<typeof SessionPrompt.prompt>[0], text: string): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      parentID: input.messageID ?? MessageID.ascending(),
      sessionID: input.sessionID,
      mode: input.agent ?? "general",
      agent: input.agent ?? "general",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: input.model?.modelID ?? ref.modelID,
      providerID: input.model?.providerID ?? ref.providerID,
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

describe("tool.task", () => {
  it.live("description sorts subagents by name and is stable across calls", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const agent = yield* Agent.Service
          const build = yield* agent.get("build")
          const registry = yield* ToolRegistry.Service
          const get = Effect.fnUntraced(function* () {
            const tools = yield* registry.tools({ ...ref, agent: build })
            return tools.find((tool) => tool.id === TaskTool.id)?.description ?? ""
          })
          const first = yield* get()
          const second = yield* get()

          expect(first).toBe(second)

          const alpha = first.indexOf("- alpha: Alpha agent")
          const explore = first.indexOf("- explore:")
          const general = first.indexOf("- general:")
          const zebra = first.indexOf("- zebra: Zebra agent")

          expect(alpha).toBeGreaterThan(-1)
          expect(explore).toBeGreaterThan(alpha)
          expect(general).toBeGreaterThan(explore)
          expect(zebra).toBeGreaterThan(general)
        }),
      {
        config: {
          agent: {
            zebra: {
              description: "Zebra agent",
              mode: "subagent",
            },
            alpha: {
              description: "Alpha agent",
              mode: "subagent",
            },
          },
        },
      },
    ),
  )

  it.live("description hides denied subagents for the caller", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const agent = yield* Agent.Service
          const build = yield* agent.get("build")
          const registry = yield* ToolRegistry.Service
          const description =
            (yield* registry.tools({ ...ref, agent: build })).find((tool) => tool.id === TaskTool.id)?.description ?? ""

          expect(description).toContain("- alpha: Alpha agent")
          expect(description).not.toContain("- zebra: Zebra agent")
        }),
      {
        config: {
          permission: {
            task: {
              "*": "allow",
              zebra: "deny",
            },
          },
          agent: {
            zebra: {
              description: "Zebra agent",
              mode: "subagent",
            },
            alpha: {
              description: "Alpha agent",
              mode: "subagent",
            },
          },
        },
      },
    ),
  )

  it.live("execute resumes an existing task session from task_id", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const child = yield* sessions.create({ parentID: chat.id, title: "Existing child" })
        const tool = yield* TaskTool
        const def = yield* Effect.promise(() => tool.init())
        const resolve = SessionPrompt.resolvePromptParts
        const prompt = SessionPrompt.prompt
        let seen: Parameters<typeof SessionPrompt.prompt>[0] | undefined

        SessionPrompt.resolvePromptParts = async (template) => [{ type: "text", text: template }]
        SessionPrompt.prompt = async (input) => {
          seen = input
          return reply(input, "resumed")
        }
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            SessionPrompt.resolvePromptParts = resolve
            SessionPrompt.prompt = prompt
          }),
        )

        const result = yield* Effect.promise(() =>
          def.execute(
            {
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type: "general",
              task_id: child.id,
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              messages: [],
              metadata() {},
              ask: async () => {},
            },
          ),
        )

        const kids = yield* sessions.children(chat.id)
        expect(kids).toHaveLength(1)
        expect(kids[0]?.id).toBe(child.id)
        expect(result.metadata.sessionId).toBe(child.id)
        expect(result.output).toContain(`task_id: ${child.id}`)
        expect(seen?.sessionID).toBe(child.id)
      }),
    ),
  )

  it.live("execute asks by default and skips checks when bypassed", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* Effect.promise(() => tool.init())
        const resolve = SessionPrompt.resolvePromptParts
        const prompt = SessionPrompt.prompt
        const calls: unknown[] = []

        SessionPrompt.resolvePromptParts = async (template) => [{ type: "text", text: template }]
        SessionPrompt.prompt = async (input) => reply(input, "done")
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            SessionPrompt.resolvePromptParts = resolve
            SessionPrompt.prompt = prompt
          }),
        )

        const exec = (extra?: { bypassAgentCheck?: boolean }) =>
          Effect.promise(() =>
            def.execute(
              {
                description: "inspect bug",
                prompt: "look into the cache key path",
                subagent_type: "general",
              },
              {
                sessionID: chat.id,
                messageID: assistant.id,
                agent: "build",
                abort: new AbortController().signal,
                extra,
                messages: [],
                metadata() {},
                ask: async (input) => {
                  calls.push(input)
                },
              },
            ),
          )

        yield* exec()
        yield* exec({ bypassAgentCheck: true })

        expect(calls).toHaveLength(1)
        expect(calls[0]).toEqual({
          permission: "task",
          patterns: ["general"],
          always: ["*"],
          metadata: {
            description: "inspect bug",
            subagent_type: "general",
          },
        })
      }),
    ),
  )

  it.live("execute creates a child when task_id does not exist", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* Effect.promise(() => tool.init())
        const resolve = SessionPrompt.resolvePromptParts
        const prompt = SessionPrompt.prompt
        let seen: Parameters<typeof SessionPrompt.prompt>[0] | undefined

        SessionPrompt.resolvePromptParts = async (template) => [{ type: "text", text: template }]
        SessionPrompt.prompt = async (input) => {
          seen = input
          return reply(input, "created")
        }
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            SessionPrompt.resolvePromptParts = resolve
            SessionPrompt.prompt = prompt
          }),
        )

        const result = yield* Effect.promise(() =>
          def.execute(
            {
              description: "inspect bug",
              prompt: "look into the cache key path",
              subagent_type: "general",
              task_id: "ses_missing",
            },
            {
              sessionID: chat.id,
              messageID: assistant.id,
              agent: "build",
              abort: new AbortController().signal,
              messages: [],
              metadata() {},
              ask: async () => {},
            },
          ),
        )

        const kids = yield* sessions.children(chat.id)
        expect(kids).toHaveLength(1)
        expect(kids[0]?.id).toBe(result.metadata.sessionId)
        expect(result.metadata.sessionId).not.toBe("ses_missing")
        expect(result.output).toContain(`task_id: ${result.metadata.sessionId}`)
        expect(seen?.sessionID).toBe(result.metadata.sessionId)
      }),
    ),
  )

  it.live("execute shapes child permissions for task, todowrite, and primary tools", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const { chat, assistant } = yield* seed()
          const tool = yield* TaskTool
          const def = yield* Effect.promise(() => tool.init())
          const resolve = SessionPrompt.resolvePromptParts
          const prompt = SessionPrompt.prompt
          let seen: Parameters<typeof SessionPrompt.prompt>[0] | undefined

          SessionPrompt.resolvePromptParts = async (template) => [{ type: "text", text: template }]
          SessionPrompt.prompt = async (input) => {
            seen = input
            return reply(input, "done")
          }
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              SessionPrompt.resolvePromptParts = resolve
              SessionPrompt.prompt = prompt
            }),
          )

          const result = yield* Effect.promise(() =>
            def.execute(
              {
                description: "inspect bug",
                prompt: "look into the cache key path",
                subagent_type: "reviewer",
              },
              {
                sessionID: chat.id,
                messageID: assistant.id,
                agent: "build",
                abort: new AbortController().signal,
                messages: [],
                metadata() {},
                ask: async () => {},
              },
            ),
          )

          const child = yield* sessions.get(result.metadata.sessionId)
          expect(child.parentID).toBe(chat.id)
          expect(child.permission).toEqual([
            {
              permission: "todowrite",
              pattern: "*",
              action: "deny",
            },
            {
              permission: "bash",
              pattern: "*",
              action: "allow",
            },
            {
              permission: "read",
              pattern: "*",
              action: "allow",
            },
          ])
          expect(seen?.tools).toEqual({
            todowrite: false,
            bash: false,
            read: false,
          })
        }),
      {
        config: {
          agent: {
            reviewer: {
              mode: "subagent",
              permission: {
                task: "allow",
              },
            },
          },
          experimental: {
            primary_tools: ["bash", "read"],
          },
        },
      },
    ),
  )

  test("returns a clear timeout error when subagent exceeds timeout", async () => {
    await using tmp = await tmpdir({
      config: {
        experimental: {
          subagent_timeout: 20,
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sessionID = SessionID.make("ses_task_test")
        const messageID = MessageID.make("msg_task_test")

        const cfg = spyOn(Config, "get").mockResolvedValue({
          experimental: { subagent_timeout: 20 },
        } as Awaited<ReturnType<typeof Config.get>>)
        const get = spyOn(Session, "get").mockResolvedValue({
          id: sessionID,
        } as Awaited<ReturnType<typeof Session.get>>)
        const create = spyOn(Session, "create").mockResolvedValue({ id: SessionID.make("ses_sub_task") } as Awaited<
          ReturnType<typeof Session.create>
        >)
        const msg = spyOn(MessageV2, "get").mockReturnValue({
          info: {
            role: "assistant",
            modelID: "gpt-5.2",
            providerID: "openai",
          },
        } as ReturnType<typeof MessageV2.get>)
        const parts = spyOn(SessionPrompt, "resolvePromptParts").mockResolvedValue([{ type: "text", text: "do work" }])
        const prompt = spyOn(SessionPrompt, "prompt").mockImplementation(async () => {
          await new Promise(() => {})
          throw new Error("unreachable")
        })

        try {
          const tool = await initTask()
          const run = tool.execute(
            {
              description: "hang subagent",
              prompt: "do work",
              subagent_type: "general",
            },
            {
              sessionID,
              messageID,
              agent: "build",
              abort: AbortSignal.any([]),
              messages: [],
              metadata: () => {},
              ask: async () => {},
              extra: { bypassAgentCheck: true },
            },
          )

          await expect(run).rejects.toThrow("Subagent timed out after 20ms")
        } finally {
          cfg.mockRestore()
          get.mockRestore()
          create.mockRestore()
          msg.mockRestore()
          parts.mockRestore()
          prompt.mockRestore()
        }
      },
    })
  })

  test("description documents explicit category and ultrawork parameters", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await initTask()

        // task_category and use_ultrawork are documented in the parameter schema
        expect(tool.parameters.shape).toHaveProperty("task_category")
        expect(tool.parameters.shape).toHaveProperty("use_ultrawork")
      },
    })
  })

  test("routes category normally, ultrawork by keyword, ignores code blocks, and keeps explicit access", async () => {
    await using tmp = await tmpdir({
      config: {
        experimental: {
          task_categories: {
            review: { providerID: "anthropic", modelID: "claude-review" },
          },
          ultrawork_model: { providerID: "openai", modelID: "ultra" },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sessionID = SessionID.make("ses_task_route")
        const messageID = MessageID.make("msg_task_route")
        const createdSessionID = SessionID.make("ses_sub_task_route")
        const ask = async () => {}
        const metadata = () => {}
        const baseCtx = {
          sessionID,
          messageID,
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata,
          ask,
          extra: { bypassAgentCheck: true },
        }

        const get = spyOn(Session, "get").mockImplementation((async (id: Parameters<typeof Session.get>[0]) => {
          if (id === sessionID) return { id: sessionID } as never
          if (id === createdSessionID) return { id: createdSessionID, parentID: sessionID } as never
          throw new Error(`Unknown session ${id}`)
        }) as unknown as typeof Session.get)
        const create = spyOn(Session, "create").mockResolvedValue({ id: createdSessionID } as Awaited<
          ReturnType<typeof Session.create>
        >)
        const msg = spyOn(MessageV2, "get").mockReturnValue({
          info: {
            role: "assistant",
            modelID: "gpt-5.2",
            providerID: "openai",
          },
        } as ReturnType<typeof MessageV2.get>)
        const parts = spyOn(SessionPrompt, "resolvePromptParts").mockResolvedValue([{ type: "text", text: "do work" }])
        const prompt = spyOn(SessionPrompt, "prompt")
          .mockResolvedValueOnce({ parts: [{ type: "text", text: "done" }] } as Awaited<
            ReturnType<typeof SessionPrompt.prompt>
          >)
          .mockResolvedValueOnce({ parts: [{ type: "text", text: "done" }] } as Awaited<
            ReturnType<typeof SessionPrompt.prompt>
          >)
          .mockResolvedValueOnce({ parts: [{ type: "text", text: "done" }] } as Awaited<
            ReturnType<typeof SessionPrompt.prompt>
          >)
          .mockResolvedValueOnce({ parts: [{ type: "text", text: "done" }] } as Awaited<
            ReturnType<typeof SessionPrompt.prompt>
          >)

        try {
          const tool = await initTask()

          await tool.execute(
            {
              description: "route by category",
              prompt: "do work",
              subagent_type: "general",
              task_category: "review",
            },
            baseCtx,
          )

          await tool.execute(
            {
              description: "route by ultrawork",
              prompt: "please use ultrawork for this",
              subagent_type: "general",
            },
            baseCtx,
          )

          await tool.execute(
            {
              description: "ignore code block keyword",
              prompt: "```ts\nconst mode = 'ultrawork'\n```",
              subagent_type: "general",
              task_category: "review",
            },
            baseCtx,
          )

          await tool.execute(
            {
              description: "route by ultrawork explicit",
              prompt: "normal prompt",
              subagent_type: "general",
              use_ultrawork: true,
            },
            baseCtx,
          )

          expect(prompt.mock.calls[0]?.[0].model).toEqual({
            providerID: ProviderID.make("anthropic"),
            modelID: ModelID.make("claude-review"),
          })
          expect(prompt.mock.calls[1]?.[0].model).toEqual({
            providerID: ProviderID.make("openai"),
            modelID: ModelID.make("ultra"),
          })
          expect(prompt.mock.calls[2]?.[0].model).toEqual({
            providerID: ProviderID.make("anthropic"),
            modelID: ModelID.make("claude-review"),
          })
          expect(prompt.mock.calls[3]?.[0].model).toEqual({
            providerID: ProviderID.make("openai"),
            modelID: ModelID.make("ultra"),
          })
        } finally {
          get.mockRestore()
          create.mockRestore()
          msg.mockRestore()
          parts.mockRestore()
          prompt.mockRestore()
        }
      },
    })
  })

  test("task ask route returns clarification result without running subagent", async () => {
    await using tmp = await tmpdir({
      config: {
        experimental: {
          hybrid_routing: {
            enabled: true,
            threshold: 0.7,
            local_models: [{ providerID: "ollama", modelID: "llama3" }],
            verify_commands: [],
            verify_cache_ttl_ms: 300_000,
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sessionID = SessionID.make("ses_task_ask")
        const messageID = MessageID.make("msg_task_ask")
        const subtaskID = SessionID.make("ses_sub_task_ask")

        const get = spyOn(Session, "get").mockImplementation((async (id: Parameters<typeof Session.get>[0]) => {
          if (id === sessionID) return { id: sessionID } as never
          if (id === subtaskID) return { id: subtaskID, parentID: sessionID } as never
          throw new Error(`Unknown session ${id}`)
        }) as unknown as typeof Session.get)
        const create = spyOn(Session, "create").mockResolvedValue({ id: subtaskID } as Awaited<
          ReturnType<typeof Session.create>
        >)
        const msg = spyOn(MessageV2, "get").mockReturnValue({
          info: {
            role: "assistant",
            modelID: "gpt-5.2",
            providerID: "openai",
          },
        } as ReturnType<typeof MessageV2.get>)
        const parts = spyOn(SessionPrompt, "resolvePromptParts").mockResolvedValue([{ type: "text", text: "do work" }])
        const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue({
          parts: [{ type: "text", text: "done" }],
        } as Awaited<ReturnType<typeof SessionPrompt.prompt>>)
        const preflight = spyOn(HybridPreflight, "run").mockReturnValue(
          Effect.succeed({
            confidence: 0.9,
            info_gap: "high",
            needs_code_change: false,
            operation_type: "other",
            assumptions: [],
            ask_candidates: ["repo path"],
          }) as never,
        )

        try {
          const tool = await initTask()
          const result = await tool.execute(
            {
              description: "need info",
              prompt: "please inspect repo",
              subagent_type: "general",
            },
            {
              sessionID,
              messageID,
              agent: "build",
              abort: AbortSignal.any([]),
              messages: [],
              metadata: () => {},
              ask: async () => {},
              extra: { bypassAgentCheck: true },
            },
          )

          expect(result.output).toContain("I need more information to proceed")
          expect(prompt).not.toHaveBeenCalled()
        } finally {
          get.mockRestore()
          create.mockRestore()
          msg.mockRestore()
          parts.mockRestore()
          prompt.mockRestore()
          preflight.mockRestore()
        }
      },
    })
  })

  test("uses session-scoped loop detection across task executions", async () => {
    await using tmp = await tmpdir({
      config: {
        experimental: {
          loop_detector_threshold: 2,
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sessionID = SessionID.make("ses_task_loop")
        const messageID = MessageID.make("msg_task_loop")
        const tool = await initTask()
        const get = spyOn(Session, "get").mockImplementation((async (id: Parameters<typeof Session.get>[0]) => {
          if (id === sessionID) return { id: sessionID } as never
          if (String(id).startsWith("ses_sub_task_loop_")) return { id, parentID: sessionID } as never
          throw new Error(`Unknown session ${id}`)
        }) as unknown as typeof Session.get)
        const create = spyOn(Session, "create")
          .mockResolvedValueOnce({ id: SessionID.make("ses_sub_task_loop_1") } as Awaited<
            ReturnType<typeof Session.create>
          >)
          .mockResolvedValueOnce({ id: SessionID.make("ses_sub_task_loop_2") } as Awaited<
            ReturnType<typeof Session.create>
          >)
        const msg = spyOn(MessageV2, "get").mockReturnValue({
          info: {
            role: "assistant",
            modelID: "gpt-5.2",
            providerID: "openai",
          },
        } as ReturnType<typeof MessageV2.get>)
        const parts = spyOn(SessionPrompt, "resolvePromptParts").mockResolvedValue([{ type: "text", text: "repeat" }])
        const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue({
          parts: [{ type: "text", text: "done" }],
        } as Awaited<ReturnType<typeof SessionPrompt.prompt>>)

        try {
          await tool.execute(
            {
              description: "first run",
              prompt: "repeat",
              subagent_type: "general",
            },
            {
              sessionID,
              messageID,
              agent: "build",
              abort: AbortSignal.any([]),
              messages: [],
              metadata: () => {},
              ask: async () => {},
              extra: { bypassAgentCheck: true },
            },
          )

          await expect(
            tool.execute(
              {
                description: "second run",
                prompt: "repeat",
                subagent_type: "general",
              },
              {
                sessionID,
                messageID,
                agent: "build",
                abort: AbortSignal.any([]),
                messages: [],
                metadata: () => {},
                ask: async () => {},
                extra: { bypassAgentCheck: true },
              },
            ),
          ).rejects.toThrow('Loop detected: tool "task" called 2 consecutive times with identical input')
        } finally {
          get.mockRestore()
          create.mockRestore()
          msg.mockRestore()
          parts.mockRestore()
          prompt.mockRestore()
        }
      },
    })
  })
})

// Hybrid routing unit tests (pure logic, no Effect runtime needed)
describe("tool.task hybrid routing", () => {
  const fallback: ModelRef = { providerID: "anthropic", modelID: "claude-3-5-sonnet" }
  const local: ModelRef = { providerID: "ollama", modelID: "llama3" }
  const ultrawork: ModelRef = { providerID: "openai", modelID: "o3" }

  const hybridCfg: HybridRoutingConfig = {
    enabled: true,
    threshold: 0.7,
    local_models: [local],
    verify_commands: [],
    verify_cache_ttl_ms: 300_000,
  }

  describe("resolveTaskModel precedence (flag off path)", () => {
    test("ultrawork keyword in prompt wins regardless of hybrid flag", () => {
      const result = resolveTaskModel({
        prompt: "please use ulw for this task",
        subagentType: "explore",
        categories: {},
        ultraworkModel: ultrawork,
        fallback,
      })
      expect(result).toEqual(ultrawork)
    })

    test("use_ultrawork=true wins", () => {
      const result = resolveTaskModel({
        prompt: "do some work",
        subagentType: "explore",
        useUltrawork: true,
        categories: {},
        ultraworkModel: ultrawork,
        fallback,
      })
      expect(result).toEqual(ultrawork)
    })

    test("flag off: resolveTaskModel result unchanged", () => {
      const result = resolveTaskModel({
        prompt: "do some work",
        subagentType: "explore",
        categories: {},
        fallback,
      })
      expect(result).toEqual(fallback)
    })
  })

  describe("hybrid routing precedence (flag on path)", () => {
    test("ultrawork precedence skips hybrid routing", () => {
      const result = resolveTaskModel({
        prompt: "use ultrawork for this coder task",
        subagentType: "coder",
        categories: {},
        ultraworkModel: ultrawork,
        fallback,
      })
      expect(result).toEqual(ultrawork)
    })

    test("coder with read operation → local model", () => {
      const decision = hybridRoute(
        {
          confidence: 0.9,
          info_gap: "low",
          needs_code_change: false,
          operation_type: "read",
          assumptions: [],
          ask_candidates: [],
        },
        fallback,
        hybridCfg,
        false,
      )
      expect(decision.target).toBe("local")
      expect(decision.model).toEqual(local)
    })

    test("debugger with bash_simple operation → local model", () => {
      const decision = hybridRoute(
        {
          confidence: 0.1,
          info_gap: "low",
          needs_code_change: false,
          operation_type: "bash_simple",
          assumptions: [],
          ask_candidates: [],
        },
        fallback,
        hybridCfg,
        false,
      )
      expect(decision.target).toBe("local")
      expect(decision.model).toEqual(local)
    })

    test("cheap-fix with bash_complex operation → cloud model", () => {
      const decision = hybridRoute(
        {
          confidence: 0.9,
          info_gap: "low",
          needs_code_change: false,
          operation_type: "bash_complex",
          assumptions: [],
          ask_candidates: [],
        },
        fallback,
        hybridCfg,
        false,
      )
      expect(decision.target).toBe("cloud")
      expect(decision.model).toEqual(fallback)
    })

    test("refactor with code_change operation → cloud model", () => {
      const decision = hybridRoute(
        {
          confidence: 0.9,
          info_gap: "low",
          needs_code_change: false,
          operation_type: "code_change",
          assumptions: [],
          ask_candidates: [],
        },
        fallback,
        hybridCfg,
        false,
      )
      expect(decision.target).toBe("cloud")
      expect(decision.model).toEqual(fallback)
      expect(decision.override_reason).toBe("code_change")
    })

    test("e2e-writer with preflight unavailable → cloud model", () => {
      const decision = hybridRoute(undefined, fallback, hybridCfg, false)
      expect(decision.target).toBe("cloud")
      expect(decision.model).toEqual(fallback)
      expect(decision.override_reason).toBe("preflight_unavailable")
    })

    test("explore with read operation → local model", () => {
      const decision = hybridRoute(
        {
          confidence: 0.9,
          info_gap: "low",
          needs_code_change: false,
          operation_type: "read",
          assumptions: [],
          ask_candidates: [],
        },
        fallback,
        hybridCfg,
        false,
      )
      expect(decision.target).toBe("local")
      expect(decision.model).toEqual(local)
    })
  })

  describe("tool routing hints", () => {
    test("read tools hint local class", () => {
      expect(hint("use grep and read files")).toBe("read")
    })

    test("write tools hint code_change class", () => {
      expect(hint("apply patch then write file")).toBe("code_change")
    })

    test("bash_simple command hint stays local", () => {
      expect(hint("inspect", "echo hello")).toBe("bash_simple")
    })

    test("bash_complex command hint stays cloud", () => {
      expect(hint("inspect", "bun test")).toBe("bash_complex")
    })

    test("task ask route returns clarification result", () => {
      const decision = hybridRoute(
        {
          confidence: 0.9,
          info_gap: "high",
          needs_code_change: false,
          operation_type: "other",
          assumptions: [],
          ask_candidates: ["repo path", "target file"],
        },
        fallback,
        hybridCfg,
        false,
      )
      expect(decision.target).toBe("ask")
      expect(decision.ask_text).toContain("I need more information to proceed")
    })
  })
})
