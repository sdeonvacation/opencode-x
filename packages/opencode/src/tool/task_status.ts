import { Tool } from "./tool"
import DESCRIPTION from "./task_status.txt"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { Flag } from "@/flag/flag"
import { Effect, Option } from "effect"
import z from "zod"

const DEFAULT_TIMEOUT = 60_000
const POLL_MS = 300

const parameters = z.object({
  task_id: z.string().describe("The task_id returned by the task tool"),
  wait: z.boolean().optional().describe("When true, wait until the task reaches a terminal state or timeout"),
  timeout_ms: z.number().optional().describe("Maximum milliseconds to wait when wait=true (default: 60000)"),
})

type State = BackgroundJob.Status
type InspectResult = { state: State; text: string }

function format(input: { taskID: string; state: State; text: string }) {
  const tag = input.state === "completed" || input.state === "running" ? "task_result" : "task_error"
  return [`task_id: ${input.taskID}`, `state: ${input.state}`, "", `<${tag}>`, input.text, `</${tag}>`].join("\n")
}

function errorText(error: NonNullable<MessageV2.Assistant["error"]>) {
  const data = Reflect.get(error, "data")
  const message = data && typeof data === "object" ? Reflect.get(data, "message") : undefined
  if (typeof message === "string" && message) return message
  return error.name
}

function inspectMessage(message: MessageV2.WithParts): InspectResult | undefined {
  if (message.info.role !== "assistant") return
  const text = message.parts.findLast((part) => part.type === "text")?.text ?? ""
  if (message.info.error) return { state: "error", text: text || errorText(message.info.error) }
  if (message.info.finish && !["tool-calls", "unknown"].includes(message.info.finish))
    return { state: "completed", text }
  return { state: "running", text: text || "Task is still running." }
}

export const TaskStatusTool = Tool.defineEffect(
  "task_status",
  Effect.gen(function* () {
    const jobs = yield* BackgroundJob.Service
    const sessions = yield* Session.Service
    const status = yield* SessionStatus.Service

    const inspect = Effect.fn("TaskStatusTool.inspect")(function* (taskID: SessionID) {
      const job = yield* jobs.get(taskID)
      if (job) {
        return {
          state: job.status,
          text:
            job.output ??
            job.error ??
            (job.status === "running"
              ? "Task is still running."
              : job.status === "cancelled"
                ? "Task was cancelled."
                : ""),
        }
      }

      const current = yield* status.get(taskID)
      if (current.type === "busy" || current.type === "retry") {
        return {
          state: "running" as const,
          text: current.type === "retry" ? `Task is retrying: ${current.message}` : "Task is still running.",
        }
      }

      const msgs = yield* sessions.messages({ sessionID: taskID }).pipe(Effect.orDie)
      const last = msgs.findLast((m) => m.info.role === "assistant")
      if (last) {
        const latest = inspectMessage(last)
        if (!latest) return { state: "error" as const, text: "Task is not running in this process." }
        if (latest.state === "running")
          return { state: "error" as const, text: "Task is not running in this process and has no final output." }
        return latest
      }
      return { state: "error" as const, text: "Task is not running in this process and has not produced output." }
    })

    const waitForTerminal = Effect.fn("TaskStatusTool.waitForTerminal")(function* (taskID: SessionID, timeout: number) {
      let remaining = timeout
      while (true) {
        const result = yield* inspect(taskID)
        if (result.state !== "running") return { result, timedOut: false }
        if (remaining <= 0) return { result, timedOut: true }
        const sleep = Math.min(POLL_MS, remaining)
        yield* Effect.sleep(`${sleep} millis`)
        remaining -= sleep
      }
    })

    return {
      description: DESCRIPTION,
      parameters,
      async execute(params: z.infer<typeof parameters>, _ctx: Tool.Context) {
        if (!Flag.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS) {
          throw new Error("task_status requires OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true")
        }

        const taskID = SessionID.make(params.task_id)

        const session = await Effect.runPromise(
          sessions.get(taskID).pipe(Effect.catchCause(() => Effect.succeed(undefined))),
        )
        if (!session) {
          return {
            title: "Task status",
            metadata: {
              task_id: params.task_id,
              state: "error" as const,
              timed_out: false,
            },
            output: format({
              taskID: params.task_id,
              state: "error",
              text: `Task not found: ${params.task_id}`,
            }),
          }
        }

        const waited =
          params.wait === true
            ? await Effect.runPromise(jobs.wait({ id: taskID, timeout: params.timeout_ms ?? DEFAULT_TIMEOUT }))
            : { info: await Effect.runPromise(jobs.get(taskID)), timedOut: false }

        type Inspected = { result: InspectResult; timedOut: boolean }
        const inspected: Inspected = waited.info
          ? {
              result: {
                state: waited.info.status,
                text:
                  waited.info.output ??
                  waited.info.error ??
                  (waited.info.status === "running" ? "Task is still running." : ""),
              },
              timedOut: waited.timedOut,
            }
          : params.wait === true
            ? ((await Effect.runPromise(waitForTerminal(taskID, params.timeout_ms ?? DEFAULT_TIMEOUT))) as Inspected)
            : { result: await Effect.runPromise(inspect(taskID)), timedOut: false }

        const text = inspected.timedOut
          ? `Timed out after ${params.timeout_ms ?? DEFAULT_TIMEOUT}ms while waiting for task completion.`
          : inspected.result.text

        return {
          title: "Task status",
          metadata: {
            task_id: params.task_id,
            state: inspected.result.state,
            timed_out: inspected.timedOut,
          },
          output: format({
            taskID: params.task_id,
            state: inspected.result.state,
            text,
          }),
        }
      },
    }
  }),
)
