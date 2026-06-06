import { Database, eq, and, lt } from "@/storage/db"
import { BranchPRTable } from "./branch-pr.sql"
import type { SessionID } from "../session/schema"
import { Log } from "../util/log"

const log = Log.create({ service: "branch-pr-state" })

export type PRState = "open" | "merged" | "rejected" | "conflict"

export type BranchPRRow = {
  id: string
  session_id: SessionID
  parent_session_id: SessionID
  branch: string
  base: string
  slug: string
  state: PRState
  diff_summary: string | null
  review_note: string | null
  created_at: number
  merged_at: number | null
}

export namespace BranchPRState {
  export function insert(row: Omit<BranchPRRow, "merged_at"> & { merged_at?: number | null }) {
    Database.use((db) =>
      db
        .insert(BranchPRTable)
        .values({ ...row, merged_at: row.merged_at ?? null })
        .run(),
    )
    log.info("inserted", { id: row.id, branch: row.branch, state: row.state })
  }

  export function update(input: { id: string; state: PRState; note?: string; mergedAt?: number }) {
    Database.use((db) =>
      db
        .update(BranchPRTable)
        .set({
          state: input.state,
          ...(input.note !== undefined ? { review_note: input.note } : {}),
          ...(input.mergedAt !== undefined ? { merged_at: input.mergedAt } : {}),
        })
        .where(eq(BranchPRTable.id, input.id))
        .run(),
    )
    log.info("updated", { id: input.id, state: input.state })
  }

  export function get(id: string): BranchPRRow | undefined {
    const rows = Database.use((db) => db.select().from(BranchPRTable).where(eq(BranchPRTable.id, id)).all())
    return rows[0] as BranchPRRow | undefined
  }

  export function pending(session: SessionID): BranchPRRow[] {
    const rows = Database.use((db) =>
      db
        .select()
        .from(BranchPRTable)
        .where(and(eq(BranchPRTable.parent_session_id, session), eq(BranchPRTable.state, "open")))
        .all(),
    )
    return rows as BranchPRRow[]
  }

  export function stale(olderThan: number): BranchPRRow[] {
    const rows = Database.use((db) =>
      db
        .select()
        .from(BranchPRTable)
        .where(and(eq(BranchPRTable.state, "open"), lt(BranchPRTable.created_at, olderThan)))
        .all(),
    )
    return rows as BranchPRRow[]
  }
}
