import { Swarm, SwarmEvent } from "./index"
import { Bus } from "../bus"
import { SessionID, MessageID } from "../session/schema"
import { SessionPrompt } from "../session/prompt"
import { Agent } from "../agent/agent"
import { Config } from "../config/config"
import { spawnSubagent } from "../orchestration/task-spawn"
import { acquire, release } from "../orchestration/concurrency"
import { withTimeout } from "@/util/timeout"
import { ModelID, ProviderID } from "../provider/schema"
import * as SpawnLimits from "../orchestration/spawn-limits"
import { Log } from "@/util/log"

const log = Log.create({ service: "swarm.executor" })

const SUBAGENT_TIMEOUT = 1_800_000

export type ExecuteInput = {
  config: Swarm.Config
  sessionID: SessionID
  messageID: MessageID
  model: { providerID: string; modelID: string }
  variant?: string
  abort: AbortSignal
}

export type ExecuteOutput = {
  results: Swarm.Result[]
  total: number
  success: number
  failed: number
  skipped: number
  durationMs: number
}

export async function execute(input: ExecuteInput): Promise<ExecuteOutput> {
  const { config, sessionID, abort } = input
  const cfg = await Config.get()
  const timeout = cfg.experimental?.subagent_timeout ?? SUBAGENT_TIMEOUT
  const maxDepth = cfg.experimental?.max_subagent_depth ?? 3
  const maxDescendants = cfg.experimental?.max_subagent_descendants ?? 50
  const key = `${input.model.providerID}:${input.model.modelID}`
  const concurrencyLimit = cfg.experimental?.model_concurrency?.[key] ?? 5

  const agent = await Agent.get(config.agent)
  if (!agent) throw new Error(`Unknown agent type: ${config.agent}`)

  // Pre-check spawn capacity
  try {
    await SpawnLimits.assertCanSpawn({
      sessionID,
      parentID: sessionID,
      maxDepth,
      maxDescendants,
    })
  } catch (err) {
    if (err instanceof SpawnLimits.SpawnLimitError && err.reason === "max_descendants") {
      throw new Error(`Spawn limit: 0 slots available (${err.current}/${err.limit} descendants used)`)
    }
    throw err
  }

  const started = Date.now()
  const items = config.items

  await Bus.publish(SwarmEvent.Started, {
    sessionID: String(sessionID),
    agent: config.agent,
    total: items.length,
    concurrency: config.concurrency,
  })

  // Bounded parallel execution with incremental progress events
  const results: Swarm.Result[] = []
  const semaphore = new Semaphore(config.concurrency)

  const tasks = items.map((item) =>
    semaphore.run(async () => {
      if (abort.aborted) {
        return { id: item.id, status: "error" as const, output: "Aborted", duration: 0 }
      }

      const start = Date.now()
      try {
        const subagent = await spawnSubagent(undefined, {
          parentSessionID: sessionID,
          agent,
          description: `swarm: ${item.id}`,
          canTask: false,
          canTodo: false,
          taskPermissionID: "swarm",
          primaryTools: cfg.experimental?.primary_tools,
          maxDepth,
          maxDescendants,
        })

        const child = subagent.session
        const rendered = Swarm.render(config.template, item.input)
        const messageID = MessageID.ascending()

        await acquire(key, concurrencyLimit, abort)
        try {
          const result = await withTimeout(
            SessionPrompt.prompt({
              messageID,
              sessionID: child.id,
              model: {
                modelID: ModelID.make(input.model.modelID),
                providerID: ProviderID.make(input.model.providerID),
              },
              variant: input.variant,
              agent: config.agent,
              tools: {
                task: false,
                swarm: false,
                todowrite: false,
                goal_complete: false,
              },
              parts: [{ type: "text", text: rendered }],
            }),
            timeout,
          ).catch((err) => {
            if (err instanceof Error && err.message.includes("Operation timed out")) {
              SessionPrompt.cancel(child.id)
              throw new Error(`Item "${item.id}" timed out after ${timeout}ms`)
            }
            throw err
          })

          const last = result.parts.findLast((p: { type: string }) => p.type === "text")
          const text = last && "text" in last ? (last as { text: string }).text : ""
          return { id: item.id, status: "done" as const, output: text, duration: Date.now() - start }
        } finally {
          release(key)
          if (subagent.spawned) subagent.spawnInfo.release()
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.error("swarm item failed", { itemID: item.id, error: msg })
        return { id: item.id, status: "error" as const, output: msg, duration: Date.now() - start }
      }
    }),
  )

  const settled = await Promise.allSettled(
    tasks.map(async (task) => {
      const result = await task
      results.push(result)
      await Bus.publish(SwarmEvent.ItemComplete, {
        sessionID: String(sessionID),
        itemID: result.id,
        status: result.status,
        completed: results.length,
        total: items.length,
      })
      return result
    }),
  )

  const durationMs = Date.now() - started
  const success = results.filter((r) => r.status === "done").length
  const failed = results.filter((r) => r.status === "error").length

  await Bus.publish(SwarmEvent.Done, {
    sessionID: String(sessionID),
    success,
    failed,
    total: items.length,
    durationMs,
  })

  return { results, total: items.length, success, failed, skipped: 0, durationMs }
}

// --- Minimal semaphore for bounded concurrency ---
class Semaphore {
  private active = 0
  private queue: (() => void)[] = []

  constructor(private limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.queue.push(resolve)
    })
  }

  private release(): void {
    const next = this.queue.shift()
    if (next) {
      next()
    } else {
      this.active--
    }
  }
}
