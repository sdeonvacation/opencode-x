import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/session.sql"
import type { GoalID } from "./schema"
import type { SessionID } from "../session/schema"

export const GoalTable = sqliteTable(
  "goal",
  {
    id: text().$type<GoalID>().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    objective: text().notNull(),
    status: text().notNull().default("active"),
    token_budget: integer(),
    tokens_used: integer().notNull().default(0),
    turns_used: integer().notNull().default(0),
    time_used_secs: integer().notNull().default(0),
    created_at: integer().notNull(),
    completed_at: integer(),
  },
  (table) => [
    index("goal_session_idx").on(table.session_id),
    index("goal_status_idx").on(table.session_id, table.status),
  ],
)
