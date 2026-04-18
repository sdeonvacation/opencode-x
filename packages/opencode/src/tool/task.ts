import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { Bus } from "../bus"
import { ModelID, ProviderID } from "../provider/schema"
import { Provider } from "../provider/provider"
import { SessionPrompt } from "../session/prompt"
import { Config } from "../config/config"
import { Effect } from "effect"
import { acquire, release } from "../orchestration/concurrency"
import { OrchestrationEvent } from "../orchestration/events"
import { create as createGuard } from "../orchestration/tool-guard"
import { withTimeout } from "@/util/timeout"
import { spawnSubagent } from "../orchestration/task-spawn"
import { resolveTaskModel } from "../orchestration/task-model-resolver"
import { detect as detectUltrawork } from "../orchestration/ultrawork"
import { resolveModel as resolveUltrawork } from "../orchestration/ultrawork-hook"
import { classify } from "../orchestration/hybrid-heuristics"
import { run as runPreflight } from "../orchestration/hybrid-preflight"
import { route as hybridRoute } from "../orchestration/hybrid-router"
import type {
  HybridRoutingConfig,
  ModelRef,
  PreflightInput,
  PreflightResult,
  RouteDecision,
} from "../orchestration/hybrid-types"

const id = "task"
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

const READ_RE = /\b(grep|glob|ls|tree|read)\b/i
const WRITE_RE = /\b(edit|write|patch)\b/i

export function hint(prompt: string, command?: string): PreflightInput["operation_hint"] {
  const text = [command, prompt].filter(Boolean).join("\n")
  if (WRITE_RE.test(text)) return "code_change"
  if (READ_RE.test(text)) return "read"
  return classify(text)
}

function input(prompt: string, agent: string, base: ModelRef, command?: string): PreflightInput {
  const summary = prompt.slice(0, 500)
  return {
    prompt: summary,
    agent,
    invocation_type: "tool",
    command_string: command,
    operation_hint: hint(prompt, command),
    parts_summary: summary,
    base_model: { providerID: base.providerID, modelID: base.modelID },
  }
}

async function publish(sessionID: string, decision: RouteDecision) {
  await Bus.publish(OrchestrationEvent.Route, {
    sessionID,
    route: decision.target,
    operation_type: decision.preflight?.operation_type,
    confidence: decision.preflight?.confidence,
    info_gap: decision.preflight?.info_gap,
    needs_code_change: decision.preflight?.needs_code_change,
    assumptions_count: decision.assumptions.length,
    verification_used: false,
    success: true,
    was_overridden: decision.was_overridden,
    override_reason: decision.override_reason,
    preflight_fallback: decision.preflight?.preflight_fallback,
  })
}

async function hybrid(
  sessionID: string,
  prompt: string,
  agent: string,
  base: ModelRef,
  cfg: HybridRoutingConfig,
  command?: string,
) {
  const preflight: PreflightResult | undefined = await Effect.runPromise(
    runPreflight(input(prompt, agent, base, command), cfg).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
      Effect.provide(Provider.defaultLayer),
    ),
  )
  const decision = hybridRoute(preflight, base, cfg, false)
  await publish(sessionID, decision)
  return decision
}

export const TaskTool = Tool.defineEffect(
  id,
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters,
      async execute(params: z.infer<typeof parameters>, ctx: Tool.Context) {
        const cfg = await Config.get()

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
        if (!next) {
          throw new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`)
        }

        const canTask = next.permission.some((rule) => rule.permission === id)
        const canTodo = next.permission.some((rule) => rule.permission === "todowrite")

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

        // Hybrid routing hook (gated behind flag)
        const hybridCfg = cfg.experimental?.hybrid_routing
        let routedModel: ModelRef = finalModel
        const ultrawork =
          detectUltrawork(params.prompt, cfg.experimental?.ultrawork_model) ??
          resolveUltrawork({
            enabled: params.use_ultrawork === true,
            ultraworkModel: cfg.experimental?.ultrawork_model,
          })
        const routed =
          hybridCfg?.enabled && !ultrawork
            ? await hybrid(nextSession.id, params.prompt, params.subagent_type, finalModel, hybridCfg, params.command)
            : undefined
        if (routed) routedModel = routed.model

        const concurrencyKey = `${routedModel.providerID}:${routedModel.modelID}`
        const concurrencyLimit = cfg.experimental?.model_concurrency?.[concurrencyKey] ?? 5
        const guard = createGuard({
          sessionID: String(ctx.sessionID),
          threshold: cfg.experimental?.loop_detector_threshold ?? 5,
        })

        ctx.metadata({
          title: params.description,
          metadata: {
            sessionId: nextSession.id,
            model: routedModel,
          },
        })

        if (routed?.target === "ask") {
          return {
            title: params.description,
            metadata: {
              sessionId: nextSession.id,
              model: routedModel,
            },
            output: [
              `task_id: ${nextSession.id} (for resuming to continue this task if needed)`,
              "",
              "<task_result>",
              routed.ask_text ?? "",
              "</task_result>",
            ].join("\n"),
          }
        }

        function cancel() {
          SessionPrompt.cancel(nextSession.id)
        }

        ctx.abort.addEventListener("abort", cancel)
        try {
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
          const timeout = cfg.experimental?.subagent_timeout ?? SUBAGENT_TIMEOUT
          let result: Awaited<ReturnType<typeof SessionPrompt.prompt>>
          try {
            result = await withTimeout(
              SessionPrompt.prompt({
                messageID,
                sessionID: nextSession.id,
                model: {
                  modelID: ModelID.make(routedModel.modelID),
                  providerID: ProviderID.make(routedModel.providerID),
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
          } finally {
            release(concurrencyKey)
          }

          await Bus.publish(OrchestrationEvent.Complete, {
            sessionID: nextSession.id,
            parentSessionID: ctx.sessionID,
            agent: next.name,
            durationMs: 0,
          })

          return {
            title: params.description,
            metadata: {
              sessionId: nextSession.id,
              model: routedModel,
            },
            output: [
              `task_id: ${nextSession.id} (for resuming to continue this task if needed)`,
              "",
              "<task_result>",
              result.parts.findLast((item) => item.type === "text")?.text ?? "",
              "</task_result>",
            ].join("\n"),
          }
        } finally {
          ctx.abort.removeEventListener("abort", cancel)
          if (subagent.spawned) subagent.spawnInfo.release()
        }
      },
    }
  }),
)
