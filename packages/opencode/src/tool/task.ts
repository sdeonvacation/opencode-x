import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Effect } from "effect"
import { Session } from "../session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { Bus } from "../bus"
import { ModelID, ProviderID } from "../provider/schema"
import { SessionPrompt } from "../session/prompt"
import { Config } from "../config/config"
import { acquire, release } from "../orchestration/concurrency"
import { OrchestrationEvent } from "../orchestration/events"
import { create as createGuard } from "../orchestration/tool-guard"
import { Permission } from "@/permission"
import { withTimeout } from "@/util/timeout"
import { spawnSubagent } from "../orchestration/task-spawn"
import { resolveTaskModel } from "../orchestration/task-model-resolver"

const SUBAGENT_TIMEOUT = 900_000
const id = "task"
const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
  task_category: z.string().describe("Optional routing category hint for selecting the task model").optional(),
  use_ultrawork: z
    .boolean()
    .describe("Set true to explicitly route this task to the configured ultrawork model")
    .optional(),
  task_id: z
    .string()
    .describe(
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
    )
    .optional(),
  command: z.string().describe("The command that triggered this task").optional(),
})

async function executeTask(params: z.infer<typeof parameters>, ctx: Tool.Context) {
  const cfg = await Config.get()
  const start = Date.now()

  if (!ctx.extra?.bypassAgentCheck) {
    await ctx.ask({
      permission: id,
      patterns: [params.subagent_type],
      always: ["*"],
      metadata: {
        description: params.description,
        subagent_type: params.subagent_type,
        task_category: params.task_category,
        use_ultrawork: params.use_ultrawork,
      },
    })
  }

  const next = await Agent.get(params.subagent_type)
  if (!next) throw new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`)

  const canTask = next.permission.some((rule) => rule.permission === id)
  const canTodo = next.permission.some((rule) => rule.permission === "todowrite")

  const existing = params.task_id ? await Session.get(SessionID.make(params.task_id)).catch(() => undefined) : undefined

  const subagent = await spawnSubagent(existing, {
    parentSessionID: ctx.sessionID,
    agent: next,
    description: params.description,
    canTask,
    canTodo,
    taskPermissionID: id,
    primaryTools: cfg.experimental?.primary_tools,
    maxDepth: cfg.experimental?.max_subagent_depth ?? 3,
    maxDescendants: cfg.experimental?.max_subagent_descendants ?? 50,
  })

  const msg = MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
  if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

  const model = next.model ?? {
    modelID: msg.info.modelID,
    providerID: msg.info.providerID,
  }

  const messageID = MessageID.ascending()
  const promptParts = await SessionPrompt.resolvePromptParts(params.prompt)
  const finalModel = resolveTaskModel({
    prompt: params.prompt,
    subagentType: params.subagent_type,
    taskCategory: params.task_category,
    useUltrawork: params.use_ultrawork,
    categories: cfg.experimental?.task_categories ?? {},
    ultraworkModel: cfg.experimental?.ultrawork_model,
    fallback: model,
  })
  const concurrencyKey = `${finalModel.providerID}:${finalModel.modelID}`
  const concurrencyLimit = cfg.experimental?.model_concurrency?.[concurrencyKey] ?? 5
  const guard = createGuard({
    sessionID: String(ctx.sessionID),
    threshold: cfg.experimental?.loop_detector_threshold ?? 5,
  })

  ctx.metadata({
    title: params.description,
    metadata: {
      sessionId: subagent.session.id,
      model: finalModel,
    },
  })

  function cancel() {
    void SessionPrompt.cancel(subagent.session.id)
  }

  ctx.abort.addEventListener("abort", cancel)
  const timeout = cfg.experimental?.subagent_timeout ?? SUBAGENT_TIMEOUT
  let acquired = false

  try {
    await guard.before({
      toolName: id,
      input: {
        prompt: params.prompt,
        subagent_type: params.subagent_type,
        task_category: params.task_category,
        use_ultrawork: params.use_ultrawork,
        task_id: params.task_id,
        command: params.command,
      },
    })
    await acquire(concurrencyKey, concurrencyLimit, ctx.abort)
    acquired = true

    const result = await withTimeout(
      SessionPrompt.prompt({
        messageID,
        sessionID: subagent.session.id,
        model: {
          modelID: ModelID.make(finalModel.modelID),
          providerID: ProviderID.make(finalModel.providerID),
        },
        agent: next.name,
        tools: {
          ...(canTodo ? {} : { todowrite: false }),
          ...(canTask ? {} : { task: false }),
          ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
        },
        parts: promptParts,
      }),
      timeout,
    ).catch((err) => {
      if (err instanceof Error && err.message.includes("Operation timed out")) {
        throw new Error(`Subagent timed out after ${timeout}ms`)
      }
      throw err
    })

    await Bus.publish(OrchestrationEvent.Complete, {
      sessionID: subagent.session.id,
      parentSessionID: ctx.sessionID,
      agent: next.name,
      durationMs: Date.now() - start,
    })

    return {
      title: params.description,
      metadata: {
        sessionId: subagent.session.id,
        model: finalModel,
      },
      output: [
        `task_id: ${subagent.session.id} (for resuming to continue this task if needed)`,
        "",
        "<task_result>",
        result.parts.findLast((item) => item.type === "text")?.text ?? "",
        "</task_result>",
      ].join("\n"),
    }
  } catch (err) {
    const cause = err instanceof Error ? err : new Error(String(err))
    await Bus.publish(OrchestrationEvent.Abort, {
      sessionID: subagent.session.id,
      reason: cause.message,
    })
    throw cause
  } finally {
    ctx.abort.removeEventListener("abort", cancel)
    if (acquired) release(concurrencyKey)
    if (subagent.spawned) subagent.spawnInfo.release()
  }
}

const taskTool = Tool.defineEffect(
  id,
  Effect.succeed({
    description: [
      DESCRIPTION,
      "",
      "Optional parameters:",
      "- task_category: explicit routing hint for task category model selection",
      "- use_ultrawork: set true to explicitly route to the configured ultrawork model",
    ].join("\n"),
    parameters,
    execute: executeTask,
  }),
)

export const TaskTool = Object.assign(taskTool, {
  init: async () => Effect.runPromise(Effect.flatMap(taskTool, (tool) => Effect.promise(() => tool.init()))),
})

export const TaskDescription: Tool.DynamicDescription = (agent) =>
  Effect.gen(function* () {
    const items = yield* Effect.promise(() =>
      Agent.list().then((items) => items.filter((item) => item.mode !== "primary")),
    )
    const filtered = items.filter((item) => Permission.evaluate(id, item.name, agent.permission).action !== "deny")
    const list = filtered.toSorted((a, b) => a.name.localeCompare(b.name))
    const description = list
      .map(
        (item) => `- ${item.name}: ${item.description ?? "This subagent should only be called manually by the user."}`,
      )
      .join("\n")
    return [
      "Available agent types and the tools they have access to:",
      description,
      "",
      "Optional parameters:",
      "- task_category: explicit routing hint for task category model selection",
      "- use_ultrawork: set true to explicitly route to the configured ultrawork model",
    ].join("\n")
  })
