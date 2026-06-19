import { Database, eq } from "@/storage/db"
import { WorkflowRunTable } from "./workflow.sql"
import type { WorkflowRunID } from "./schema"
import type { SessionID } from "../session/schema"
import { mkdirSync, appendFileSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs"
import path from "path"
import { Global } from "@/global"

export namespace WorkflowPersistence {
  export type RunStatus = "running" | "completed" | "failed" | "cancelled"

  export type JournalEntry = {
    type: "agent_start" | "agent_complete" | "agent_failed" | "phase" | "log"
    timestamp: number
    data: Record<string, unknown>
  }

  export type WorkflowRun = typeof WorkflowRunTable.$inferSelect

  function journalPath(id: WorkflowRunID) {
    return path.join(Global.Path.data, "workflow", id, "journal.jsonl")
  }

  function scriptPath(sha: string) {
    return path.join(Global.Path.data, "workflow", "scripts", sha + ".js")
  }

  export function recordStart(input: {
    id: WorkflowRunID
    session: SessionID
    name: string
    script: string
    args: unknown
    timeout: number
    parent?: string
  }) {
    const sha = new Bun.CryptoHasher("sha256").update(input.script).digest("hex")
    writeScript(sha, input.script)
    Database.use((db) =>
      db
        .insert(WorkflowRunTable)
        .values({
          id: input.id,
          session_id: input.session,
          name: input.name,
          status: "running",
          script_sha: sha,
          args: input.args != null ? JSON.stringify(input.args) : null,
          agent_timeout_ms: input.timeout,
          parent_actor_id: input.parent ?? null,
        })
        .run(),
    )
  }

  export function recordPhase(id: WorkflowRunID, phase: string) {
    Database.use((db) =>
      db.update(WorkflowRunTable).set({ current_phase: phase }).where(eq(WorkflowRunTable.id, id)).run(),
    )
  }

  export function flushCounters(id: WorkflowRunID, counts: { running: number; succeeded: number; failed: number }) {
    Database.use((db) =>
      db
        .update(WorkflowRunTable)
        .set({ running: counts.running, succeeded: counts.succeeded, failed: counts.failed })
        .where(eq(WorkflowRunTable.id, id))
        .run(),
    )
  }

  export function recordTerminal(id: WorkflowRunID, status: RunStatus, error?: string) {
    Database.use((db) =>
      db
        .update(WorkflowRunTable)
        .set({ status, error: error ?? null })
        .where(eq(WorkflowRunTable.id, id))
        .run(),
    )
  }

  export function list(session?: SessionID): WorkflowRun[] {
    if (session) {
      return Database.use((db) =>
        db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.session_id, session)).all(),
      )
    }
    return Database.use((db) => db.select().from(WorkflowRunTable).all())
  }

  export function load(id: WorkflowRunID): WorkflowRun | undefined {
    return Database.use((db) => db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.id, id)).get())
  }

  export function writeScript(sha: string, source: string) {
    const target = scriptPath(sha)
    if (existsSync(target)) return
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, source)
  }

  export function readScript(sha: string): string | undefined {
    const target = scriptPath(sha)
    if (!existsSync(target)) return undefined
    return readFileSync(target, "utf-8")
  }

  export function appendJournal(id: WorkflowRunID, entry: JournalEntry) {
    const target = journalPath(id)
    mkdirSync(path.dirname(target), { recursive: true })
    appendFileSync(target, JSON.stringify(entry) + "\n")
  }

  export function loadJournal(id: WorkflowRunID): JournalEntry[] {
    const target = journalPath(id)
    if (!existsSync(target)) return []
    const content = readFileSync(target, "utf-8")
    const entries: JournalEntry[] = []
    for (const line of content.split("\n")) {
      if (!line) continue
      try {
        entries.push(JSON.parse(line))
      } catch {
        // skip malformed lines
      }
    }
    return entries
  }

  export function clearJournal(id: WorkflowRunID) {
    const target = journalPath(id)
    if (existsSync(target)) rmSync(target)
  }
}
