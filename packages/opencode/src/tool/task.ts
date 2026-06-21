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
import { Config } from "../config/config"
import { Effect } from "effect"
import { OrchestrationEvent } from "../orchestration/events"
import { spawnSubagent } from "../orchestration/task-spawn"
import { resolveTaskModel } from "../orchestration/task-model-resolver"
import { Instance } from "@/project/instance"
import { createExecutor } from "../orchestration/factory"
import type { ExecuteResult } from "../orchestration/executor"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): void
  resolvePromptParts(template: string): Promise<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Promise<MessageV2.WithParts>
}

const id = "task"
const SUBAGENT_TIMEOUT = 1_800_000

export const parameters = z.object({
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
  isolation: z
    .boolean()
    .describe(
      "Run subagent in an isolated git worktree. Use when multiple subagents run in parallel and may edit overlapping files. Each gets a private copy of the repo; changes are captured as a patch and applied back sequentially. Not needed for read-only tasks or when only one subagent writes at a time. NEVER use for sequential fixes to files already modified by a prior task — patch-back will conflict.",
    )
    .optional(),
  background: z
    .boolean()
    .describe("When true, launch the subagent in the background and return immediately")
    .optional(),
})

function output(sessionID: SessionID, text: string) {
  return [
    `task_id: ${sessionID} (for resuming to continue this task if needed)`,
    "",
    "<task_result>",
    text,
    "</task_result>",
  ].join("\n")
}

function backgroundOutput(sessionID: SessionID) {
  return [
    `task_id: ${sessionID} (for polling this task with task_status)`,
    "state: running",
    "",
    "<task_result>",
    "Background task launched. If you have more independent tasks to launch, emit them NOW in this same response. Do not narrate between Task calls.",
    "</task_result>",
  ].join("\n")
}

function backgroundUpdateOutput(sessionID: SessionID) {
  return [
    `task_id: ${sessionID} (for polling this task with task_status)`,
    "state: running",
    "",
    "<task_result>",
    "Additional context sent to the background task.",
    "</task_result>",
  ].join("\n")
}

function formatOutput(result: ExecuteResult): string {
  switch (result.tag) {
    case "foreground":
      return output(result.sessionID, result.text)
    case "background":
      return backgroundOutput(result.sessionID)
    case "background_update":
      return backgroundUpdateOutput(result.sessionID)
  }
}

