import { afterEach, afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import { Permission } from "../../src/permission"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, SessionID } from "../../src/session/schema"
import { TaskTool } from "../../src/tool/task"
import { tmpdir } from "../fixture/fixture"

// Isolate from ambient OPENCODE_PERMISSION (e.g. set in dev shell).
let prevEnvPermission: string | undefined
beforeAll(() => {
  prevEnvPermission = process.env.OPENCODE_PERMISSION
  delete process.env.OPENCODE_PERMISSION
})
afterAll(() => {
  if (prevEnvPermission === undefined) delete process.env.OPENCODE_PERMISSION
  else process.env.OPENCODE_PERMISSION = prevEnvPermission
})

afterEach(async () => {
  await Instance.disposeAll()
})

describe("tool.task parallel parity", () => {
  test("launches the requested subagent through SessionPrompt.prompt", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          parallel: {
            mode: "subagent",
            permission: {
              "*": "deny",
              grep: "allow",
              glob: "allow",
            },
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sessionID = SessionID.make("ses_task_parallel")
        const messageID = MessageID.make("msg_task_parallel")
        const subtaskID = SessionID.make("ses_sub_task_parallel")

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
            modelID: ModelID.make("gpt-5.2"),
            providerID: ProviderID.openai,
          },
        } as ReturnType<typeof MessageV2.get>)
        const parts = spyOn(SessionPrompt, "resolvePromptParts").mockResolvedValue([{ type: "text", text: "inspect" }])
        const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue({
          parts: [{ type: "text", text: "done" }],
        } as Awaited<ReturnType<typeof SessionPrompt.prompt>>)

        try {
          const toolInfo = await Effect.runPromise(
            TaskTool.pipe(Effect.provide(Layer.mergeAll(Agent.defaultLayer, Config.defaultLayer))),
          )
          const tool = await toolInfo.init()
          await tool.execute(
            {
              description: "delegate inspect",
              prompt: "inspect",
              subagent_type: "parallel",
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

          const input = prompt.mock.calls[0]?.[0]
          expect(input?.agent).toBe("parallel")
          expect(input?.sessionID).toBe(subtaskID)
          expect(input?.tools).toEqual({ task: false, todowrite: false, goal_complete: false })
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

  test("propagates parallel execution into subagent via task tool", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          parallel: {
            mode: "subagent",
            parallelToolCalls: true,
            permission: {
              "*": "deny",
              grep: "allow",
              glob: "allow",
            },
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sessionID = SessionID.make("ses_task_parallel_propagation")
        const messageID = MessageID.make("msg_task_parallel_propagation")
        const subtaskID = SessionID.make("ses_sub_task_parallel_propagation")

        const parallel = await Agent.get("parallel")
        expect(parallel?.mode).toBe("subagent")
        expect(parallel?.parallelToolCalls).toBe(true)
        expect(Permission.evaluate("grep", "*", parallel!.permission).action).toBe("allow")
        expect(Permission.evaluate("glob", "*", parallel!.permission).action).toBe("allow")
        expect(Permission.evaluate("bash", "*", parallel!.permission).action).toBe("deny")

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
            modelID: ModelID.make("gpt-5.2"),
            providerID: ProviderID.openai,
          },
        } as ReturnType<typeof MessageV2.get>)
        const parts = spyOn(SessionPrompt, "resolvePromptParts").mockResolvedValue([{ type: "text", text: "inspect" }])
        const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue({
          parts: [{ type: "text", text: "done" }],
        } as Awaited<ReturnType<typeof SessionPrompt.prompt>>)

        try {
          const toolInfo = await Effect.runPromise(
            TaskTool.pipe(Effect.provide(Layer.mergeAll(Agent.defaultLayer, Config.defaultLayer))),
          )
          const tool = await toolInfo.init()
          await tool.execute(
            {
              description: "delegate inspect",
              prompt: "inspect",
              subagent_type: "parallel",
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

          const input = prompt.mock.calls[0]?.[0]
          expect(input?.agent).toBe(parallel?.name)
          expect(input?.sessionID).toBe(subtaskID)
          expect(input?.tools).toEqual({ task: false, todowrite: false, goal_complete: false })
          expect(input?.model).toEqual({
            providerID: ProviderID.openai,
            modelID: ModelID.make("gpt-5.2"),
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
})
