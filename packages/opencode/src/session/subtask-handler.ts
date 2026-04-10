import { NamedError } from "@opencode-ai/util/error"
import { Effect } from "effect"
import { ulid } from "ulid"

import { Agent } from "../agent/agent"
import { Bus } from "../bus"
import { InstanceState } from "../effect/instance-state"
import { Permission } from "../permission"
import { Plugin } from "../plugin"
import { Provider } from "../provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { ToolRegistry } from "../tool/registry"
import { TaskTool } from "../tool/task"
import { Log } from "../util/log"
import { Session } from "."
import { MessageV2 } from "./message-v2"
import { SessionRetry } from "./retry"
import { MessageID, PartID, SessionID } from "./schema"
import { SessionStatus } from "./status"

const log = Log.create({ service: "session.prompt" })

export type HandleSubtaskInput = {
  task: MessageV2.SubtaskPart
  model: Provider.Model
  lastUser: MessageV2.User
  sessionID: SessionID
  session: Session.Info
  msgs: MessageV2.WithParts[]
}

export type HandleSubtaskDeps = {
  sessions: Pick<Session.Interface, "updateMessage" | "updatePart">
  agents: {
    get: (agent: string) => Effect.Effect<Agent.Info | undefined>
    list: () => Effect.Effect<Agent.Info[]>
  }
  registry: {
    named: Pick<ToolRegistry.Interface["named"], "task">
  }
  plugin: Pick<Plugin.Interface, "trigger">
  permission: Pick<Permission.Interface, "ask">
  bus: Pick<Bus.Interface, "publish">
  status: Pick<SessionStatus.Interface, "set">
  getModel: (providerID: ProviderID, modelID: ModelID, sessionID: SessionID) => Effect.Effect<Provider.Model>
}