export const TaskTool = Tool.defineEffect(
  id,
  Effect.gen(function* () {
    return {
      parallelSafe: true,
      description: DESCRIPTION,
      parameters,
      async execute(params: z.infer<typeof parameters>, ctx: Tool.Context) {
        const cfg = await Config.get()
        const mode = params.background ? "background" : "foreground"

        // Permission check
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

        // Agent resolution
        const next = await Agent.get(params.subagent_type)
        if (!next) {
          throw new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`)
        }

        const canTask = next.permission.some((rule) => rule.permission === id)
        const canTodo = next.permission.some((rule) => rule.permission === "todowrite")

        // Spawn subagent session
        const existing = params.task_id
          ? await Session.get(SessionID.make(params.task_id)).catch(() => undefined)
          : undefined

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

        const nextSession = subagent.session

        // Model resolution
        const msg = MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
        if (msg.info.role !== "assistant") throw new Error("Not an assistant message")
        const parentVariant = msg.info.variant

        const model = next.model ?? {
          modelID: msg.info.modelID,
          providerID: msg.info.providerID,
        }

        const messageID = MessageID.ascending()
        const promptParts = await SessionPrompt.resolvePromptParts(params.prompt)
        if (cfg.experimental?.subagent_context_transfer) {
          const parent = MessageV2.page({ sessionID: ctx.sessionID, limit: 20 })
          const context = buildContextTransfer(parent.items, 4000)
          if (context) {
            promptParts.unshift({ type: "text", text: context })
          }
        }

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
        const timeout = cfg.experimental?.subagent_timeout ?? SUBAGENT_TIMEOUT

        const metadata = {
          sessionId: nextSession.id,
          model: finalModel,
          ...(mode === "background" ? { background: true } : {}),
        }

        ctx.metadata({
          title: params.description,
          metadata,
        })

        // Build tools config
        const tools = {
          ...(canTodo ? {} : { todowrite: false }),
          ...(canTask ? {} : { task: false }),
          ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
          goal_complete: false,
        }

        // Guard input for loop detection
        const guardInput = {
          toolName: "task",
          input: {
            prompt: params.prompt,
            subagent_type: params.subagent_type,
            task_category: params.task_category,
            use_ultrawork: params.use_ultrawork,
            task_id: params.task_id,
            command: params.command,
          },
        }

        const shouldIsolate =
          params.isolation && cfg.experimental?.worktree_isolation !== false && Instance.project.vcs === "git"

        // Create executor with middleware chain
        const executor = createExecutor({
          mode,
          isolation: !!shouldIsolate,
          vcs: Instance.project.vcs,
          worktreeEnabled: cfg.experimental?.worktree_isolation !== false,
          guardInput,
          backgroundMeta:
            mode === "background"
              ? {
                  parentSessionID: ctx.sessionID,
                  description: params.description,
                  taskID: params.task_id,
                }
              : undefined,
        })

        // Abort handling for foreground
        function cancel() {
          SessionPrompt.cancel(nextSession.id)
        }
        if (mode === "foreground") {
          ctx.abort.addEventListener("abort", cancel)
        }

        try {
          const result = await executor.execute({
            sessionID: nextSession.id,
            messageID,
            model: {
              modelID: ModelID.make(finalModel.modelID),
              providerID: ProviderID.make(finalModel.providerID),
            },
            variant: parentVariant,
            agent: next.name,
            tools,
            parts: promptParts,
            timeout,
            concurrency: { key: concurrencyKey, limit: concurrencyLimit },
            guard: {
              sessionID: String(ctx.sessionID),
              threshold: cfg.experimental?.loop_detector_threshold ?? 5,
            },
            abort: mode === "foreground" ? ctx.abort : undefined,
            isolation: !!shouldIsolate,
            metadata: {
              parentSessionID: ctx.sessionID,
              description: params.description,
              agentName: next.name,
            },
          })

          // Publish Complete event for foreground modes
          if (result.tag === "foreground") {
            await Bus.publish(OrchestrationEvent.Complete, {
              sessionID: nextSession.id,
              parentSessionID: ctx.sessionID,
              agent: next.name,
              durationMs: 0,
            })
          }

          return {
            title: params.description,
            metadata: {
              ...metadata,
              ...(result.tag === "background" || result.tag === "background_update" ? { jobId: nextSession.id } : {}),
            },
            output: formatOutput(result),
          }
        } finally {
          if (mode === "foreground") {
            ctx.abort.removeEventListener("abort", cancel)
          }
          if (subagent.spawned) subagent.spawnInfo.release()
        }
      },
    }
  }),
)

export function buildContextTransfer(msgs: MessageV2.WithParts[], limit: number): string | undefined {
  const parts: string[] = []
  let size = 0
  for (let i = msgs.length - 1; i >= 0 && size < limit; i--) {
    const msg = msgs[i]
    for (const part of msg.parts) {
      if (part.type !== "tool") continue
      if (part.state.status !== "completed") continue
      if (!part.state.output || part.state.output.length < 50) continue
      const snippet = part.state.output.slice(0, Math.min(part.state.output.length, limit - size))
      if (!snippet) break
      parts.push(`[${part.tool}] ${snippet}`)
      size += snippet.length
      if (size >= limit) break
    }
  }
  if (!parts.length) return undefined
  return `<parent-context>\nRecent tool outputs from parent session:\n${parts.reverse().join("\n---\n")}\n</parent-context>`
}
