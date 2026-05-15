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
import { Effect, Option, Scope, ServiceMap } from "effect"
import { acquire, release } from "../orchestration/concurrency"
import { OrchestrationEvent } from "../orchestration/events"
import { create as createGuard } from "../orchestration/tool-guard"
import { withTimeout } from "@/util/timeout"
import { spawnSubagent } from "../orchestration/task-spawn"
import { resolveTaskModel } from "../orchestration/task-model-resolver"
import { BackgroundJob } from "@/background/job"
import { SessionStatus } from "../session/status"
import { Flag } from "@/flag/flag"
import { TuiEvent } from "../cli/cmd/tui/event"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts>
  loop(input: z.infer<typeof SessionPrompt.LoopInput>): Effect.Effect<MessageV2.WithParts>
}

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
  background: z
    .boolean()
    .describe("When true, launch the subagent in the background and return immediately")
    .optional(),
})

export const TaskTool = Tool.defineEffect(
  id,
  Effect.gen(function* () {
    const jobs = yield* BackgroundJob.Service
    // Capture the layer scope so Effect calls on `jobs.*` can be run from async context.
    // `jobs.*` methods internally use ScopedCache which requires Scope.Scope.
    // Using withFiber avoids adding Scope to the Effect's type requirements.
    let scope: Scope.Scope | undefined
    yield* Effect.withFiber((fiber) => {
      const opt = ServiceMap.getOption(fiber.services, Scope.Scope)
      if (Option.isSome(opt)) scope = opt.value
      return Effect.void
    })

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
        const concurrencyKey = `${finalModel.providerID}:${finalModel.modelID}`
        const concurrencyLimit = cfg.experimental?.model_concurrency?.[concurrencyKey] ?? 5
        const guard = createGuard({
          sessionID: String(ctx.sessionID),
          threshold: cfg.experimental?.loop_detector_threshold ?? 5,
        })

        ctx.metadata({
          title: params.description,
          metadata: {
            sessionId: nextSession.id,
            model: finalModel,
          },
        })

        if (params.background && Flag.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS) {
          const active = await Effect.runPromise(
            jobs.get(String(nextSession.id)).pipe(Effect.provideService(Scope.Scope, scope!)),
          )
          if (active?.status === "running") {
            throw new Error(`Task ${nextSession.id} is already running. Use task_status to check progress.`)
          }

          const userMessages = await Session.messages({ sessionID: ctx.sessionID })
          const lastUser = userMessages.findLast((m) => m.info.role === "user")
          const userID = lastUser?.info.id

          async function injectResult(state: "completed" | "error", text: string) {
            await SessionPrompt.prompt({
              sessionID: ctx.sessionID,
              noReply: true,
              agent: ctx.agent,
              parts: [
                {
                  type: "text" as const,
                  synthetic: true,
                  text: [
                    `Background task "${params.description}" (task_id: ${nextSession.id}):`,
                    state === "completed" ? "<task_result>" : "<task_error>",
                    text,
                    state === "completed" ? "</task_result>" : "</task_error>",
                  ].join("\n"),
                },
              ],
            })
          }

          async function resumeWhenIdle(state: "completed" | "error") {
            if (!userID) return
            // Wait up to 30s for parent session to become idle, then trigger loop
            for (let i = 0; i < 100; i++) {
              const s = await SessionStatus.get(ctx.sessionID)
              if (s.type === "idle") break
              await new Promise((r) => setTimeout(r, 300))
            }
            await Bus.publish(TuiEvent.ToastShow, {
              title: state === "completed" ? "Background task complete" : "Background task failed",
              message:
                state === "completed"
                  ? `Background task "${params.description}" finished. Resuming the main thread.`
                  : `Background task "${params.description}" failed. Resuming the main thread.`,
              variant: state === "completed" ? "success" : "error",
              duration: 5000,
            })
            await SessionPrompt.loop({ sessionID: ctx.sessionID }).catch(() => {})
          }

          await Effect.runPromise(
            jobs
              .start({
                id: String(nextSession.id),
                type: id,
                title: params.description,
                metadata: { sessionId: nextSession.id, model: finalModel },
                run: Effect.promise(async () => {
                  await acquire(concurrencyKey, concurrencyLimit, ctx.abort)
                  try {
                    const result = await withTimeout(
                      SessionPrompt.prompt({
                        messageID,
                        sessionID: nextSession.id,
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
                      cfg.experimental?.subagent_timeout ?? SUBAGENT_TIMEOUT,
                    )
                    const text = result.parts.findLast((item: MessageV2.Part) => item.type === "text")?.text ?? ""
                    await injectResult("completed", text).catch(() => {})
                    await resumeWhenIdle("completed").catch(() => {})
                    return text
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err)
                    await injectResult("error", msg).catch(() => {})
                    await resumeWhenIdle("error").catch(() => {})
                    throw err
                  } finally {
                    release(concurrencyKey)
                  }
                }),
              })
              .pipe(Effect.provideService(Scope.Scope, scope!)),
          )

          return {
            title: params.description,
            metadata: {
              sessionId: nextSession.id,
              model: finalModel,
              background: true,
            },
            output: [
              `task_id: ${nextSession.id}`,
              `state: running`,
              "",
              "<task_result>",
              `Background task "${params.description}" started. You can continue helping the user.`,
              `Use task_status({ task_id: "${nextSession.id}", wait: true }) to check when done.`,
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
          let result: MessageV2.WithParts
          try {
            result = await withTimeout(
              SessionPrompt.prompt({
                messageID,
                sessionID: nextSession.id,
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
              model: finalModel,
              background: false,
            },
            output: [
              `task_id: ${nextSession.id} (for resuming to continue this task if needed)`,
              "",
              "<task_result>",
              result.parts.findLast((item: MessageV2.Part) => item.type === "text")?.text ?? "",
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
