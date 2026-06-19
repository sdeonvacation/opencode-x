import { spawnSubagent } from "../orchestration/task-spawn"
import type { SessionID } from "./schema"
import type { Agent } from "../agent/agent"
import { AutoDream } from "./auto-dream"
import { Session } from "./index"
import { MessageV2 } from "./message-v2"
import { Log } from "../util/log"

const log = Log.create({ service: "dream-spawn" })

const MAX_CONTEXT_CHARS = 30_000
const MAX_SESSIONS = 15
const MAX_MESSAGES_PER_SESSION = 20

export function buildContext(days: number): string {
  const cutoff = Date.now() - days * AutoDream.DAY_MS
  const sessions: Array<{ title: string; time: number; id: SessionID }> = []

  for (const s of Session.list({ roots: true, start: cutoff, limit: MAX_SESSIONS })) {
    if (s.title.startsWith(AutoDream.AUTO_DREAM_TITLE)) continue
    if (s.title.startsWith(AutoDream.AUTO_DISTILL_TITLE)) continue
    sessions.push({ title: s.title, time: s.time.created, id: s.id })
  }

  if (sessions.length === 0) return ""

  let out = "## Recent Session History\n\n"
  let chars = out.length

  for (const s of sessions) {
    const header = `### ${s.title} (${new Date(s.time).toISOString().slice(0, 10)})\n\n`
    if (chars + header.length > MAX_CONTEXT_CHARS) break
    out += header
    chars += header.length

    const { items } = MessageV2.page({ sessionID: s.id, limit: MAX_MESSAGES_PER_SESSION })
    for (const msg of items) {
      const role = msg.info.role === "user" ? "User" : "Assistant"
      const texts = msg.parts
        .filter((p): p is MessageV2.TextPart => p.type === "text" && !("synthetic" in p && p.synthetic))
        .map((p) => p.text)
        .join("\n")
      if (!texts) continue

      const truncated = texts.length > 2000 ? texts.slice(0, 2000) + "..." : texts
      const entry = `**${role}**: ${truncated}\n\n`
      if (chars + entry.length > MAX_CONTEXT_CHARS) break
      out += entry
      chars += entry.length
    }
  }

  return out
}

async function kick(sessionID: SessionID, agent: string, task: string) {
  // Dynamic import avoids circular: prompt → dream-trigger → dream-spawn → prompt
  const { SessionPrompt } = await import("./prompt")
  SessionPrompt.prompt({
    sessionID,
    agent,
    parts: [{ type: "text", text: task }],
  }).catch((err) => log.info("dream prompt failed", { sessionID, err }))
}

export namespace DreamSpawn {
  export async function dream(parentID: SessionID, agent: Agent.Info) {
    try {
      const context = buildContext(AutoDream.DEFAULT_DREAM_INTERVAL_DAYS)
      const result = await spawnSubagent(undefined, {
        parentSessionID: parentID,
        agent,
        description: AutoDream.AUTO_DREAM_TITLE,
        canTask: false,
        canTodo: false,
        taskPermissionID: "task",
        maxDepth: 1,
        maxDescendants: 1,
      })
      const task = context ? `${AutoDream.DREAM_TASK}\n\n${context}` : AutoDream.DREAM_TASK
      kick(result.session.id, agent.name, task)
      log.info("dream session spawned", { parentID })
    } catch (err) {
      log.info("dream spawn failed", { parentID, err })
    }
  }

  export async function distill(parentID: SessionID, agent: Agent.Info) {
    try {
      const context = buildContext(AutoDream.DEFAULT_DISTILL_INTERVAL_DAYS)
      const result = await spawnSubagent(undefined, {
        parentSessionID: parentID,
        agent,
        description: AutoDream.AUTO_DISTILL_TITLE,
        canTask: false,
        canTodo: false,
        taskPermissionID: "task",
        maxDepth: 1,
        maxDescendants: 1,
      })
      const task = context ? `${AutoDream.DISTILL_TASK}\n\n${context}` : AutoDream.DISTILL_TASK
      kick(result.session.id, agent.name, task)
      log.info("distill session spawned", { parentID })
    } catch (err) {
      log.info("distill spawn failed", { parentID, err })
    }
  }
}
