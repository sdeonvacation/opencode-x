import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { Bus } from "../bus"
import { ModelID, ProviderID } from "../provider/schema"
import { SessionPrompt } from "../session/prompt"
import { iife } from "@/util/iife"
import { defer } from "@/util/defer"
import { Config } from "../config/config"
import { acquire, release } from "../orchestration/concurrency"
import { resolve as resolveCategory } from "../orchestration/category-routing"
import { OrchestrationEvent } from "../orchestration/events"
import { reserveSpawn, SpawnLimitError } from "../orchestration/spawn-limits"
import { create as createGuard } from "../orchestration/tool-guard"
import { detect as detectUltrawork } from "../orchestration/ultrawork"
import { resolveModel as resolveUltrawork } from "../orchestration/ultrawork-hook"
import { Permission } from "@/permission"
import { withTimeout } from "@/util/timeout"

const SUBAGENT_TIMEOUT = 900_000

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

export const TaskTool = Tool.define("task", async (ctx) => {
  const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary"))

  // Filter agents by permissions if agent provided
  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter((a) => Permission.evaluate("task", a.name, caller.permission).action !== "deny")
    : agents
  const list = accessibleAgents.toSorted((a, b) => a.name.localeCompare(b.name))

  const description = DESCRIPTION.replace(
    "{agents}",
    list
      .map((a) => `- ${a.name}: ${a.description ?? "This subagent should only be called manually by the user."}`)
      .join("\n"),
  )
  const guidance = [
    "",
    "Optional parameters:",
    "- task_category: explicit routing hint for task category model selection",
    "- use_ultrawork: set true to explicitly use the configured ultrawork model",
  ].join("\n")
  return {
    description: description + guidance,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      const config = await Config.get()
      const start = Date.now()

      // Skip permission check when user explicitly invoked via @ or command subtask
      if (!ctx.extra?.bypassAgentCheck) {
        await ctx.ask({
          permission: "task",
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

      const agent = await Agent.get(params.subagent_type)
      if (!agent) throw new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`)

      const hasTaskPermission = agent.permission.some((rule) => rule.permission === "task")
      const hasTodoWritePermission = agent.permission.some((rule) => rule.permission === "todowrite")

      const subagent = await iife(async () => {
        if (params.task_id) {
          const found = await Session.get(SessionID.make(params.task_id)).catch(() => {})
          if (found) return { session: found, spawned: false as const }
        }

        const maxDepth = config.experimental?.max_subagent_depth ?? 3
        const maxDescendants = config.experimental?.max_subagent_descendants ?? 50
        const spawnInfo = await reserveSpawn({
          sessionID: ctx.sessionID,
          parentID: ctx.sessionID,
          maxDepth,
          maxDescendants,
        }).catch(async (err) => {
          if (err instanceof SpawnLimitError) {
            await Bus.publish(OrchestrationEvent.SpawnRejected, {
              sessionID: ctx.sessionID,
              agent: agent.name,
              reason: err.reason,
              limit: err.limit,
              current: err.current,
            })
          }
          throw err
        })

        try {
          const session = await Session.create({
            parentID: ctx.sessionID,
            title: params.description + ` (@${agent.name} subagent)`,
            permission: [
              ...(hasTodoWritePermission
                ? []
                : [
                    {
                      permission: "todowrite" as const,
                      pattern: "*" as const,
                      action: "deny" as const,
                    },
                  ]),
              ...(hasTaskPermission
                ? []
                : [
                    {
                      permission: "task" as const,
                      pattern: "*" as const,
                      action: "deny" as const,
                    },
                  ]),
              ...(config.experimental?.primary_tools?.map((t) => ({
                pattern: "*",
                action: "allow" as const,
                permission: t,
              })) ?? []),
            ],
          })

          await Bus.publish(OrchestrationEvent.Spawn, {
            sessionID: session.id,
            parentSessionID: ctx.sessionID,
            agent: agent.name,
            depth: spawnInfo.depth,
          })

          return {
            session,
            spawnInfo,
            spawned: true as const,
          }
        } catch (err) {
          spawnInfo.release()
          throw err
        }
      })
      const session = subagent.session
      const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
      if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

      const model = agent.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }

      const messageID = MessageID.ascending()
      const promptParts = await SessionPrompt.resolvePromptParts(params.prompt)
      const categoryModel = resolveCategory({
        category: params.task_category ?? params.subagent_type,
        categories: config.experimental?.task_categories ?? {},
        fallback: model,
      })
      const ultraworkModel =
        detectUltrawork(params.prompt, config.experimental?.ultrawork_model) ??
        resolveUltrawork({
          enabled: params.use_ultrawork === true,
          ultraworkModel: config.experimental?.ultrawork_model,
        })
      const finalModel = ultraworkModel ?? categoryModel
      const concurrencyKey = `${finalModel.providerID}:${finalModel.modelID}`
      const concurrencyLimit = config.experimental?.model_concurrency?.[concurrencyKey] ?? 5
      const guard = createGuard({
        sessionID: String(ctx.sessionID),
        threshold: config.experimental?.loop_detector_threshold ?? 5,
      })

      ctx.metadata({
        title: params.description,
        metadata: {
          sessionId: session.id,
          model: finalModel,
        },
      })

      function cancel() {
        SessionPrompt.cancel(session.id)
      }
      ctx.abort.addEventListener("abort", cancel)
      using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))

      const timeout = config.experimental?.subagent_timeout ?? SUBAGENT_TIMEOUT

      await guard.before({
        toolName: "task",
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
      try {
        const result = await withTimeout(
          SessionPrompt.prompt({
            messageID,
            sessionID: session.id,
            model: {
              modelID: ModelID.make(finalModel.modelID),
              providerID: ProviderID.make(finalModel.providerID),
            },
            agent: agent.name,
            tools: {
              ...(hasTodoWritePermission ? {} : { todowrite: false }),
              ...(hasTaskPermission ? {} : { task: false }),
              ...Object.fromEntries((config.experimental?.primary_tools ?? []).map((t) => [t, false])),
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
          sessionID: session.id,
          parentSessionID: ctx.sessionID,
          agent: agent.name,
          durationMs: Date.now() - start,
        })

        const text = result.parts.findLast((x) => x.type === "text")?.text ?? ""

        const output = [
          `task_id: ${session.id} (for resuming to continue this task if needed)`,
          "",
          "<task_result>",
          text,
          "</task_result>",
        ].join("\n")

        return {
          title: params.description,
          metadata: {
            sessionId: session.id,
            model: finalModel,
          },
          output,
        }
      } catch (err) {
        const cause = err instanceof Error ? err : new Error(String(err))
        await Bus.publish(OrchestrationEvent.Abort, {
          sessionID: session.id,
          reason: cause.message,
        })
        throw cause
      } finally {
        release(concurrencyKey)
        if (subagent.spawned) subagent.spawnInfo.release()
      }
    },
  }
})
