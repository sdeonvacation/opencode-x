import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Effect, Layer, Option, Scope, ServiceMap } from "effect"
import { Agent } from "../../src/agent/agent"
import { BackgroundJob } from "../../src/background/job"
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

// Helper: initialize TaskTool (Tool.defineEffect) for non-Effect test contexts
const initTask = () =>
  Effect.runPromise(
    Effect.flatMap(
      Effect.provide(TaskTool, Layer.mergeAll(Agent.defaultLayer, BackgroundJob.defaultLayer, Config.defaultLayer)),
      (info) => Effect.promise(() => info.init()),
    ),
  )

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    BackgroundJob.defaultLayer,
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

describe("tool.task background", () => {
  it.live("returns immediately with state:running when background=true and flag enabled", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = "true"
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* Effect.promise(() => tool.init())
        const resolve = SessionPrompt.resolvePromptParts
        const prompt = SessionPrompt.prompt
        const loop = SessionPrompt.loop

        SessionPrompt.resolvePromptParts = async (template) => [{ type: "text", text: template }]
        // prompt never resolves — background should return before it completes
        SessionPrompt.prompt = async () => new Promise(() => {})
        SessionPrompt.loop = async () => new Promise(() => {})
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            SessionPrompt.resolvePromptParts = resolve
            SessionPrompt.prompt = prompt
            SessionPrompt.loop = loop
            delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS
          }),
        )

        const result = yield* Effect.promise(() =>
          def.execute(
            {
              description: "bg task",
              prompt: "do something",
              subagent_type: "general",
              background: true,
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

        expect(result.output).toContain("state: running")
        expect(result.output).toContain("Background task")
        expect(result.output).toContain("task_id:")
      }),
    ),
  )

  it.live("falls through to sync path when flag is disabled", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS
        delete process.env.OPENCODE_EXPERIMENTAL
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* Effect.promise(() => tool.init())
        const resolve = SessionPrompt.resolvePromptParts
        const prompt = SessionPrompt.prompt

        SessionPrompt.resolvePromptParts = async (template) => [{ type: "text", text: template }]
        SessionPrompt.prompt = async (input) => reply(input, "sync result")
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            SessionPrompt.resolvePromptParts = resolve
            SessionPrompt.prompt = prompt
          }),
        )

        const result = yield* Effect.promise(() =>
          def.execute(
            {
              description: "sync task",
              prompt: "do something",
              subagent_type: "general",
              background: true,
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

        // sync path returns task_result with actual output
        expect(result.output).toContain("<task_result>")
        expect(result.output).toContain("sync result")
        expect(result.output).not.toContain("state: running")
      }),
    ),
  )

  it.live("injects result and publishes toast when background job completes", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = "true"
        const { chat, assistant } = yield* seed()
        const tool = yield* TaskTool
        const def = yield* Effect.promise(() => tool.init())
        const resolve = SessionPrompt.resolvePromptParts
        const prompt = SessionPrompt.prompt
        const loop = SessionPrompt.loop

        const injected: Parameters<typeof SessionPrompt.prompt>[0][] = []
        const loopCalls: Parameters<typeof SessionPrompt.loop>[0][] = []

        SessionPrompt.resolvePromptParts = async (template) => [{ type: "text", text: template }]
        // First call = background subagent run, subsequent calls = inject result
        let callCount = 0
        SessionPrompt.prompt = async (input) => {
          callCount++
          if (callCount === 1) return reply(input, "background output")
          injected.push(input)
          return reply(input, "")
        }
        SessionPrompt.loop = async (input) => {
          loopCalls.push(input)
          return reply({ sessionID: input.sessionID, parts: [] }, "")
        }
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            SessionPrompt.resolvePromptParts = resolve
            SessionPrompt.prompt = prompt
            SessionPrompt.loop = loop
            delete process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS
          }),
        )

        yield* Effect.promise(() =>
          def.execute(
            {
              description: "bg complete",
              prompt: "do something",
              subagent_type: "general",
              background: true,
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

        // Wait for background job to complete and inject result
        yield* Effect.sleep("500 millis")

        // Result should have been injected into parent session
        expect(injected.length).toBeGreaterThan(0)
        const injectedPart = injected[0]?.parts?.[0]
        expect(injectedPart?.type).toBe("text")
        if (injectedPart?.type === "text") {
          expect(injectedPart.text).toContain("background output")
          expect(injectedPart.text).toContain("<task_result>")
        }

        // Loop should have been called to resume parent session
        expect(loopCalls.length).toBeGreaterThan(0)
        expect(loopCalls[0]?.sessionID).toBe(chat.id)
      }),
    ),
  )
})

describe("tool.task background scope fix", () => {
  // Regression test: BackgroundJob.Service methods (get/start) require Scope.Scope
  // internally via ScopedCache. When called from async context via Effect.runPromise,
  // the scope must be explicitly provided — otherwise "Service not found: effect/Scope".
  it.live("BackgroundJob.Service.get works from async context when scope is provided", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        // Capture scope from current fiber (same pattern used in TaskTool)
        let scope: Scope.Scope | undefined
        yield* Effect.withFiber((fiber) => {
          const opt = ServiceMap.getOption(fiber.services, Scope.Scope)
          if (Option.isSome(opt)) scope = opt.value
          return Effect.void
        })
        expect(scope).toBeDefined()
        // jobs.get without scope → throws "Service not found: effect/Scope"
        // jobs.get with scope → succeeds
        const result = yield* Effect.promise(() =>
          Effect.runPromise(jobs.get("nonexistent-id").pipe(Effect.provideService(Scope.Scope, scope!))),
        )
        expect(result).toBeUndefined()
      }),
    ),
  )

  it.live("BackgroundJob.Service.start works from async context when scope is provided", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const jobs = yield* BackgroundJob.Service
        let scope: Scope.Scope | undefined
        yield* Effect.withFiber((fiber) => {
          const opt = ServiceMap.getOption(fiber.services, Scope.Scope)
          if (Option.isSome(opt)) scope = opt.value
          return Effect.void
        })
        expect(scope).toBeDefined()
        // start a job that resolves immediately
        const info = yield* Effect.promise(() =>
          Effect.runPromise(
            jobs
              .start({
                id: "test-scope-job",
                type: "test",
                title: "scope test",
                run: Effect.succeed("done"),
              })
              .pipe(Effect.provideService(Scope.Scope, scope!)),
          ),
        )
        expect(info.id).toBe("test-scope-job")
        expect(info.status).toBe("running")
      }),
    ),
  )

  it.live("TaskTool scope is captured via withFiber and is defined", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        // Verify that when TaskTool is initialized inside a Layer.effect context,
        // the scope captured via withFiber is defined and open.
        const tool = yield* TaskTool
        // If scope capture failed, background execute would throw on jobs.get/start.
        // We verify the tool initializes without error (scope capture is in init).
        expect(tool).toBeDefined()
        expect(typeof tool.init).toBe("function")
      }),
    ),
  )
})
