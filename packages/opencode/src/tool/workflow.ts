import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./workflow.txt"
import { Effect } from "effect"
import { WorkflowRuntimeRef } from "@/workflow/runtime-ref"
import { WorkflowRuntime } from "@/workflow/runtime"
import { spawnSubagent } from "@/orchestration/task-spawn"
import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { BackgroundJob } from "@/background/job"
import { Instance } from "@/project/instance"
import { makeRuntime } from "@/effect/run-service"
import { Config } from "@/config/config"
import type { SessionID } from "@/session/schema"

const bgRuntime = makeRuntime(BackgroundJob.Service, BackgroundJob.defaultLayer)

const parameters = z.object({
  script: z.string().describe("Workflow script name or builtin name"),
  args: z.record(z.string(), z.unknown()).optional().describe("Arguments for the workflow"),
  max_concurrent_agents: z.number().int().positive().optional().describe("Max parallel agents"),
})

function backgroundOutput(sessionID: SessionID) {
  return [
    `task_id: ${sessionID} (workflow session)`,
    "state: running",
    "",
    "<task_result>",
    "Workflow launched in background. Navigate to the session to see live progress.",
    "</task_result>",
  ].join("\n")
}

export const WorkflowTool = Tool.defineEffect(
  "workflow",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters,
      async execute(args: z.infer<typeof parameters>, ctx: Tool.Context) {
        const ref = WorkflowRuntimeRef.get()
        if (!ref) {
          return {
            title: "Workflow unavailable",
            output: "Error: Workflow engine not initialized. Enable experimental.workflow in config.",
            metadata: {} as Record<string, unknown>,
          }
        }

        const cfg = await Config.get()
        const agent = await Agent.get("build")

        const subagent = await spawnSubagent(undefined, {
          parentSessionID: ctx.sessionID,
          agent,
          description: `workflow:${args.script}`,
          canTask: false,
          canTodo: false,
          taskPermissionID: "workflow",
          maxDepth: cfg.experimental?.max_subagent_depth ?? 3,
          maxDescendants: 50,
        })

        const session = subagent.session

        ctx.metadata({
          title: `workflow:${args.script}`,
          metadata: {
            sessionId: session.id,
            background: true,
          },
        })

        const timeout = cfg.experimental?.workflow_agent_timeout_ms ?? 600_000
        const run = Instance.bind(async (): Promise<string> => {
          return WorkflowRuntime.executeInSession({
            sessionID: session.id,
            parentSessionID: ctx.sessionID,
            name: args.script,
            args: args.args,
            timeout,
            concurrent: args.max_concurrent_agents,
          })
        })

        const inject = Instance.bind(async (state: "completed" | "error", text: string) => {
          await Bus.publish(TuiEvent.BackgroundTaskUpdate, {
            sessionID: ctx.sessionID,
            taskID: session.id,
            title: `workflow:${args.script}`,
            state,
          })
          await Bus.publish(TuiEvent.ToastShow, {
            title: state === "completed" ? "Workflow complete" : "Workflow failed",
            message:
              state === "completed"
                ? `Workflow "${args.script}" finished.`
                : `Workflow "${args.script}" failed: ${text}`,
            variant: state === "completed" ? "success" : "error",
            duration: 5000,
          })
        })

        const makeRun = () =>
          Effect.tryPromise({
            try: () => run(),
            catch: (err) => err,
          }).pipe(
            Effect.tap((text) => Effect.promise(() => inject("completed", text)).pipe(Effect.ignore)),
            Effect.catch((cause: unknown) =>
              Effect.gen(function* () {
                const msg = cause instanceof Error ? cause.message : String(cause)
                yield* Effect.promise(() => inject("error", msg)).pipe(Effect.ignore)
                return yield* Effect.fail(cause)
              }),
            ),
          )

        await bgRuntime.runPromise((svc) =>
          svc.start({
            id: session.id,
            type: "workflow",
            title: `workflow:${args.script}`,
            metadata: {
              sessionId: session.id,
              background: true,
            },
            run: makeRun(),
          }),
        )

        await Bus.publish(TuiEvent.BackgroundTaskUpdate, {
          sessionID: ctx.sessionID,
          taskID: session.id,
          title: `workflow:${args.script}`,
          state: "running",
        })

        if (subagent.spawned) subagent.spawnInfo.release()

        return {
          title: `workflow:${args.script}`,
          metadata: { sessionId: session.id, background: true } as Record<string, unknown>,
          output: backgroundOutput(session.id),
        }
      },
    }
  }),
)
