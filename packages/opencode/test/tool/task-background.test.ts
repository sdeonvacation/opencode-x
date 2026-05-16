import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Config } from "../../src/config/config"
import { Flag } from "../../src/flag/flag"
import { TaskTool, parameters, type TaskPromptOps } from "../../src/tool/task"
import { tmpdir } from "../fixture/fixture"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"

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

const originalFlag = Flag.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS

afterEach(() => {
  // @ts-expect-error override readonly flag for testing
  Flag.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = originalFlag
})

describe("tool.task background", () => {
  test("parameters schema includes background field when flag enabled", async () => {
    // @ts-expect-error override readonly flag for testing
    Flag.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = true

    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await initTask()
        expect(tool.parameters.shape).toHaveProperty("background")
      },
    })
  })

  test("parameters schema excludes background field when flag disabled", async () => {
    // @ts-expect-error override readonly flag for testing
    Flag.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = false

    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await initTask()
        expect(tool.parameters.shape).not.toHaveProperty("background")
      },
    })
  })

  test("background=true throws when flag is disabled", async () => {
    // @ts-expect-error override readonly flag for testing
    Flag.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = false

    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sessionID = SessionID.make("ses_bg_disabled")
        const messageID = MessageID.make("msg_bg_disabled")

        const get = spyOn(Session, "get").mockResolvedValue({ id: sessionID } as any)
        const create = spyOn(Session, "create").mockResolvedValue({ id: SessionID.make("ses_sub_bg") } as any)
        const msg = spyOn(MessageV2, "get").mockReturnValue({
          info: { role: "assistant", modelID: ref.modelID, providerID: ref.providerID },
        } as any)
        const parts = spyOn(SessionPrompt, "resolvePromptParts").mockResolvedValue([{ type: "text", text: "work" }])

        try {
          const tool = await initTask()
          await expect(
            tool.execute(
              {
                description: "bg task",
                prompt: "do work",
                subagent_type: "general",
                background: true,
              },
              {
                sessionID,
                messageID,
                agent: "build",
                abort: new AbortController().signal,
                messages: [],
                metadata: () => {},
                ask: async () => {},
                extra: { bypassAgentCheck: true },
              },
            ),
          ).rejects.toThrow("Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true")
        } finally {
          get.mockRestore()
          create.mockRestore()
          msg.mockRestore()
          parts.mockRestore()
        }
      },
    })
  })

  test("background=true no longer requires promptOps", async () => {
    // After simplification, background tasks don't need promptOps
    // They just emit events and show toasts on completion
    // @ts-expect-error override readonly flag for testing
    Flag.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = true

    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sessionID = SessionID.make("ses_bg_noops")
        const messageID = MessageID.make("msg_bg_noops")
        const childID = SessionID.make("ses_sub_noops")

        const get = spyOn(Session, "get").mockResolvedValue({ id: sessionID } as any)
        const create = spyOn(Session, "create").mockResolvedValue({ id: childID } as any)
        const msg = spyOn(MessageV2, "get").mockReturnValue({
          info: { role: "assistant", modelID: ref.modelID, providerID: ref.providerID },
        } as any)
        const parts = spyOn(SessionPrompt, "resolvePromptParts").mockResolvedValue([{ type: "text", text: "work" }])

        try {
          const tool = await initTask()
          // Should not throw about missing promptOps — it proceeds to bgRuntime
          // which will fail for other reasons in test env, but not the ops guard
          const result = await tool
            .execute(
              {
                description: "bg task",
                prompt: "do work",
                subagent_type: "general",
                background: true,
              },
              {
                sessionID,
                messageID,
                agent: "build",
                abort: new AbortController().signal,
                messages: [],
                metadata: () => {},
                ask: async () => {},
                extra: { bypassAgentCheck: true },
              },
            )
            .catch((err: Error) => {
              // Should NOT be the old promptOps error
              expect(err.message).not.toContain("TaskTool requires promptOps")
              return null
            })
        } finally {
          get.mockRestore()
          create.mockRestore()
          msg.mockRestore()
          parts.mockRestore()
        }
      },
    })
  })

  test("foreground path still works with background=false", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sessionID = SessionID.make("ses_fg_test")
        const messageID = MessageID.make("msg_fg_test")
        const childID = SessionID.make("ses_sub_fg")

        const get = spyOn(Session, "get").mockImplementation((async (id: any) => {
          if (id === sessionID) return { id: sessionID } as never
          if (id === childID) return { id: childID, parentID: sessionID } as never
          throw new Error(`Unknown session ${id}`)
        }) as any)
        const create = spyOn(Session, "create").mockResolvedValue({ id: childID } as any)
        const msg = spyOn(MessageV2, "get").mockReturnValue({
          info: { role: "assistant", modelID: ref.modelID, providerID: ref.providerID },
        } as any)
        const parts = spyOn(SessionPrompt, "resolvePromptParts").mockResolvedValue([{ type: "text", text: "work" }])
        const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue({
          parts: [{ type: "text", text: "foreground result" }],
        } as any)

        try {
          const tool = await initTask()
          const result = await tool.execute(
            {
              description: "fg task",
              prompt: "do work",
              subagent_type: "general",
              background: false,
            },
            {
              sessionID,
              messageID,
              agent: "build",
              abort: new AbortController().signal,
              messages: [],
              metadata: () => {},
              ask: async () => {},
              extra: { bypassAgentCheck: true },
            },
          )

          expect(result.output).toContain("foreground result")
          expect(result.output).toContain("<task_result>")
          expect(result.output).toContain(`task_id: ${childID}`)
          expect(result.metadata.sessionId).toBe(childID)
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

  test("exported parameters schema has background field", () => {
    expect(parameters.shape).toHaveProperty("background")
    expect(parameters.shape).toHaveProperty("description")
    expect(parameters.shape).toHaveProperty("prompt")
    expect(parameters.shape).toHaveProperty("subagent_type")
    expect(parameters.shape).toHaveProperty("task_category")
    expect(parameters.shape).toHaveProperty("use_ultrawork")
    expect(parameters.shape).toHaveProperty("task_id")
    expect(parameters.shape).toHaveProperty("command")
  })

  test("TaskPromptOps interface is exported", async () => {
    // Verify the interface shape by creating a conforming object
    const ops: TaskPromptOps = {
      cancel: () => {},
      resolvePromptParts: async () => [],
      prompt: async () => ({ info: {} as any, parts: [] }),
      loop: async () => ({ info: {} as any, parts: [] }),
    }
    expect(ops.cancel).toBeFunction()
    expect(ops.resolvePromptParts).toBeFunction()
    expect(ops.prompt).toBeFunction()
    expect(ops.loop).toBeFunction()
  })

  test("metadata includes background:true when background param set", async () => {
    // @ts-expect-error override readonly flag for testing
    Flag.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = true

    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sessionID = SessionID.make("ses_bg_meta")
        const messageID = MessageID.make("msg_bg_meta")
        const childID = SessionID.make("ses_sub_meta")

        const get = spyOn(Session, "get").mockResolvedValue({ id: sessionID } as any)
        const create = spyOn(Session, "create").mockResolvedValue({ id: childID } as any)
        const msg = spyOn(MessageV2, "get").mockReturnValue({
          info: { role: "assistant", modelID: ref.modelID, providerID: ref.providerID },
        } as any)
        const parts = spyOn(SessionPrompt, "resolvePromptParts").mockResolvedValue([{ type: "text", text: "work" }])

        let captured: any
        try {
          const tool = await initTask()
          // This will proceed to bgRuntime which may fail in test env, but metadata is set before that
          await tool
            .execute(
              {
                description: "bg meta test",
                prompt: "do work",
                subagent_type: "general",
                background: true,
              },
              {
                sessionID,
                messageID,
                agent: "build",
                abort: new AbortController().signal,
                messages: [],
                metadata: (input: any) => {
                  captured = input
                },
                ask: async () => {},
                extra: { bypassAgentCheck: true },
              },
            )
            .catch(() => {})

          expect(captured?.metadata?.background).toBe(true)
        } finally {
          get.mockRestore()
          create.mockRestore()
          msg.mockRestore()
          parts.mockRestore()
        }
      },
    })
  })

  test("foreground metadata does not include background field", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const sessionID = SessionID.make("ses_fg_meta")
        const messageID = MessageID.make("msg_fg_meta")
        const childID = SessionID.make("ses_sub_fg_meta")

        const get = spyOn(Session, "get").mockImplementation((async (id: any) => {
          if (id === sessionID) return { id: sessionID } as never
          if (id === childID) return { id: childID, parentID: sessionID } as never
          throw new Error(`Unknown session ${id}`)
        }) as any)
        const create = spyOn(Session, "create").mockResolvedValue({ id: childID } as any)
        const msg = spyOn(MessageV2, "get").mockReturnValue({
          info: { role: "assistant", modelID: ref.modelID, providerID: ref.providerID },
        } as any)
        const parts = spyOn(SessionPrompt, "resolvePromptParts").mockResolvedValue([{ type: "text", text: "work" }])
        const prompt = spyOn(SessionPrompt, "prompt").mockResolvedValue({
          parts: [{ type: "text", text: "done" }],
        } as any)

        let captured: any
        try {
          const tool = await initTask()
          await tool.execute(
            {
              description: "fg meta test",
              prompt: "do work",
              subagent_type: "general",
            },
            {
              sessionID,
              messageID,
              agent: "build",
              abort: new AbortController().signal,
              messages: [],
              metadata: (input: any) => {
                captured = input
              },
              ask: async () => {},
              extra: { bypassAgentCheck: true },
            },
          )

          expect(captured?.metadata?.background).toBeUndefined()
          expect(captured?.metadata?.sessionId).toBe(childID)
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
