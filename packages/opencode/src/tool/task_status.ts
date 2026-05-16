import { Tool } from "./tool"
import DESCRIPTION from "./task_status.txt"
import z from "zod"
import { BackgroundJob } from "@/background/job"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { SessionID } from "../session/schema"
import { SessionStatus } from "@/session/status"
import { Flag } from "@/flag/flag"
import { Effect } from "effect"

const DEFAULT_TIMEOUT = 60_000
const POLL_MS = 300

const parameters = z.object({
  task_id: z.string().describe("The task_id returned by the task tool"),
  wait: z.boolean().describe("When true, wait until the task reaches a terminal state or timeout").optional(),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .describe("Maximum milliseconds to wait when wait=true (default: 60000)")
    .optional(),
})

type State = BackgroundJob.Status

function format(input: { taskID: string; state: State; text: string }) {
  const tag = input.state === "completed" || input.state === "running" ? "task_result" : "task_error"
  return [`task_id: ${input.taskID}`, `state: ${input.state}`, "", `<${tag}>`, input.text, `</${tag}>`].join("\n")
}

function extractError(error: NonNullable<MessageV2.Assistant["error"]>) {
  const data = Reflect.get(error, "data")
  const message = data && typeof data === "object" ? Reflect.get(data, "message") : undefined
  if (typeof message === "string" && message) return message
  return error.name
}

type InspectResult = { state: State; text: string }

function inspectMessage(message: MessageV2.WithParts): InspectResult | undefined {
  if (message.info.role !== "assistant") return
  const text = message.parts.findLast((part) => part.type === "text")?.text ?? ""
  if (message.info.error) return { state: "error", text: text || extractError(message.info.error) }
  if (message.info.finish && !["tool-calls", "unknown"].includes(message.info.finish))
    return { state: "completed", text }
  return { state: "running", text: text || "Task is still running." }
}

export const TaskStatusTool = Tool.defineEffect(
  "task_status",
  Effect.gen(function* () {
    const jobs = yield* BackgroundJob.Service
    const status = yield* SessionStatus.Service

    return {
      description: DESCRIPTION,
      parameters,
      async execute(params: z.infer<typeof parameters>, _ctx: Tool.Context) {
        if (!Flag.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS) {
          throw new Error("task_status requires OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true")
        }

        const taskID = SessionID.make(params.task_id)

        const session = await Session.get(taskID).catch(() => undefined)
        if (!session) {
          return {
            title: "Task status",
            metadata: { task_id: taskID, state: "error" as const, timed_out: false },
            output: format({ taskID, state: "error", text: `Task not found: ${taskID}` }),
          }
        }

        const waited =
          params.wait === true
            ? await Effect.runPromise(jobs.wait({ id: taskID, timeout: params.timeout_ms ?? DEFAULT_TIMEOUT }))
            : { info: await Effect.runPromise(jobs.get(taskID)), timedOut: false }

        let inspected: { result: InspectResult; timedOut: boolean }

        if (waited.info) {
          inspected = {
            result: {
              state: waited.info.status,
              text:
                waited.info.output ??
                waited.info.error ??
                (waited.info.status === "running"
                  ? "Task is still running."
                  : waited.info.status === "cancelled"
                    ? "Task was cancelled."
                    : ""),
            },
            timedOut: waited.timedOut,
          }
        } else if (params.wait === true) {
          inspected = await waitForTerminal(taskID, params.timeout_ms ?? DEFAULT_TIMEOUT)
        } else {
          inspected = { result: await inspect(taskID), timedOut: false }
        }

        const text = inspected.timedOut
          ? `Timed out after ${params.timeout_ms ?? DEFAULT_TIMEOUT}ms while waiting for task completion.`
          : inspected.result.text

        return {
          title: "Task status",
          metadata: { task_id: taskID, state: inspected.result.state, timed_out: inspected.timedOut },
          output: format({ taskID, state: inspected.result.state, text }),
        }
      },
    }

    async function inspect(taskID: SessionID): Promise<InspectResult> {
      const job = await Effect.runPromise(jobs.get(taskID))
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

      const current = await Effect.runPromise(status.get(taskID))
      if (current.type === "busy" || current.type === "retry") {
        return {
          state: "running",
          text: current.type === "retry" ? `Task is retrying: ${current.message}` : "Task is still running.",
        }
      }

      const msgs = await Session.messages({ sessionID: taskID })
      const latest = msgs.findLast((m) => m.info.role === "assistant")
      if (latest) {
        const result = inspectMessage(latest)
        if (!result) return { state: "error", text: "Task is not running in this process." }
        if (result.state === "running")
          return { state: "error", text: "Task is not running in this process and has no final output." }
        return result
      }
      return { state: "error", text: "Task is not running in this process and has not produced output." }
    }

    async function waitForTerminal(
      taskID: SessionID,
      timeout: number,
    ): Promise<{ result: InspectResult; timedOut: boolean }> {
      const result = await inspect(taskID)
      if (result.state !== "running") return { result, timedOut: false }
      if (timeout <= 0) return { result, timedOut: true }
      const sleep = Math.min(POLL_MS, timeout)
      await new Promise((r) => setTimeout(r, sleep))
      return waitForTerminal(taskID, timeout - sleep)
    }
  }),
)