export const handleSubtask = Effect.fn("SessionPrompt.handleSubtask")(function* (
  deps: HandleSubtaskDeps,
  input: HandleSubtaskInput,
) {
  const { task, model, lastUser, sessionID, session, msgs } = input
  const ctx = yield* InstanceState.context
  const taskTool = yield* deps.registry.named.task()
  const taskModel = task.model ? yield* deps.getModel(task.model.providerID, task.model.modelID, sessionID) : model
  const assistantMessage: MessageV2.Assistant = yield* deps.sessions.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    parentID: lastUser.id,
    sessionID,
    mode: task.agent,
    agent: task.agent,
    variant: lastUser.model.variant,
    path: { cwd: ctx.directory, root: ctx.worktree },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: taskModel.id,
    providerID: taskModel.providerID,
    time: { created: Date.now() },
  })
  let part: MessageV2.ToolPart = yield* deps.sessions.updatePart({
    id: PartID.ascending(),
    messageID: assistantMessage.id,
    sessionID: assistantMessage.sessionID,
    type: "tool",
    callID: ulid(),
    tool: TaskTool.id,
    state: {
      status: "running",
      input: {
        prompt: task.prompt,
        description: task.description,
        subagent_type: task.agent,
        command: task.command,
      },
      time: { start: Date.now() },
    },
  })
  const taskArgs = {
    prompt: task.prompt,
    description: task.description,
    subagent_type: task.agent,
    command: task.command,
  }
  yield* deps.plugin.trigger(
    "tool.execute.before",
    { tool: TaskTool.id, sessionID, callID: part.callID },
    { args: taskArgs },
  )

  const taskAgent = yield* deps.agents.get(task.agent)
  if (!taskAgent) {
    const available = (yield* deps.agents.list()).filter((a) => !a.hidden).map((a) => a.name)
    const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
    const error = new NamedError.Unknown({ message: `Agent not found: "${task.agent}".${hint}` })
    yield* deps.bus.publish(Session.Event.Error, { sessionID, error: error.toObject() })
    throw error
  }

  type TaskResult = Awaited<ReturnType<typeof taskTool.execute>>

  let error: Error | undefined
  const result: TaskResult | undefined = yield* Effect.tryPromise({
    try: (signal) =>
      taskTool.execute(taskArgs, {
        agent: task.agent,
        messageID: assistantMessage.id,
        sessionID,
        abort: signal,
        callID: part.callID,
        extra: { bypassAgentCheck: true },
        messages: msgs,
        metadata(val: { title?: string; metadata?: Record<string, any> }) {
          return Effect.runPromise(
            Effect.gen(function* () {
              part = yield* deps.sessions.updatePart({
                ...part,
                type: "tool",
                state: { ...part.state, ...val },
              } satisfies MessageV2.ToolPart)
            }),
          )
        },
        ask(req: any) {
          return Effect.runPromise(
            deps.permission.ask({
              ...req,
              sessionID,
              ruleset: Permission.merge(taskAgent.permission, session.permission ?? []),
            }),
          )
        },
      }),
    catch: (e) => e,
  }).pipe(
    Effect.retry(
      SessionRetry.policy({
        parse: (e) => MessageV2.fromError(e, { providerID: taskModel.providerID }),
        set: (info) =>
          deps.status.set(sessionID, {
            type: "retry",
            attempt: info.attempt,
            message: info.message,
            next: info.next,
          }),
      }),
    ),
    Effect.catch((e) => {
      error = e instanceof Error ? e : new Error(String(e))
      log.error("subtask execution failed", { error, agent: task.agent, description: task.description })
      return Effect.succeed(undefined as TaskResult | undefined)
    }),
    Effect.onInterrupt(() =>
      Effect.gen(function* () {
        assistantMessage.finish = "tool-calls"
        assistantMessage.time.completed = Date.now()
        yield* deps.sessions.updateMessage(assistantMessage)
        if (part.state.status === "running") {
          yield* deps.sessions.updatePart({
            ...part,
            state: {
              status: "error",
              error: "Cancelled",
              time: { start: part.state.time.start, end: Date.now() },
              metadata: part.state.metadata,
              input: part.state.input,
            },
          } satisfies MessageV2.ToolPart)
        }
      }),
    ),
  )

  const attachments = result?.attachments?.map((attachment) => ({
    ...attachment,
    id: PartID.ascending(),
    sessionID,
    messageID: assistantMessage.id,
  }))

  if (result) {
    yield* deps.plugin.trigger(
      "tool.execute.after",
      { tool: TaskTool.id, sessionID, callID: part.callID, args: taskArgs },
      result,
    )
  }

  assistantMessage.finish = "tool-calls"
  assistantMessage.time.completed = Date.now()
  yield* deps.sessions.updateMessage(assistantMessage)

  if (result && part.state.status === "running") {
    yield* deps.sessions.updatePart({
      ...part,
      state: {
        status: "completed",
        input: part.state.input,
        title: result.title,
        metadata: result.metadata,
        output: result.output,
        attachments,
        time: { ...part.state.time, end: Date.now() },
      },
    } satisfies MessageV2.ToolPart)
  }

  if (!result) {
    yield* deps.sessions.updatePart({
      ...part,
      state: {
        status: "error",
        error: error ? `Tool execution failed: ${error.message}` : "Tool execution failed",
        time: {
          start: part.state.status === "running" ? part.state.time.start : Date.now(),
          end: Date.now(),
        },
        metadata: part.state.status === "pending" ? undefined : part.state.metadata,
        input: part.state.input,
      },
    } satisfies MessageV2.ToolPart)
  }

  if (!task.command) return

  const summaryUserMsg: MessageV2.User = {
    id: MessageID.ascending(),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: lastUser.agent,
    model: lastUser.model,
  }
  yield* deps.sessions.updateMessage(summaryUserMsg)
  yield* deps.sessions.updatePart({
    id: PartID.ascending(),
    messageID: summaryUserMsg.id,
    sessionID,
    type: "text",
    text: "Summarize the task tool output above and continue with your task.",
    synthetic: true,
  } satisfies MessageV2.TextPart)
})
