import path from "path"
import fs from "fs/promises"
import { Global } from "@/global"
import type { SessionID } from "./schema"

export function metaDir(session: SessionID): string {
  return path.join(Global.Path.data, "meta", session)
}

export function checkpointPath(session: SessionID): string {
  return path.join(metaDir(session), "checkpoint.md")
}

export function memoryPath(session: SessionID): string {
  return path.join(metaDir(session), "memory.md")
}

export function globalMemoryPath(): string {
  return path.join(Global.Path.data, "memory", "memory.md")
}

export function notesPath(session: SessionID): string {
  return path.join(metaDir(session), "notes.md")
}

export function tasksDir(session: SessionID): string {
  return path.join(metaDir(session), "tasks")
}

export function progressPath(session: SessionID): string {
  return path.join(metaDir(session), "progress.md")
}

export async function migrateProjectMemory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}
