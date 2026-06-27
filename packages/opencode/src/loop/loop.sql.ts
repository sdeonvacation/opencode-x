import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/session.sql"
import type { LoopID } from "./schema"
import type { SessionID } from "../session/schema"

export const LoopTable = sqliteTable(
  "loop",
  {
    id: text().$type<LoopID>().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    prompt: text().notNull(),
    interval_ms: integer().notNull(),
    status: text().notNull().default("active"),
    model: text(),
    token_budget: integer(),
    tokens_used: integer().notNull().default(0),
    iteration_count: integer().notNull().default(0),
    next_run_at: integer().notNull(),
    last_run_at: integer(),
    last_subagent_session_id: text(),
    expires_at: integer().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    index("loop_session_idx").on(table.session_id),
    index("loop_status_idx").on(table.session_id, table.status),
    index("loop_due_idx").on(table.status, table.next_run_at),
  ],
)
