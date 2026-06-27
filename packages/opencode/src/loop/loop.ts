import { Database, eq, and, lte, inArray } from "@/storage/db"
import { LoopTable } from "./loop.sql"
import { LoopID } from "./schema"
import type { SessionID } from "../session/schema"
import { Log } from "../util/log"
import { Bus } from "../bus"
import { LoopEvent } from "./events"

const emit = (...args: Parameters<typeof Bus.publish>) => Bus.publish(...args).catch(() => {})

const log = Log.create({ service: "loop" })

const MAX_LOOPS_PER_SESSION = 20
const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000

export namespace Loop {
  export type Status = "active" | "paused" | "cancelled" | "expired" | "budget_exhausted"

  export type Info = {
    id: LoopID
    session_id: SessionID
    prompt: string
    interval_ms: number
    status: Status
    model: string | null
    token_budget: number | null
    tokens_used: number
    iteration_count: number
    next_run_at: number
    last_run_at: number | null
    last_subagent_session_id: string | null
    expires_at: number
    created_at: number
  }

  export function create(input: {
    sessionID: SessionID
    prompt: string
    intervalMs: number
    model?: string
    tokenBudget?: number
    maxLoops?: number
    expiryMs?: number
  }): Info {
    const maxLoops = input.maxLoops ?? MAX_LOOPS_PER_SESSION
    const activeOrPaused = Database.use((db) =>
      db
        .select()
        .from(LoopTable)
        .where(and(eq(LoopTable.session_id, input.sessionID), inArray(LoopTable.status, ["active", "paused"])))
        .all(),
    )
    if (activeOrPaused.length >= maxLoops) {
      throw new Error(`Maximum of ${maxLoops} loops per session reached`)
    }

    const id = LoopID.generate()
    const now = Date.now()
    const row = {
      id,
      session_id: input.sessionID,
      prompt: input.prompt,
      interval_ms: input.intervalMs,
      status: "active" as const,
      model: input.model ?? null,
      token_budget: input.tokenBudget ?? null,
      tokens_used: 0,
      iteration_count: 0,
      next_run_at: now + input.intervalMs,
      last_run_at: null,
      last_subagent_session_id: null,
      expires_at: now + (input.expiryMs ?? DEFAULT_EXPIRY_MS),
      created_at: now,
    }
    Database.use((db) => db.insert(LoopTable).values(row).run())
    log.info("created", { id, sessionID: input.sessionID, intervalMs: input.intervalMs })
    emit(LoopEvent.Created, {
      sessionID: input.sessionID,
      loopID: id,
      prompt: input.prompt,
      intervalMs: input.intervalMs,
    })
    return row as Info
  }

  export function get(id: LoopID): Info | null {
    const rows = Database.use((db) => db.select().from(LoopTable).where(eq(LoopTable.id, id)).all())
    return (rows[0] as Info) ?? null
  }

  export function list(sessionID: SessionID): Info[] {
    return Database.use((db) => db.select().from(LoopTable).where(eq(LoopTable.session_id, sessionID)).all()) as Info[]
  }

  export function listDue(now: number): Info[] {
    return Database.use((db) =>
      db
        .select()
        .from(LoopTable)
        .where(and(eq(LoopTable.status, "active"), lte(LoopTable.next_run_at, now)))
        .all(),
    ) as Info[]
  }

  export function tick(input: { id: LoopID; subagentSessionID: string }): Info {
    Database.use((db) =>
      db
        .update(LoopTable)
        .set({ last_subagent_session_id: input.subagentSessionID })
        .where(eq(LoopTable.id, input.id))
        .run(),
    )
    const rows = Database.use((db) => db.select().from(LoopTable).where(eq(LoopTable.id, input.id)).all())
    const loop = rows[0] as Info | undefined
    if (!loop) throw new Error(`Loop not found: ${input.id}`)
    log.info("tick", { id: input.id, subagentSessionID: input.subagentSessionID })
    emit(LoopEvent.IterationStarted, {
      sessionID: loop.session_id,
      loopID: input.id,
      iterationCount: loop.iteration_count + 1,
      subagentSessionID: input.subagentSessionID,
    })
    return loop
  }

