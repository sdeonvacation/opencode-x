import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/session.sql"
import { Timestamps } from "../storage/schema.sql"
import type { WorkflowRunID } from "./schema"
import type { SessionID } from "../session/schema"

export const WorkflowRunTable = sqliteTable(
  "workflow_run",
  {
    id: text().$type<WorkflowRunID>().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    status: text().notNull().default("running"),
    running: integer().notNull().default(0),
    succeeded: integer().notNull().default(0),
    failed: integer().notNull().default(0),
    current_phase: text(),
    parent_actor_id: text(),
    args: text(),
    script_sha: text().notNull(),
    agent_timeout_ms: integer().notNull().default(300000),
    error: text(),
    ...Timestamps,
  },
  (table) => [
    index("workflow_run_session_idx").on(table.session_id),
    index("workflow_run_status_idx").on(table.status),
  ],
)
