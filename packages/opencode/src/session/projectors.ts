import { sql } from "drizzle-orm"
import { Database, NotFoundError, eq, and } from "../storage/db"
import { SyncEvent } from "@/sync"
import { Session } from "./index"
import { MessageV2 } from "./message-v2"
import { SessionTable, MessageTable, PartTable } from "./session.sql"
import { ProjectTable } from "../project/project.sql"
import { Log } from "../util/log"
import { SessionID } from "./schema"

const log = Log.create({ service: "session.projector" })

function foreign(err: unknown) {
  if (typeof err !== "object" || err === null) return false
  if ("code" in err && err.code === "SQLITE_CONSTRAINT_FOREIGNKEY") return true
  return "message" in err && typeof err.message === "string" && err.message.includes("FOREIGN KEY constraint failed")
}

export type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> | null } : T

function grab<T extends object, K1 extends keyof T, X>(
  obj: T,
  field1: K1,
  cb?: (val: NonNullable<T[K1]>) => X,
): X | undefined {
  if (obj == undefined || !(field1 in obj)) return undefined

  const val = obj[field1]
  if (val && typeof val === "object" && cb) {
    return cb(val)
  }
  if (val === undefined) {
    throw new Error(
      "Session update failure: pass `null` to clear a field instead of `undefined`: " + JSON.stringify(obj),
    )
  }
  return val as X | undefined
}

export function toPartialRow(info: DeepPartial<Session.Info>) {
  const obj = {
    id: grab(info, "id"),
    project_id: grab(info, "projectID"),
    workspace_id: grab(info, "workspaceID"),
    parent_id: grab(info, "parentID"),
    slug: grab(info, "slug"),
    directory: grab(info, "directory"),
    title: grab(info, "title"),
    version: grab(info, "version"),
    share_url: grab(info, "share", (v) => grab(v, "url")),
    summary_additions: grab(info, "summary", (v) => grab(v, "additions")),
    summary_deletions: grab(info, "summary", (v) => grab(v, "deletions")),
    summary_files: grab(info, "summary", (v) => grab(v, "files")),
    summary_diffs: grab(info, "summary", (v) => grab(v, "diffs")),
    revert: grab(info, "revert"),
    permission: grab(info, "permission"),
    time_created: grab(info, "time", (v) => grab(v, "created")),
    time_updated: grab(info, "time", (v) => grab(v, "updated")),
    time_compacting: grab(info, "time", (v) => grab(v, "compacting")),
    time_archived: grab(info, "time", (v) => grab(v, "archived")),
    cost: grab(info, "cost"),
    tokens_input: grab(info, "tokens", (v) => grab(v, "input")),
    tokens_output: grab(info, "tokens", (v) => grab(v, "output")),
    tokens_reasoning: grab(info, "tokens", (v) => grab(v, "reasoning")),
    tokens_cache_read: grab(info, "tokens", (v) => (v.cache ? v.cache.read : undefined)),
    tokens_cache_write: grab(info, "tokens", (v) => (v.cache ? v.cache.write : undefined)),
  }

  return Object.fromEntries(Object.entries(obj).filter(([_, val]) => val !== undefined))
}

type Usage = {
  cost: number
  tokens_input: number
  tokens_output: number
  tokens_reasoning: number
  tokens_cache_read: number
  tokens_cache_write: number
}

export function usage(data: unknown): Usage {
  const zero: Usage = {
    cost: 0,
    tokens_input: 0,
    tokens_output: 0,
    tokens_reasoning: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
  }
  if (!data || typeof data !== "object") return zero
  const d = data as Record<string, unknown>
  if (d.type !== "step-finish") return zero
  const t = d.tokens as Record<string, unknown> | undefined
  const cache = t && typeof t.cache === "object" && t.cache ? (t.cache as Record<string, unknown>) : undefined
  return {
    cost: typeof d.cost === "number" ? d.cost : 0,
    tokens_input: t && typeof t.input === "number" ? t.input : 0,
    tokens_output: t && typeof t.output === "number" ? t.output : 0,
    tokens_reasoning: t && typeof t.reasoning === "number" ? t.reasoning : 0,
    tokens_cache_read: cache && typeof cache.read === "number" ? cache.read : 0,
    tokens_cache_write: cache && typeof cache.write === "number" ? cache.write : 0,
  }
}

