import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { TaskTool } from "../../src/tool/task"
import { tmpdir } from "../fixture/fixture"
import { SessionPrompt } from "../../src/session/prompt"
import { Config } from "../../src/config/config"
import { MessageV2 } from "../../src/session/message-v2"
import { Session } from "../../src/session"
import { MessageID, SessionID } from "../../src/session/schema"

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
          create.mockRestore()
          msg.mockRestore()
          parts.mockRestore()
          prompt.mockRestore()
        }
      },
    })
  })
})
