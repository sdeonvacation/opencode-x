import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/session.sql"
import { Timestamps } from "../storage/schema.sql"
import type { SessionID } from "../session/schema"
import type { MemoryID } from "./memory"

export const MemoryTable = sqliteTable(
  "memory",
  {
    id: text().$type<MemoryID>().primaryKey(),
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    content: text().notNull(),
    position: integer().notNull(),
    ...Timestamps,
  },
  (table) => [index("memory_session_idx").on(table.session_id)],
)