function applyUsage(db: Database.TxOrDb, sessionID: string, u: Usage, sign: 1 | -1) {
  db.update(SessionTable)
    .set({
      cost: sign === 1 ? sql`${SessionTable.cost} + ${u.cost}` : undefined,
      tokens_input: sql`${SessionTable.tokens_input} + ${sign * u.tokens_input}`,
      tokens_output: sql`${SessionTable.tokens_output} + ${sign * u.tokens_output}`,
      tokens_reasoning: sql`${SessionTable.tokens_reasoning} + ${sign * u.tokens_reasoning}`,
      tokens_cache_read: sql`${SessionTable.tokens_cache_read} + ${sign * u.tokens_cache_read}`,
      tokens_cache_write: sql`${SessionTable.tokens_cache_write} + ${sign * u.tokens_cache_write}`,
    })
    .where(eq(SessionTable.id, sessionID as SessionID))
    .run()
}

export default [
  SyncEvent.project(Session.Event.Created, (db, data) => {
    db.insert(SessionTable).values(Session.toRow(data.info)).run()
  }),

  SyncEvent.project(Session.Event.Updated, (db, data) => {
    const info = data.info
    const row = db
      .update(SessionTable)
      .set(toPartialRow(info))
      .where(eq(SessionTable.id, data.sessionID))
      .returning()
      .get()
    if (!row) throw new NotFoundError({ message: `Session not found: ${data.sessionID}` })
  }),

  SyncEvent.project(Session.Event.Deleted, (db, data) => {
    db.delete(SessionTable).where(eq(SessionTable.id, data.sessionID)).run()
  }),

  SyncEvent.project(MessageV2.Event.Updated, (db, data) => {
    const time_created = data.info.time.created
    const { id, sessionID, ...rest } = data.info

    try {
      db.insert(MessageTable)
        .values({
          id,
          session_id: sessionID,
          time_created,
          data: rest,
        })
        .onConflictDoUpdate({ target: MessageTable.id, set: { data: rest } })
        .run()
    } catch (err) {
      if (!foreign(err)) throw err
      log.warn("ignored late message update", { messageID: id, sessionID })
    }
  }),

  SyncEvent.project(MessageV2.Event.Removed, (db, data) => {
    const parts = db.select().from(PartTable).where(eq(PartTable.message_id, data.messageID)).all()
    for (const p of parts) applyUsage(db, data.sessionID, usage(p.data), -1)
    db.delete(MessageTable)
      .where(and(eq(MessageTable.id, data.messageID), eq(MessageTable.session_id, data.sessionID)))
      .run()
  }),

  SyncEvent.project(MessageV2.Event.PartRemoved, (db, data) => {
    const old = db.select().from(PartTable).where(eq(PartTable.id, data.partID)).get()
    if (old) applyUsage(db, data.sessionID, usage(old.data), -1)
    db.delete(PartTable)
      .where(and(eq(PartTable.id, data.partID), eq(PartTable.session_id, data.sessionID)))
      .run()
  }),

  SyncEvent.project(MessageV2.Event.PartUpdated, (db, data) => {
    const { id, messageID, sessionID, ...rest } = data.part

    const old = db.select().from(PartTable).where(eq(PartTable.id, id)).get()
    const oldUsage = usage(old?.data)

    try {
      db.insert(PartTable)
        .values({
          id,
          message_id: messageID,
          session_id: sessionID,
          time_created: data.time,
          data: rest,
        })
        .onConflictDoUpdate({ target: PartTable.id, set: { data: rest } })
        .run()
    } catch (err) {
      if (!foreign(err)) throw err
      log.warn("ignored late part update", { partID: id, messageID, sessionID })
      return
    }

    applyUsage(db, sessionID, oldUsage, -1)
    applyUsage(db, sessionID, usage(rest), 1)
  }),
]
