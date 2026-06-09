import { Tool } from "./tool"
import DESCRIPTION from "./swarm.txt"
import z from "zod"
import { Effect } from "effect"
import { Config } from "../config/config"
import { Swarm } from "../swarm"
import { Agent } from "../agent/agent"
import { execute, type ExecuteOutput } from "../swarm/executor"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { BackgroundJob } from "@/background/job"
import { Bus } from "../bus"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { SessionPrompt } from "../session/prompt"
import { makeRuntime } from "@/effect/run-service"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { Identifier } from "@/id/id"

const id = "swarm"

const parameters = z.object({
  template: z.string().describe("Prompt template with {{placeholders}}"),
  items: z
    .array(
      z
        .object({
          id: z.string(),
        })
        .catchall(z.string()),
    )
    .describe("Array of items, each with id + placeholder values"),
  agent: z.string().default("general").describe("Agent type for subagents"),
  concurrency: z.number().min(1).max(20).default(5).describe("Max parallel subagents"),
  background: z.boolean().default(false).describe("Run in background, return immediately"),
})

function escapeXml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function formatResults(output: ExecuteOutput): string {
  const lines = [
    `<swarm_results total="${output.total}" success="${output.success}" failed="${output.failed}" skipped="${output.skipped}" duration_ms="${output.durationMs}">`,
  ]
  for (const r of output.results) {
    lines.push(
      `  <item id="${escapeXml(r.id)}" status="${r.status}" duration_ms="${r.duration}">${escapeXml(r.output)}</item>`,
    )
  }
  lines.push("</swarm_results>")
  return lines.join("\n")
}

const bgRuntime = makeRuntime(BackgroundJob.Service, BackgroundJob.defaultLayer)
const log = Log.create({ service: "tool.swarm" })

export const SwarmTool = Tool.defineEffect(
  id,
  Effect.gen(function* () {
    return {
      parallelSafe: true,
      description: DESCRIPTION,
      parameters,
      async execute(params: z.infer<typeof parameters>, ctx: Tool.Context) {
        const cfg = await Config.get()

        if (cfg.experimental?.swarm === false) {
          throw new Error("Swarm mode is disabled. Remove experimental.swarm = false from config.")
        }

        // Validate agent exists
        const agent = await Agent.get(params.agent)
        if (!agent) {
          throw new Error(`Unknown agent type: ${params.agent}`)
        }

        // Validate item count
        const maxItems = cfg.experimental?.swarm_max_items ?? 128
        if (params.items.length === 0) {
          throw new Error("Swarm items array is empty")
        }
        if (params.items.length > maxItems) {
          throw new Error(`Swarm items exceed max: ${params.items.length} > ${maxItems}`)
        }

        // Normalize items: separate id from input values
        const items: Swarm.Item[] = params.items.map((raw) => {
          const { id: itemID, ...rest } = raw
          return { id: itemID, input: rest }
        })

        // Validate template
        const errors = Swarm.validate(params.template, items)
        if (errors.length > 0) {
          throw new Error(`Template validation failed:\n${errors.join("\n")}`)
        }

        // Resolve concurrency (respect per-swarm config cap)
        const configCap = cfg.experimental?.swarm_concurrency ?? 5
        const concurrency = Math.min(params.concurrency, configCap)

        const config: Swarm.Config = {
          template: params.template,
          items,
          agent: params.agent,
          concurrency,
          background: params.background,
        }

        // Get parent model info
        const msg = MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
        if (msg.info.role !== "assistant") throw new Error("Not an assistant message")
        const model = agent.model ?? {
          modelID: msg.info.modelID,
          providerID: msg.info.providerID,
        }

        const input = {
          config,
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          model: { providerID: String(model.providerID), modelID: String(model.modelID) },
          variant: msg.info.variant,
          abort: ctx.abort,
        }

        const metadata = {
          agent: params.agent,
          total: items.length,
          concurrency,
          background: params.background,
        }

        ctx.metadata({ title: `Swarm: ${params.agent} x${items.length}`, metadata })

        // --- Background path ---
        if (params.background) {
          const jobID = Identifier.ascending("job")

          const inject = Instance.bind(async (state: "completed" | "error", text: string) => {
            try {
              await Bus.publish(TuiEvent.BackgroundTaskUpdate, {
                sessionID: ctx.sessionID,
                taskID: jobID,
                title: `Swarm: ${params.agent} x${items.length}`,
                state,
              })
              await Bus.publish(TuiEvent.ToastShow, {
                title: state === "completed" ? "Swarm complete" : "Swarm failed",
                message:
                  state === "completed"
                    ? `Swarm "${params.agent}" (${items.length} items) finished.`
                    : `Swarm "${params.agent}" failed: ${text}`,
                variant: state === "completed" ? "success" : "error",
                duration: 5000,
              })
              // Auto-inject results back to parent session
              if (state === "completed") {
                await SessionPrompt.prompt({
                  messageID: MessageID.ascending(),
                  sessionID: ctx.sessionID,
                  parts: [{ type: "text", text: `[Swarm results delivered]\n\n${text}` }],
                })
              }
            } catch (err) {
              log.error("swarm inject failed", { error: err instanceof Error ? err.message : String(err) })
            }
          })

          const run = Effect.tryPromise({
            try: () => execute(input),
            catch: (err) => err,
          }).pipe(
            Effect.map((output) => formatResults(output)),
            Effect.tap((text) => Effect.promise(() => inject("completed", text)).pipe(Effect.ignore)),
            Effect.catch((cause: unknown) =>
              Effect.gen(function* () {
                const err = cause instanceof Error ? cause.message : String(cause)
                yield* Effect.promise(() => inject("error", err)).pipe(Effect.ignore)
                return yield* Effect.fail(cause)
              }),
            ),
          )

          await bgRuntime.runPromise((svc) =>
            svc.start({
              id: jobID,
              type: "swarm",
              title: `Swarm: ${params.agent} x${items.length}`,
              metadata,
              run,
            }),
          )

          await Bus.publish(TuiEvent.BackgroundTaskUpdate, {
            sessionID: ctx.sessionID,
            taskID: jobID,
            title: `Swarm: ${params.agent} x${items.length}`,
            state: "running",
          })

          return {
            title: `Swarm: ${params.agent} x${items.length}`,
            metadata: { ...metadata, jobId: jobID },
            output: [
              `task_id: ${jobID}`,
              "state: running",
              "",
              `Swarm dispatched ${items.length} items to agent "${params.agent}". Results will be delivered when all complete.`,
            ].join("\n"),
          }
        }

        // --- Foreground path ---
        const output = await execute(input)

        return {
          title: `Swarm: ${params.agent} x${items.length}`,
          metadata,
          output: formatResults(output),
        }
      },
    }
  }),
)
