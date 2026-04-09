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
import { resolve as resolveCategory } from "../orchestration/category-routing"
import { OrchestrationEvent } from "../orchestration/events"
import { reserveSpawn, SpawnLimitError } from "../orchestration/spawn-limits"
import { create as createGuard } from "../orchestration/tool-guard"
import { detect as detectUltrawork } from "../orchestration/ultrawork"
import { resolveModel as resolveUltrawork } from "../orchestration/ultrawork-hook"
import { Permission } from "@/permission"
import { withTimeout } from "@/util/timeout"

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

export const TaskTool = Tool.defineEffect(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const config = yield* Config.Service

    const run = Effect.fn("TaskTool.execute")(function* (params: z.infer<typeof parameters>, ctx: Tool.Context) {
      const cfg = yield* config.get()
      const start = Date.now()

      if (!ctx.extra?.bypassAgentCheck) {
        yield* Effect.promise(() =>
          ctx.ask({
            permission: id,
            patterns: [params.subagent_type],
            always: ["*"],
            metadata: {
              description: params.description,
              subagent_type: params.subagent_type,
              task_category: params.task_category,
              use_ultrawork: params.use_ultrawork,
            },
          }),
        )
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }

      const canTask = next.permission.some((rule) => rule.permission === id)
      const canTodo = next.permission.some((rule) => rule.permission === "todowrite")

      const existing = params.task_id
        ? yield* Effect.promise(() => Session.get(SessionID.make(params.task_id!)).catch(() => undefined))
        : undefined

      const subagent = existing
        ? { session: existing, spawned: false as const }
        : yield* Effect.promise(async () => {
            const maxDepth = cfg.experimental?.max_subagent_depth ?? 3
            const maxDescendants = cfg.experimental?.max_subagent_descendants ?? 50
            const spawnInfo = await reserveSpawn({
              sessionID: ctx.sessionID,
              parentID: ctx.sessionID,
              maxDepth,
              maxDescendants,
            }).catch(async (err) => {
              if (err instanceof SpawnLimitError) {
                await Bus.publish(OrchestrationEvent.SpawnRejected, {
                  sessionID: ctx.sessionID,
                  agent: next.name,
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
                title: params.description + ` (@${next.name} subagent)`,
                permission: [
                  ...(canTodo
                    ? []
                    : [
                        {
                          permission: "todowrite" as const,
                          pattern: "*" as const,
                          action: "deny" as const,
                        },
                      ]),
                  ...(canTask
                    ? []
                    : [
                        {
                          permission: id,
                          pattern: "*" as const,
                          action: "deny" as const,
                        },
                      ]),
                  ...(cfg.experimental?.primary_tools?.map((item) => ({
                    pattern: "*",
                    action: "allow" as const,
                    permission: item,
                  })) ?? []),
                ],
              })

              await Bus.publish(OrchestrationEvent.Spawn, {
                sessionID: session.id,
                parentSessionID: ctx.sessionID,
                agent: next.name,
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

      const msg = yield* Effect.promise(() => MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }))
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))

      const model = next.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }

      const messageID = MessageID.ascending()
      const promptParts = yield* Effect.promise(() => SessionPrompt.resolvePromptParts(params.prompt))
      const categoryModel = resolveCategory({
        category: params.task_category ?? params.subagent_type,
        categories: cfg.experimental?.task_categories ?? {},
        fallback: model,
      })
      const ultraworkModel =
        detectUltrawork(params.prompt, cfg.experimental?.ultrawork_model) ??
        resolveUltrawork({
          enabled: params.use_ultrawork === true,
          ultraworkModel: cfg.experimental?.ultrawork_model,
        })
      const finalModel = ultraworkModel ?? categoryModel
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

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", cancel)
        }),
        () =>
          Effect.gen(function* () {
            const timeout = cfg.experimental?.subagent_timeout ?? SUBAGENT_TIMEOUT
            let acquired = false

            try {
              yield* Effect.promise(() =>
                guard.before({
                  toolName: id,
                  input: {
                    prompt: params.prompt,
                    subagent_type: params.subagent_type,
                    task_category: params.task_category,
                    use_ultrawork: params.use_ultrawork,
                    task_id: params.task_id,
                    command: params.command,
                  },
                }),
              )
              yield* Effect.promise(() => acquire(concurrencyKey, concurrencyLimit, ctx.abort))
              acquired = true

              const result = yield* Effect.promise(() =>
                withTimeout(
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
                }),
              )

              yield* Effect.promise(() =>
                Bus.publish(OrchestrationEvent.Complete, {
                  sessionID: subagent.session.id,
                  parentSessionID: ctx.sessionID,
                  agent: next.name,
                  durationMs: Date.now() - start,
                }),
              )

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
              yield* Effect.promise(() =>
                Bus.publish(OrchestrationEvent.Abort, {
                  sessionID: subagent.session.id,
                  reason: cause.message,
                }),
              )
              return yield* Effect.fail(cause)
            } finally {
              if (acquired) release(concurrencyKey)
              if (subagent.spawned) subagent.spawnInfo.release()
            }
          }),
        () =>
          Effect.sync(() => {
            ctx.abort.removeEventListener("abort", cancel)
          }),
      )
    })

    return {
      description: [
        DESCRIPTION,
        "",
        "Optional parameters:",
        "- task_category: explicit routing hint for task category model selection",
        "- use_ultrawork: set true to explicitly route to the configured ultrawork model",
      ].join("\n"),
      parameters,
      async execute(params: z.infer<typeof parameters>, ctx) {
        return Effect.runPromise(run(params, ctx))
      },
    }
  }),
)

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
