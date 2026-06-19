import z from "zod"
import { Tool } from "./tool"
import { WorkflowRuntimeRef } from "@/workflow/runtime-ref"

export const WorkflowTool = Tool.define("workflow", {
  description: [
    "Execute a workflow script in an isolated QuickJS sandbox.",
    "Workflows orchestrate multi-agent pipelines with deterministic replay.",
  ].join(" "),
  parameters: z.object({
    script: z.string().describe("Workflow script name or builtin name"),
    args: z.record(z.string(), z.unknown()).optional().describe("Arguments for the workflow"),
    wait: z.boolean().optional().default(true).describe("Wait for completion"),
    max_concurrent_agents: z.number().int().positive().optional().describe("Max parallel agents"),
  }),
  async execute(args, ctx) {
    const ref = WorkflowRuntimeRef.get()
    if (!ref) {
      return {
        title: "Workflow unavailable",
        output: "Error: Workflow engine not initialized. Enable experimental.workflow in config.",
        metadata: {} as Record<string, string>,
      }
    }

    const id = await ref.start({
      name: args.script,
      args: args.args,
      session: ctx.sessionID,
      concurrent: args.max_concurrent_agents,
    })

    if (!args.wait) {
      return {
        title: `Workflow started: ${args.script}`,
        output: `Workflow run ${id} started. Use workflow status to check progress.`,
        metadata: { runID: id } as Record<string, string>,
      }
    }

    const deadline = Date.now() + 600_000
    while (Date.now() < deadline) {
      const run = await ref.status(id)
      if (run && run.status !== "running") {
        const success = run.status === "completed"
        return {
          title: `Workflow ${success ? "completed" : "failed"}: ${args.script}`,
          output: success
            ? `Workflow "${args.script}" completed successfully.`
            : `Workflow "${args.script}" failed: ${run.error ?? "unknown error"}`,
          metadata: { runID: id, status: run.status } as Record<string, string>,
        }
      }
      await new Promise((r) => setTimeout(r, 500))
    }

    return {
      title: `Workflow timeout: ${args.script}`,
      output: `Workflow run ${id} did not complete within 10 minutes.`,
      metadata: { runID: id } as Record<string, string>,
    }
  },
})
