import { Effect } from "effect"
import { Loop } from "./loop"
import { Bus } from "../bus"
import { Config } from "../config/config"
import { Log } from "../util/log"
import { spawnSubagent } from "../orchestration/task-spawn"
import { Agent } from "../agent/agent"
import { BackgroundJob } from "../background/job"
import { makeRuntime } from "../effect/run-service"
import { SessionPrompt } from "../session/prompt"
import { Provider } from "../provider/provider"
import { TuiEvent } from "../cli/cmd/tui/event"
import { Database } from "../storage/db"
import { SessionTable } from "../session/session.sql"
import { eq } from "drizzle-orm"
import type { SessionID } from "../session/schema"
import type { LoopID } from "./schema"

const log = Log.create({ service: "loop.scheduler" })

const bgRuntime = makeRuntime(BackgroundJob.Service, BackgroundJob.defaultLayer)

// Track running iterations to detect overlap
const runningIterations = new Set<LoopID>()

// Track scheduler intervals per session
const schedulerIntervals = new Map<SessionID, ReturnType<typeof setInterval>>()

export namespace LoopScheduler {
  export function start(sessionID: SessionID): void {
    if (schedulerIntervals.has(sessionID)) return

    const interval = setInterval(() => {
      tickOnce(sessionID).catch((err) => {
        log.error("tick failed", { sessionID, error: err instanceof Error ? err.message : String(err) })
      })
    }, 1000)

    schedulerIntervals.set(sessionID, interval)
    log.info("started", { sessionID })
  }

  export function stop(sessionID: SessionID): void {
    const interval = schedulerIntervals.get(sessionID)
    if (!interval) return
    clearInterval(interval)
    schedulerIntervals.delete(sessionID)

    const loops = Loop.list(sessionID)
    for (const loop of loops) {
      if (loop.status === "active" || loop.status === "paused") {
        Loop.cancel({ id: loop.id })
      }
    }
    log.info("stopped", { sessionID })
  }

  export function isRunning(sessionID: SessionID): boolean {
    return schedulerIntervals.has(sessionID)
  }

  async function tickOnce(sessionID: SessionID): Promise<void> {
    const now = Date.now()
    const dueLoops = Loop.listDue(now)

    for (const loop of dueLoops) {
      if (loop.session_id !== sessionID) continue
      if (runningIterations.has(loop.id)) continue

      if (now >= loop.expires_at) {
        Loop.expire({ id: loop.id })
        continue
      }

      if (loop.token_budget && loop.tokens_used >= loop.token_budget) {
        Loop.budgetExhaust({ id: loop.id })
        continue
      }

      spawnIteration(loop).catch((err) => {
        log.error("spawn failed", { loopID: loop.id, error: err instanceof Error ? err.message : String(err) })
      })
    }
  }

  async function spawnIteration(loop: Loop.Info): Promise<void> {
    runningIterations.add(loop.id)

    const cleanup = () => runningIterations.delete(loop.id)

    const agent = await Agent.get("general")
    const model = await resolveModel(loop)

    const result = await spawnSubagent(undefined, {
      parentSessionID: loop.session_id,
      agent,
      description: `Loop #${loop.iteration_count + 1}: ${loop.prompt.slice(0, 50)}`,
      canTask: false,
      canTodo: false,
      taskPermissionID: "task",
      maxDepth: 1,
      maxDescendants: 100,
    }).catch((err) => {
      cleanup()
      throw err
    })

    if (!result.spawned) {
      cleanup()
      return
    }

    const subSessionID = result.session.id
    Loop.tick({ id: loop.id, subagentSessionID: subSessionID })

    const promptInput: Parameters<typeof SessionPrompt.prompt>[0] = {
      sessionID: subSessionID,
      parts: [{ type: "text", text: loop.prompt }],
      ...(model ? { model } : {}),
    }

    const makeRun = () =>
      Effect.tryPromise({
        try: () => SessionPrompt.prompt(promptInput),
        catch: (err) => err,
      }).pipe(Effect.map(() => `Loop iteration ${loop.iteration_count + 1} complete`))

    bgRuntime
      .runPromise((svc) =>
        Effect.gen(function* () {
          yield* svc.start({
            id: subSessionID,
            type: "loop-iteration",
            title: `Loop: ${loop.prompt.slice(0, 40)}`,
            metadata: {
              loopID: loop.id,
              iteration: loop.iteration_count + 1,
              parentSessionID: loop.session_id,
            },
            run: makeRun(),
          })
          return yield* svc.wait({ id: subSessionID })
        }),
      )
      .then(async (result) => {
        // Job complete — session tokens now populated
        const sessions = Database.use((db) =>
          db.select().from(SessionTable).where(eq(SessionTable.id, subSessionID)).all(),
        )
        const s = sessions[0]
        const tokens = s ? s.tokens_input + s.tokens_output + s.tokens_reasoning : 0

        Loop.tickComplete({ id: loop.id, tokens, sessionID: subSessionID })

        const status = result.info?.status
        await Bus.publish(TuiEvent.BackgroundTaskUpdate, {
          sessionID: loop.session_id,
          taskID: subSessionID,
          title: `Loop: ${loop.prompt.slice(0, 40)}`,
          state: status === "completed" ? "completed" : "error",
        }).catch(() => {})
      })
      .catch((err) => {
        log.error("iteration failed", {
          loopID: loop.id,
          error: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(cleanup)

    // Publish initial running state
    await Bus.publish(TuiEvent.BackgroundTaskUpdate, {
      sessionID: loop.session_id,
      taskID: subSessionID,
      title: `Loop: ${loop.prompt.slice(0, 40)}`,
      state: "running",
    })
  }

  async function resolveModel(loop: Loop.Info): Promise<ReturnType<typeof Provider.parseModel> | undefined> {
    // Priority: loop.model → config.loop.model → config.small_model → undefined (session default)
    if (loop.model) return Provider.parseModel(loop.model)

    const cfg = await Config.get()
    const loopModel = cfg.loop?.model
    if (loopModel) return Provider.parseModel(loopModel)

    const smallModel = cfg.small_model
    if (smallModel) return Provider.parseModel(smallModel)

    return undefined
  }
}
