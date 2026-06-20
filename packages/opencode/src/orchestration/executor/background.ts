import type { TaskExecutor, ExecuteInput, ExecuteResult } from "../executor"
import { SessionPrompt } from "../../session/prompt"
import { withTimeout } from "@/util/timeout"
import { acquire, release } from "../concurrency"
import { extractResultText, formatError } from "../result"
import { isolatedRun } from "../isolation"
import { formatIsolation } from "../result"
import { Effect } from "effect"
import { BackgroundJob } from "@/background/job"
import { Instance } from "@/project/instance"
import { Bus } from "../../bus"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { Log } from "@/util/log"
import { makeRuntime } from "@/effect/run-service"
import type { SessionID } from "../../session/schema"

const log = Log.create({ service: "executor.background" })
const bgRuntime = makeRuntime(BackgroundJob.Service, BackgroundJob.defaultLayer)

export type BackgroundMeta = {
  parentSessionID: SessionID
  description: string
  taskID?: string
}

export class BackgroundExecutor implements TaskExecutor {
  constructor(private readonly meta: BackgroundMeta) {}

  async execute(input: ExecuteInput): Promise<ExecuteResult> {
    const shouldIsolate = input.isolation

    const runTask = async (): Promise<string> => {
      await acquire(input.concurrency.key, input.concurrency.limit)
      try {
        const result = await withTimeout(
          SessionPrompt.prompt({
            messageID: input.messageID,
            sessionID: input.sessionID,
            model: input.model,
            variant: input.variant,
            agent: input.agent,
            tools: input.tools,
            parts: input.parts,
          }),
          input.timeout,
        ).catch((err) => {
          if (err instanceof Error && err.message.includes("Operation timed out")) {
            SessionPrompt.cancel(input.sessionID)
            throw new Error(`Subagent timed out after ${input.timeout}ms`)
          }
          throw err
        })
        return extractResultText(result.parts)
      } finally {
        release(input.concurrency.key)
      }
    }

    const inject = Instance.bind(async (state: "completed" | "error", text: string) => {
      try {
        await Bus.publish(TuiEvent.BackgroundTaskUpdate, {
          sessionID: this.meta.parentSessionID,
          taskID: input.sessionID,
          title: this.meta.description,
          state,
        })
        await Bus.publish(TuiEvent.ToastShow, {
          title: state === "completed" ? "Background task complete" : "Background task failed",
          message:
            state === "completed"
              ? `Background task "${this.meta.description}" finished.`
              : `Background task "${this.meta.description}" failed.`,
          variant: state === "completed" ? "success" : "error",
          duration: 5000,
        })
      } catch (err) {
        log.error("inject failed", {
          sessionID: this.meta.parentSessionID,
          state,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })

    const executeTask = Instance.bind(async (): Promise<string> => {
      if (shouldIsolate) return formatIsolation(await isolatedRun({ sessionID: input.sessionID, run: runTask }))
      return runTask()
    })

    const makeRun = () =>
      Effect.tryPromise({
        try: () => executeTask(),
        catch: (err) => err,
      }).pipe(
        Effect.tap((text) => Effect.promise(() => inject("completed", text)).pipe(Effect.ignore)),
        Effect.catch((cause: unknown) =>
          Effect.gen(function* () {
            const err = formatError(cause)
            yield* Effect.promise(() => inject("error", err)).pipe(Effect.ignore)
            return yield* Effect.fail(cause)
          }),
        ),
      )

    // If job already running and we have a task_id, extend instead of starting new
    const job = await bgRuntime.runPromise((svc) => svc.get(input.sessionID))
    if (job?.status === "running" && this.meta.taskID) {
      const extended = await bgRuntime.runPromise((svc) => svc.extend({ id: input.sessionID, run: makeRun() }))
      if (extended) {
        return { tag: "background_update", sessionID: input.sessionID }
      }
    }

    await bgRuntime.runPromise((svc) =>
      svc.start({
        id: input.sessionID,
        type: "task",
        title: this.meta.description,
        metadata: {
          sessionId: input.sessionID,
          model: input.model,
          background: true,
        },
        run: makeRun(),
      }),
    )

    await Bus.publish(TuiEvent.BackgroundTaskUpdate, {
      sessionID: this.meta.parentSessionID,
      taskID: input.sessionID,
      title: this.meta.description,
      state: "running",
    })

    return { tag: "background", sessionID: input.sessionID }
  }
}
