import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/session.sql"
import type { ResearchID } from "./schema"
import type { SessionID } from "../session/schema"

export const ResearchRunTable = sqliteTable(
  "research_run",
  {
    id: text().$type<ResearchID>().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    question: text().notNull(),
    status: text().notNull().default("running"),
    stats_json: text(),
    report_json: text(),
    created_at: integer().notNull(),
    completed_at: integer(),
  },
  (table) => [index("research_run_session_idx").on(table.session_id)],
)
