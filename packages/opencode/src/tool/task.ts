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
import { acquire, release } from "../orchestration/concurrency"
import { OrchestrationEvent } from "../orchestration/events"
import { create as createGuard } from "../orchestration/tool-guard"
import { withTimeout } from "@/util/timeout"
import { spawnSubagent } from "../orchestration/task-spawn"
import { resolveTaskModel } from "../orchestration/task-model-resolver"
import { OrchestrationWorktree } from "../orchestration/worktree"
import { BackgroundJob } from "@/background/job"
import { Flag } from "@/flag/flag"
import { Log } from "@/util/log"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { makeRuntime } from "@/effect/run-service"
import { Instance, type InstanceContext } from "@/project/instance"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): void
  resolvePromptParts(template: string): Promise<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Promise<MessageV2.WithParts>
}

const id = "task"
const SUBAGENT_TIMEOUT = 1_800_000

const baseParameters = z.object({
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
    .enum(["worktree"])
    .describe("Isolation mode for the subagent. 'worktree' creates a git worktree for conflict-free edits")
    .optional(),
})

export const parameters = baseParameters.extend({
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

function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

const bgRuntime = makeRuntime(BackgroundJob.Service, BackgroundJob.defaultLayer)

export const TaskTool = Tool.defineEffect(
  id,
  Effect.gen(function* () {
    return {
      parallelSafe: true,
      description: DESCRIPTION,
      parameters: Flag.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS ? parameters : baseParameters,
      async execute(params: z.infer<typeof parameters>, ctx: Tool.Context) {
        const cfg = await Config.get()
        const runInBackground = params.background === true

        if (runInBackground && !Flag.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS) {
          throw new Error("Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true")
        }

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
        const guard = createGuard({
          sessionID: String(ctx.sessionID),
          threshold: cfg.experimental?.loop_detector_threshold ?? 5,
        })

        const metadata = {
          sessionId: nextSession.id,
          model: finalModel,
          ...(runInBackground ? { background: true } : {}),
        }

        ctx.metadata({
          title: params.description,
          metadata,
        })

        // --- Background execution path ---
        if (runInBackground) {
          const runTask = async (): Promise<string> => {
            let worktree: OrchestrationWorktree.WorktreePath | undefined
            let worktreeCtx: InstanceContext | undefined
            try {
              if (params.isolation === "worktree" && cfg.experimental?.worktree_isolation !== false) {
                worktree = await OrchestrationWorktree.create({ sessionID: nextSession.id, cwd: Instance.directory })
                worktreeCtx = { ...Instance.current, directory: worktree }
              }

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
              await acquire(concurrencyKey, concurrencyLimit)
              try {
                const timeout = cfg.experimental?.subagent_timeout ?? SUBAGENT_TIMEOUT
                const promptCall = () =>
                  SessionPrompt.prompt({
                    messageID,
                    sessionID: nextSession.id,
                    model: {
                      modelID: ModelID.make(finalModel.modelID),
                      providerID: ProviderID.make(finalModel.providerID),
                    },
                    variant: parentVariant,
                    agent: next.name,
                    tools: {
                      ...(canTodo ? {} : { todowrite: false }),
                      ...(canTask ? {} : { task: false }),
                      ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
                      goal_complete: false,
                    },
                    parts: promptParts,
                  })
                const result = await withTimeout(
                  worktreeCtx ? Instance.restore(worktreeCtx, () => promptCall()) : promptCall(),
                  timeout,
                ).catch((err) => {
                  if (err instanceof Error && err.message.includes("Operation timed out")) {
                    SessionPrompt.cancel(nextSession.id)
                    throw new Error(`Subagent timed out after ${timeout}ms`)
                  }
                  throw err
                })

                let mergeNote = ""
                if (worktree) {
                  try {
                    await OrchestrationWorktree.merge({ sessionID: nextSession.id, worktree, cwd: Instance.directory })
                  } catch (err) {
                    if (err instanceof OrchestrationWorktree.MergeConflict) {
                      mergeNote = `\n\n[worktree merge conflict — branch preserved: ${err.data.branch}]`
                    } else {
                      mergeNote = `\n\n[worktree merge failed: ${errorText(err)}]`
                    }
                  }
                }

                return (result.parts.findLast((item) => item.type === "text")?.text ?? "") + mergeNote
              } finally {
                release(concurrencyKey)
              }
            } finally {
              if (worktree) {
                OrchestrationWorktree.cleanup({ sessionID: nextSession.id, worktree, cwd: Instance.directory }).catch(
                  () => {},
                )
              }
            }
          }

          const log = Log.create({ service: "task.background" })

          const inject = Instance.bind(async (state: "completed" | "error", text: string) => {
            try {
              await Bus.publish(TuiEvent.BackgroundTaskUpdate, {
                sessionID: ctx.sessionID,
                taskID: nextSession.id,
                title: params.description,
                state,
              })
              await Bus.publish(TuiEvent.ToastShow, {
                title: state === "completed" ? "Background task complete" : "Background task failed",
                message:
                  state === "completed"
                    ? `Background task "${params.description}" finished.`
                    : `Background task "${params.description}" failed.`,
                variant: state === "completed" ? "success" : "error",
                duration: 5000,
              })
            } catch (err) {
              log.error("inject failed", {
                sessionID: ctx.sessionID,
                state,
                error: err instanceof Error ? err.message : String(err),
              })
            }
          })

          const makeRun = () =>
            Effect.tryPromise({
              try: () => runTask(),
              catch: (err) => err,
            }).pipe(
              Effect.tap((text) => Effect.promise(() => inject("completed", text)).pipe(Effect.ignore)),
              Effect.catch((cause: unknown) =>
                Effect.gen(function* () {
                  const err = errorText(cause)
                  yield* Effect.promise(() => inject("error", err)).pipe(Effect.ignore)
                  return yield* Effect.fail(cause)
                }),
              ),
            )

          // If job already running and we have a task_id, extend instead of starting new
          const job = await bgRuntime.runPromise((svc) => svc.get(nextSession.id))
          if (job?.status === "running" && params.task_id) {
            const extended = await bgRuntime.runPromise((svc) => svc.extend({ id: nextSession.id, run: makeRun() }))
            if (extended) {
              if (subagent.spawned) subagent.spawnInfo.release()
              return {
                title: params.description,
                metadata: { ...metadata, background: true, jobId: nextSession.id },
                output: backgroundUpdateOutput(nextSession.id),
              }
            }
          }

          await bgRuntime.runPromise((svc) =>
            svc.start({
              id: nextSession.id,
              type: id,
              title: params.description,
              metadata,
              run: makeRun(),
            }),
          )

          await Bus.publish(TuiEvent.BackgroundTaskUpdate, {
            sessionID: ctx.sessionID,
            taskID: nextSession.id,
            title: params.description,
            state: "running",
          })

          if (subagent.spawned) subagent.spawnInfo.release()

          return {
            title: params.description,
            metadata: { ...metadata, jobId: nextSession.id },
            output: backgroundOutput(nextSession.id),
          }
        }

        // --- Foreground execution path ---
        function cancel() {
          SessionPrompt.cancel(nextSession.id)
        }

        ctx.abort.addEventListener("abort", cancel)
        let worktree: OrchestrationWorktree.WorktreePath | undefined
        let worktreeCtx: InstanceContext | undefined
        try {
          if (params.isolation === "worktree" && cfg.experimental?.worktree_isolation !== false) {
            worktree = await OrchestrationWorktree.create({ sessionID: nextSession.id, cwd: Instance.directory })
            worktreeCtx = { ...Instance.current, directory: worktree }
          }

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
          const promptCall = () =>
            SessionPrompt.prompt({
              messageID,
              sessionID: nextSession.id,
              model: {
                modelID: ModelID.make(finalModel.modelID),
                providerID: ProviderID.make(finalModel.providerID),
              },
              variant: parentVariant,
              agent: next.name,
              tools: {
                ...(canTodo ? {} : { todowrite: false }),
                ...(canTask ? {} : { task: false }),
                ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
                goal_complete: false,
              },
              parts: promptParts,
            })
          try {
            result = await withTimeout(
              worktreeCtx ? Instance.restore(worktreeCtx, () => promptCall()) : promptCall(),
              timeout,
            ).catch((err) => {
              if (err instanceof Error && err.message.includes("Operation timed out")) {
                cancel()
                throw new Error(`Subagent timed out after ${timeout}ms`)
              }
              throw err
            })
          } finally {
            release(concurrencyKey)
          }

          // Merge worktree changes back
          let mergeNote = ""
          if (worktree) {
            try {
              await OrchestrationWorktree.merge({ sessionID: nextSession.id, worktree, cwd: Instance.directory })
            } catch (err) {
              if (err instanceof OrchestrationWorktree.MergeConflict) {
                mergeNote = `\n\n[worktree merge conflict — branch preserved: ${err.data.branch}]`
              } else {
                mergeNote = `\n\n[worktree merge failed: ${errorText(err)}]`
              }
            }
          }

          await Bus.publish(OrchestrationEvent.Complete, {
            sessionID: nextSession.id,
            parentSessionID: ctx.sessionID,
            agent: next.name,
            durationMs: 0,
          })

          return {
            title: params.description,
            metadata,
            output: output(
              nextSession.id,
              (result.parts.findLast((item) => item.type === "text")?.text ?? "") + mergeNote,
            ),
          }
        } finally {
          ctx.abort.removeEventListener("abort", cancel)
          if (subagent.spawned) subagent.spawnInfo.release()
          if (worktree) {
            OrchestrationWorktree.cleanup({ sessionID: nextSession.id, worktree, cwd: Instance.directory }).catch(
              () => {},
            )
          }
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
