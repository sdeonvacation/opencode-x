import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { TaskTool } from "../../src/tool/task"
import { ToolRegistry } from "../../src/tool/registry"
import { Tool } from "../../src/tool/tool"
import { tmpdir } from "../fixture/fixture"
import { SessionPrompt } from "../../src/session/prompt"
import { Config } from "../../src/config/config"
import { MessageV2 } from "../../src/session/message-v2"
import { Session } from "../../src/session"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import z from "zod"

afterEach(async () => {
  await Instance.disposeAll()
})

describe("tool.task", () => {
  test("description sorts subagents by name and is stable across calls", async () => {
    await using tmp = await tmpdir({
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
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const build = await Agent.get("build")
        const first = await TaskTool.init({ agent: build })
        const second = await TaskTool.init({ agent: build })

        expect(first.description).toBe(second.description)

        const alpha = first.description.indexOf("- alpha: Alpha agent")
        const explore = first.description.indexOf("- explore:")
        const general = first.description.indexOf("- general:")
        const zebra = first.description.indexOf("- zebra: Zebra agent")

        expect(alpha).toBeGreaterThan(-1)
        expect(explore).toBeGreaterThan(alpha)
        expect(general).toBeGreaterThan(explore)
        expect(zebra).toBeGreaterThan(general)
      },
    })
  })

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
          const tool = await TaskTool.init()
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
        const tool = await TaskTool.init()

        expect(tool.description).toContain("task_category")
        expect(tool.description).toContain("use_ultrawork")
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
          const tool = await TaskTool.init()

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
        const tool = await TaskTool.init()
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

  test("batch tool uses per-tool concurrency keys", async () => {
    await using tmp = await tmpdir({
      config: {
        experimental: {
          batch_tool: true,
          model_concurrency: {
            batch: 1,
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        let activeRead = 0
        let activeBash = 0
        let maxRead = 0
        let maxBash = 0
        let overlapped = false

        const start = (tool: "read" | "bash") => {
          if (tool === "read") {
            activeRead++
            maxRead = Math.max(maxRead, activeRead)
          } else {
            activeBash++
            maxBash = Math.max(maxBash, activeBash)
          }
          if (activeRead > 0 && activeBash > 0) overlapped = true
        }

        const end = (tool: "read" | "bash") => {
          if (tool === "read") activeRead--
          else activeBash--
        }

        await ToolRegistry.register(
          Tool.define("read", async () => ({
            description: "test read",
            parameters: z.object({ label: z.string() }),
            execute: async () => {
              start("read")
              try {
                await Bun.sleep(20)
                return { title: "", output: "ok", metadata: {} }
              } finally {
                end("read")
              }
            },
          })),
        )

        await ToolRegistry.register(
          Tool.define("bash", async () => ({
            description: "test bash",
            parameters: z.object({ label: z.string() }),
            execute: async () => {
              start("bash")
              try {
                await Bun.sleep(20)
                return { title: "", output: "ok", metadata: {} }
              } finally {
                end("bash")
              }
            },
          })),
        )

        const updatePart = spyOn(Session, "updatePart").mockResolvedValue(undefined as never)

        try {
          const batch = await (await import("../../src/tool/batch")).BatchTool.init()
          await batch.execute(
            {
              tool_calls: [
                { tool: "read", parameters: { label: "r1" } },
                { tool: "read", parameters: { label: "r2" } },
                { tool: "bash", parameters: { label: "b1" } },
                { tool: "bash", parameters: { label: "b2" } },
              ],
            },
            {
              sessionID: SessionID.make("ses_batch_keys"),
              messageID: MessageID.make("msg_batch_keys"),
              callID: PartID.make("prt_batch_keys"),
              agent: "build",
              abort: AbortSignal.any([]),
              messages: [],
              metadata: () => {},
              ask: async () => {},
            },
          )

          expect(maxRead).toBe(1)
          expect(maxBash).toBe(1)
          expect(overlapped).toBe(true)
        } finally {
          updatePart.mockRestore()
        }
      },
    })
  })
})