  export function tickComplete(input: { id: LoopID; tokens: number; sessionID: string }): Info {
    const rows = Database.use((db) => db.select().from(LoopTable).where(eq(LoopTable.id, input.id)).all())
    const loop = rows[0] as Info | undefined
    if (!loop) throw new Error(`Loop not found: ${input.id}`)

    const now = Date.now()
    const iterationCount = loop.iteration_count + 1
    const tokensUsed = loop.tokens_used + input.tokens
    const jitterMax = Math.min(loop.interval_ms * 0.1, 300_000)
    const jitter = Math.floor(Math.random() * jitterMax)
    const nextRunAt = now + loop.interval_ms + jitter

    Database.use((db) =>
      db
        .update(LoopTable)
        .set({
          iteration_count: iterationCount,
          tokens_used: tokensUsed,
          last_run_at: now,
          last_subagent_session_id: input.sessionID,
          next_run_at: nextRunAt,
        })
        .where(eq(LoopTable.id, input.id))
        .run(),
    )

    log.info("tick-complete", { id: input.id, iterationCount, tokensUsed })
    emit(LoopEvent.IterationComplete, {
      sessionID: loop.session_id,
      loopID: input.id,
      iterationCount,
      tokensUsed,
    })

    // Check budget
    if (loop.token_budget && tokensUsed >= loop.token_budget) {
      return budgetExhaust({ id: input.id })
    }

    return {
      ...loop,
      iteration_count: iterationCount,
      tokens_used: tokensUsed,
      last_run_at: now,
      last_subagent_session_id: input.sessionID,
      next_run_at: nextRunAt,
    }
  }

  export function pause(input: { id: LoopID }): Info {
    Database.use((db) => db.update(LoopTable).set({ status: "paused" }).where(eq(LoopTable.id, input.id)).run())
    const rows = Database.use((db) => db.select().from(LoopTable).where(eq(LoopTable.id, input.id)).all())
    const loop = rows[0] as Info | undefined
    if (!loop) throw new Error(`Loop not found: ${input.id}`)
    log.info("paused", { id: input.id })
    emit(LoopEvent.Paused, { sessionID: loop.session_id, loopID: input.id })
    return loop
  }

  export function resume(input: { id: LoopID }): Info {
    const now = Date.now()
    const rows = Database.use((db) => db.select().from(LoopTable).where(eq(LoopTable.id, input.id)).all())
    const loop = rows[0] as Info | undefined
    if (!loop) throw new Error(`Loop not found: ${input.id}`)

    const nextRunAt = now + loop.interval_ms
    Database.use((db) =>
      db.update(LoopTable).set({ status: "active", next_run_at: nextRunAt }).where(eq(LoopTable.id, input.id)).run(),
    )
    log.info("resumed", { id: input.id, nextRunAt })
    emit(LoopEvent.Resumed, { sessionID: loop.session_id, loopID: input.id, nextRunAt })
    return { ...loop, status: "active" as const, next_run_at: nextRunAt }
  }

  export function cancel(input: { id: LoopID }): Info {
    Database.use((db) => db.update(LoopTable).set({ status: "cancelled" }).where(eq(LoopTable.id, input.id)).run())
    const rows = Database.use((db) => db.select().from(LoopTable).where(eq(LoopTable.id, input.id)).all())
    const loop = rows[0] as Info | undefined
    if (!loop) throw new Error(`Loop not found: ${input.id}`)
    log.info("cancelled", { id: input.id })
    emit(LoopEvent.Cancelled, { sessionID: loop.session_id, loopID: input.id })
    return loop
  }

  export function expire(input: { id: LoopID }): Info {
    Database.use((db) => db.update(LoopTable).set({ status: "expired" }).where(eq(LoopTable.id, input.id)).run())
    const rows = Database.use((db) => db.select().from(LoopTable).where(eq(LoopTable.id, input.id)).all())
    const loop = rows[0] as Info | undefined
    if (!loop) throw new Error(`Loop not found: ${input.id}`)
    log.info("expired", { id: input.id })
    emit(LoopEvent.Expired, { sessionID: loop.session_id, loopID: input.id })
    return loop
  }

  export function budgetExhaust(input: { id: LoopID }): Info {
    Database.use((db) =>
      db.update(LoopTable).set({ status: "budget_exhausted" }).where(eq(LoopTable.id, input.id)).run(),
    )
    const rows = Database.use((db) => db.select().from(LoopTable).where(eq(LoopTable.id, input.id)).all())
    const loop = rows[0] as Info | undefined
    if (!loop) throw new Error(`Loop not found: ${input.id}`)
    log.info("budget-exhausted", { id: input.id, tokensUsed: loop.tokens_used })
    emit(LoopEvent.BudgetExhausted, {
      sessionID: loop.session_id,
      loopID: input.id,
      tokensUsed: loop.tokens_used,
      tokenBudget: loop.token_budget!,
    })
    return loop
  }
}
