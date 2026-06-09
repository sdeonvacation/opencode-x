import { Tool } from "./tool"
import DESCRIPTION from "./task_status.txt"
import { BackgroundJob } from "@/background/job"
import { MessageV2 } from "@/session/message-v2"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { Flag } from "@/flag/flag"
import { makeRuntime } from "@/effect/run-service"
import z from "zod"

const DEFAULT_TIMEOUT = 60_000

type State = BackgroundJob.Status
type InspectResult = { state: State; text: string }

function format(input: { taskID: string; state: State; text: string }) {
  const tag = input.state === "completed" || input.state === "running" ? "task_result" : "task_error"
  return [`task_id: ${input.taskID}`, `state: ${input.state}`, "", `<${tag}>`, input.text, `</${tag}>`].join("\n")
}

function inspectMessage(message: MessageV2.WithParts): InspectResult | undefined {
  if (message.info.role !== "assistant") return
  const text = message.parts.findLast((part) => part.type === "text")?.text ?? ""
  if (message.info.error) return { state: "error", text: text || message.info.error.name }
  if (message.info.finish && !["tool-calls", "unknown"].includes(message.info.finish))
    return { state: "completed", text }
  return { state: "running", text: text || "Task is still running." }
}

const parameters = z.object({
  task_id: z.string().describe("The task_id returned by the task tool"),
  wait: z.boolean().optional().describe("When true, wait until the task reaches a terminal state or timeout"),
  timeout_ms: z
    .number()
    .positive()
    .int()
    .optional()
    .describe("Maximum milliseconds to wait when wait=true (default: 60000)"),
})

const bgRuntime = makeRuntime(BackgroundJob.Service, BackgroundJob.defaultLayer)

export const TaskStatusTool: Tool.Info & { id: "task_status" } = {
  id: "task_status",
  init: async () => ({
    description: DESCRIPTION,
    parameters,
    async execute(params: z.infer<typeof parameters>, _ctx: Tool.Context) {
      if (!Flag.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS) {
        throw new Error("task_status requires OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true")
      }

      const taskID = SessionID.make(params.task_id)
      const timeout = params.timeout_ms ?? DEFAULT_TIMEOUT

      // Check background job system first
      const job = await bgRuntime.runPromise((svc) => svc.get(taskID)).catch(() => undefined)

      if (job) {
        if (params.wait && job.status === "running") {
          const waited = await bgRuntime.runPromise((svc) => svc.wait({ id: taskID, timeout }))
          if (waited.timedOut) {
            return {
              title: "Task status",
              metadata: { task_id: params.task_id, state: "running" as const, timed_out: true },
              output: format({
                taskID: params.task_id,
                state: "running",
                text: `Timed out after ${timeout}ms while waiting for task completion.`,
              }),
            }
          }
          const info = waited.info ?? job
          return {
            title: "Task status",
            metadata: { task_id: params.task_id, state: info.status, timed_out: false },
            output: format({ taskID: params.task_id, state: info.status, text: info.output ?? info.error ?? "" }),
          }
        }

        return {
          title: "Task status",
          metadata: { task_id: params.task_id, state: job.status, timed_out: false },
          output: format({
            taskID: params.task_id,
            state: job.status,
            text:
              job.output ??
              job.error ??
              (job.status === "running"
                ? "Task is still running."
                : job.status === "cancelled"
                  ? "Task was cancelled."
                  : ""),
          }),
        }
      }

      // No background job — check session status
      const current = await SessionStatus.get(taskID).catch(() => undefined)
      if (current && (current.type === "busy" || current.type === "retry")) {
        return {
          title: "Task status",
          metadata: { task_id: params.task_id, state: "running" as const, timed_out: false },
          output: format({
            taskID: params.task_id,
            state: "running",
            text: current.type === "retry" ? `Task is retrying: ${current.message}` : "Task is still running.",
          }),
        }
      }

      // Check messages for final result
      const msgs = MessageV2.page({ sessionID: taskID, limit: 5 })
      const latest = msgs.items.findLast((m) => m.info.role === "assistant")
      if (latest) {
        const result = inspectMessage(latest)
        if (result && result.state !== "running") {
          return {
            title: "Task status",
            metadata: { task_id: params.task_id, state: result.state, timed_out: false },
            output: format({ taskID: params.task_id, state: result.state, text: result.text }),
          }
        }
      }

      return {
        title: "Task status",
        metadata: { task_id: params.task_id, state: "error" as const, timed_out: false },
        output: format({
          taskID: params.task_id,
          state: "error",
          text: "Task is not running in this process and has not produced output.",
        }),
      }
    },
  }),
}
