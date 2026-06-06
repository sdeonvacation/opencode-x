import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/session.sql"
import type { SessionID } from "../session/schema"

export const BranchPRTable = sqliteTable(
  "branch_pr",
  {
    id: text().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    parent_session_id: text().$type<SessionID>().notNull(),
    branch: text().notNull(),
    base: text().notNull(),
    slug: text().notNull(),
    state: text().notNull().default("open"),
    diff_summary: text(),
    review_note: text(),
    created_at: integer().notNull(),
    merged_at: integer(),
  },
  (table) => [
    index("branch_pr_session_idx").on(table.session_id),
    index("branch_pr_parent_idx").on(table.parent_session_id),
    index("branch_pr_state_idx").on(table.parent_session_id, table.state),
  ],
)
