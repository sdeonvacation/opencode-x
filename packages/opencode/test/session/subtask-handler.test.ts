import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Fiber } from "effect"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod"

import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { ProjectID } from "../../src/project/schema"
import { Provider } from "../../src/provider/provider"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { handleSubtask, type HandleSubtaskDeps } from "../../src/session/subtask-handler"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { TaskTool } from "../../src/tool/task"
import { Tool } from "../../src/tool/tool"
import { tmpdir } from "../fixture/fixture"

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const model: Provider.Model = {
  id: ModelID.make("resolved-model"),
  providerID: ProviderID.make("test"),
  api: { id: "resolved-model", url: "http://localhost", npm: "test" },
  name: "Resolved Model",
  capabilities: {
    temperature: false,
    reasoning: false,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 10000, output: 1000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2025-01-01",
}

function makeSession(): Session.Info {
  return {
    id: SessionID.make("session_test"),
    slug: "subtask",
    projectID: ProjectID.make("project_test"),
    directory: "/tmp",
    title: "Test",
    version: "1",
    time: { created: 1, updated: 1 },
  }
}

function makeLastUser(sessionID: SessionID): MessageV2.User {
  return {
    id: MessageID.ascending(),
    sessionID,
    role: "user",
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  }
}

function makeTask(sessionID: SessionID, overrides?: Partial<MessageV2.SubtaskPart>): MessageV2.SubtaskPart {
  return {
    id: PartID.ascending(),
    messageID: MessageID.ascending(),
    sessionID,
    type: "subtask",
    prompt: "inspect cache path",
    description: "inspect bug",
    agent: "general",
    ...overrides,
  }
}

type TriggerCall = { name: string; input: unknown; output: unknown }
type BusCall = {
  type: string
  properties: { sessionID?: SessionID; error?: NonNullable<MessageV2.Assistant["error"]> }
}
type RetryCall = Extract<SessionStatus.Info, { type: "retry" }>
type AskCall = Parameters<HandleSubtaskDeps["permission"]["ask"]>[0]
type TaskResult = Awaited<ReturnType<Tool.InferDef<typeof TaskTool>["execute"]>>
type TaskExecute = Tool.InferDef<typeof TaskTool>["execute"]
type AgentStub = Agent.Info
const taskMetadata = {
  sessionId: SessionID.make("child-session"),
  model: {
    providerID: String(model.providerID),
    modelID: String(model.id),
  },
}
const agentList: Agent.Info[] = [
  { name: "build", permission: [], hidden: false, mode: "primary", options: {} },
  { name: "general", permission: [], hidden: false, mode: "subagent", options: {} },
]

function createHarness(overrides?: {
  execute?: (...args: Parameters<TaskExecute>) => ReturnType<TaskExecute>
  agent?: AgentStub | undefined
}) {
  const messages = new Map<string, MessageV2.Info>()
  const parts = new Map<string, MessageV2.Part>()
  const events: BusCall[] = []
  const triggers: TriggerCall[] = []
  const retries: RetryCall[] = []
  const ask: AskCall[] = []
  const resolved: { providerID: ProviderID; modelID: ModelID; sessionID: SessionID }[] = []
  const taskAgent =
    overrides && "agent" in overrides
      ? overrides.agent
      : ({
          name: "general",
          permission: [],
          hidden: false,
          mode: "subagent",
          options: {},
        } satisfies AgentStub)

  const taskDef: Tool.InferDef<typeof TaskTool> = {
    id: TaskTool.id,
    description: "",
    parameters: z.object({}) as Tool.InferDef<typeof TaskTool>["parameters"],
    execute: async (args, ctx) => {
      if (overrides?.execute) return overrides.execute(args, ctx)
      return {
        title: "done",
        metadata: taskMetadata,
        output: "finished",
      }
    },
  }

  const deps: HandleSubtaskDeps = {
    sessions: {
      updateMessage(msg) {
        messages.set(msg.id, msg)
        return Effect.succeed(msg)
      },
      updatePart(part) {
        parts.set(part.id, part)
        return Effect.succeed(part)
      },
    },
    agents: {
      get: (name) => Effect.succeed(taskAgent && taskAgent.name === name ? taskAgent : undefined),
      list: () => Effect.succeed(agentList),
    },
    registry: {
      named: {
        task: () => Effect.succeed(taskDef),
        read: () => Effect.die("unused"),
      },
    },
    plugin: {
      trigger: (name, input, output) => {
        triggers.push({ name, input, output })
        return Effect.succeed(output)
      },
    },
    permission: {
      ask: (input) => {
        ask.push(input)
        return Effect.void
      },
    },
    bus: {
      publish: (def, properties) => {
        events.push({ type: def.type, properties: properties as BusCall["properties"] })
        return Effect.void
      },
    },
    status: {
      set: (_sessionID, info) => {
        if (info.type === "retry") retries.push(info)
        return Effect.void
      },
    },
    getModel: (providerID, modelID, sessionID) => {
      resolved.push({ providerID, modelID, sessionID })
      return Effect.succeed(model)
    },
  }

  return { deps, messages, parts, events, triggers, retries, ask, resolved }
}

async function runInInstance<T>(fn: () => Promise<T>) {
  await using tmp = await tmpdir({ git: true })
  return Instance.provide({ directory: tmp.path, fn })
}

test("handleSubtask completes task and records completed tool state", async () => {
  await runInInstance(async () => {
    const session = makeSession()
    const lastUser = makeLastUser(session.id)
    const task = makeTask(session.id, {
      model: { providerID: ProviderID.make("override"), modelID: ModelID.make("override-model") },
    })
    const harness = createHarness()

    await Effect.runPromise(
      handleSubtask(harness.deps, { task, model, lastUser, sessionID: session.id, session, msgs: [] }),
    )

    expect(harness.resolved).toHaveLength(1)
    const tool = [...harness.parts.values()].find((part): part is MessageV2.ToolPart => part.type === "tool")
    expect(tool?.state.status).toBe("completed")
    if (!tool || tool.state.status !== "completed") return
    expect(tool.state.title).toBe("done")
    expect(tool.state.output).toBe("finished")
    expect(harness.triggers.map((item) => item.name)).toEqual(["tool.execute.before", "tool.execute.after"])
  })
})

test("handleSubtask throws NamedError when agent is missing and publishes session error", async () => {
  await runInInstance(async () => {
    const session = makeSession()
    const lastUser = makeLastUser(session.id)
    const task = makeTask(session.id)
    const harness = createHarness({ agent: undefined })

    const exit = await Effect.runPromise(
      handleSubtask(harness.deps, { task, model, lastUser, sessionID: session.id, session, msgs: [] }).pipe(
        Effect.exit,
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) return
    const err = Cause.squash(exit.cause)
    expect(NamedError.Unknown.isInstance(err)).toBe(true)
    expect(harness.events).toHaveLength(1)
    expect(harness.events[0].type).toBe(Session.Event.Error.type)
    expect(harness.events[0].properties.error).toBeDefined()
    expect(harness.events[0].properties.error?.name).toBe("UnknownError")
    const message =
      harness.events[0].properties.error?.name === "UnknownError"
        ? harness.events[0].properties.error.data.message
        : undefined
    expect(typeof message).toBe("string")
    if (typeof message !== "string") return
    expect(message).toContain('Agent not found: "general"')
  })
})

test("handleSubtask preserves metadata when task execution fails", async () => {
  await runInInstance(async () => {
    const session = makeSession()
    const lastUser = makeLastUser(session.id)
    const task = makeTask(session.id)
    const harness = createHarness({
      execute: async (_args, ctx) => {
        ctx.metadata({ metadata: taskMetadata })
        throw new Error("boom")
      },
    })

    await Effect.runPromise(
      handleSubtask(harness.deps, { task, model, lastUser, sessionID: session.id, session, msgs: [] }),
    )

    const tool = [...harness.parts.values()].find((part): part is MessageV2.ToolPart => part.type === "tool")
    expect(tool?.state.status).toBe("error")
    if (!tool || tool.state.status !== "error") return
    expect(tool.state.error).toContain("Tool execution failed: boom")
    expect(tool.state.metadata).toEqual(taskMetadata)
  })
})

test("handleSubtask adds summary user message for command subtasks", async () => {
  await runInInstance(async () => {
    const session = makeSession()
    const lastUser = makeLastUser(session.id)
    const task = makeTask(session.id, { command: "run build" })
    const harness = createHarness()

    await Effect.runPromise(
      handleSubtask(harness.deps, { task, model, lastUser, sessionID: session.id, session, msgs: [] }),
    )

    const summary = [...harness.messages.values()].find(
      (msg): msg is MessageV2.User => msg.role === "user" && msg.id !== lastUser.id,
    )
    expect(summary).toBeDefined()
    const text = [...harness.parts.values()].find(
      (part): part is MessageV2.TextPart => part.type === "text" && part.messageID === summary?.id,
    )
    expect(text?.text).toBe("Summarize the task tool output above and continue with your task.")
    expect(text?.synthetic).toBe(true)
  })
})

test("handleSubtask marks running tool as cancelled on interrupt", async () => {
  await runInInstance(async () => {
    const session = makeSession()
    const lastUser = makeLastUser(session.id)
    const task = makeTask(session.id)
    let ready!: () => void
    const wait = new Promise<void>((resolve) => {
      ready = resolve
    })
    const harness = createHarness({
      execute: async (_args, ctx) => {
        ctx.abort.addEventListener("abort", () => {}, { once: true })
        ready()
        return await new Promise<TaskResult>(() => {})
      },
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* handleSubtask(harness.deps, {
          task,
          model,
          lastUser,
          sessionID: session.id,
          session,
          msgs: [],
        }).pipe(Effect.forkChild)
        yield* Effect.promise(() => wait)
        yield* Fiber.interrupt(fiber)
      }),
    )

    const tool = [...harness.parts.values()].find((part): part is MessageV2.ToolPart => part.type === "tool")
    expect(tool?.state.status).toBe("error")
    if (!tool || tool.state.status !== "error") return
    expect(tool.state.error).toBe("Cancelled")
    const assistant = [...harness.messages.values()].find((msg): msg is MessageV2.Assistant => msg.role === "assistant")
    expect(assistant?.finish).toBe("tool-calls")
    expect(assistant?.time.completed).toBeDefined()
  })
})
