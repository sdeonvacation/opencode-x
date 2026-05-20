import { Database, eq, and } from "@/storage/db"
import { GoalTable } from "./goal.sql"
import { GoalID } from "./schema"
import type { SessionID } from "../session/schema"
import { Log } from "../util/log"

const log = Log.create({ service: "goal" })

export namespace Goal {
  export type Status = "active" | "paused" | "budget_limited" | "complete"

  export type Info = {
    id: GoalID
    session_id: SessionID
    objective: string
    status: Status
    token_budget: number | null
    tokens_used: number
    turns_used: number
    time_used_secs: number
    created_at: number
    completed_at: number | null
  }

  export function create(input: { sessionID: SessionID; objective: string; tokenBudget?: number }): Info {
    const id = GoalID.generate()
    // Purge all previous goals for this session
    Database.use((db) => db.delete(GoalTable).where(eq(GoalTable.session_id, input.sessionID)).run())
    const row = {
      id,
      session_id: input.sessionID,
      objective: input.objective,
      status: "active" as const,
      token_budget: input.tokenBudget ?? null,
      tokens_used: 0,
      turns_used: 0,
      time_used_secs: 0,
      created_at: Date.now(),
      completed_at: null,
    }
    Database.use((db) => db.insert(GoalTable).values(row).run())
    log.info("created", { id, sessionID: input.sessionID, objective: input.objective })
    return row as Info
  }

  export function get(sessionID: SessionID): Info | null {
    const rows = Database.use((db) =>
      db
        .select()
        .from(GoalTable)
        .where(and(eq(GoalTable.session_id, sessionID), eq(GoalTable.status, "active")))
        .all(),
    )
    return (rows[0] as Info) ?? null
  }

  export function complete(input: { id: GoalID; evidence: string }): Info {
    Database.use((db) =>
      db
        .update(GoalTable)
        .set({ status: "complete", completed_at: Date.now() })
        .where(eq(GoalTable.id, input.id))
        .run(),
    )
    log.info("completed", { id: input.id, evidence: input.evidence })
    const rows = Database.use((db) => db.select().from(GoalTable).where(eq(GoalTable.id, input.id)).all())
    return rows[0] as Info
  }

  export function pause(input: { id: GoalID; reason: string; budgetLimited?: boolean }): Info {
    const status: Status = input.budgetLimited ? "budget_limited" : "paused"
    Database.use((db) => db.update(GoalTable).set({ status }).where(eq(GoalTable.id, input.id)).run())
    log.info("paused", { id: input.id, reason: input.reason, status })
    const rows = Database.use((db) => db.select().from(GoalTable).where(eq(GoalTable.id, input.id)).all())
    return rows[0] as Info
  }

  export function tick(input: { id: GoalID; tokens: number; turns: number }): Info {
    const rows = Database.use((db) => db.select().from(GoalTable).where(eq(GoalTable.id, input.id)).all())
    const goal = rows[0] as Info | undefined
    if (!goal) throw new Error(`Goal not found: ${input.id}`)

    const used = goal.tokens_used + input.tokens
    const turns = goal.turns_used + input.turns

    Database.use((db) =>
      db.update(GoalTable).set({ tokens_used: used, turns_used: turns }).where(eq(GoalTable.id, input.id)).run(),
    )

    if (goal.token_budget && used >= goal.token_budget) {
      return pause({ id: input.id, reason: "Token budget exceeded", budgetLimited: true })
    }

    return { ...goal, tokens_used: used, turns_used: turns }
  }

  export function addendum(goal: Info): string {
    const lines = [
      `<active-goal>`,
      `Objective: ${goal.objective}`,
      `Status: ${goal.status}`,
      `Turns used: ${goal.turns_used}/200`,
    ]
    if (goal.token_budget) lines.push(`Token budget: ${goal.tokens_used}/${goal.token_budget}`)
    lines.push(`When you have fully achieved the objective, call the goal_complete tool with evidence of completion.`)
    lines.push(`</active-goal>`)
    return lines.join("\n")
  }
}
