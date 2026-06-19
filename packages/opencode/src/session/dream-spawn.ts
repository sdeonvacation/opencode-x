import { spawnSubagent } from "../orchestration/task-spawn"
import type { SessionID } from "./schema"
import type { Agent } from "../agent/agent"
import type { Config } from "../config/config"
import { AutoDream } from "./auto-dream"
import { Session } from "./index"
import { MessageV2 } from "./message-v2"
import { Log } from "../util/log"

const log = Log.create({ service: "dream-spawn" })

const DEFAULT_MAX_CONTEXT_CHARS = 100_000
const DEFAULT_MAX_SESSIONS = 20
const DEFAULT_MAX_MESSAGES = 100

function extractText(msg: MessageV2.WithParts): string {
  if (msg.info.role === "user" && msg.info.summary) {
    const s = msg.info.summary
    const parts = [s.title, s.body].filter(Boolean)
    if (parts.length > 0) return parts.join(": ")
  }
  return msg.parts
    .filter((p): p is MessageV2.TextPart => p.type === "text" && !("synthetic" in p && p.synthetic))
    .map((p) => p.text)
    .join("\n")
}

export function buildContext(
  days: number,
  opts?: { max_context_chars?: number; max_sessions?: number; max_messages?: number },
): string {
  const maxChars = opts?.max_context_chars ?? DEFAULT_MAX_CONTEXT_CHARS
  const maxSessions = opts?.max_sessions ?? DEFAULT_MAX_SESSIONS
  const maxMessages = opts?.max_messages ?? DEFAULT_MAX_MESSAGES

  const cutoff = Date.now() - days * AutoDream.DAY_MS
  const sessions: Array<{ title: string; time: number; id: SessionID }> = []

  for (const s of Session.list({ roots: true, start: cutoff, limit: maxSessions })) {
    if (s.title.startsWith(AutoDream.AUTO_DREAM_TITLE)) continue
    if (s.title.startsWith(AutoDream.AUTO_DISTILL_TITLE)) continue
    sessions.push({ title: s.title, time: s.time.created, id: s.id })
  }

  if (sessions.length === 0) return ""

  let out = "## Recent Session History\n\n"
  let chars = out.length

  for (const s of sessions) {
    const header = `### ${s.title} (${new Date(s.time).toISOString().slice(0, 10)})\n\n`
    if (chars + header.length > maxChars) break
    out += header
    chars += header.length

    const { items } = MessageV2.page({ sessionID: s.id, limit: maxMessages })
    for (const msg of items) {
      const role = msg.info.role === "user" ? "User" : "Assistant"
      const text = extractText(msg)
      if (!text) continue

      const truncated = text.length > 4000 ? text.slice(0, 4000) + "..." : text
      const entry = `**${role}**: ${truncated}\n\n`
      if (chars + entry.length > maxChars) break
      out += entry
      chars += entry.length
    }
  }

  return out
}

async function kick(sessionID: SessionID, agent: string, task: string) {
  const { SessionPrompt } = await import("./prompt")
  SessionPrompt.prompt({
    sessionID,
    agent,
    parts: [{ type: "text", text: task }],
  }).catch((err) => log.info("dream prompt failed", { sessionID, err }))
}

export namespace DreamSpawn {
  export async function dream(parentID: SessionID, agent: Agent.Info, cfg: Config.Info) {
    try {
      const context = buildContext(cfg.dream?.interval_days ?? AutoDream.DEFAULT_DREAM_INTERVAL_DAYS, cfg.dream)
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

  export async function distill(parentID: SessionID, agent: Agent.Info, cfg: Config.Info) {
    try {
      const context = buildContext(cfg.distill?.interval_days ?? AutoDream.DEFAULT_DISTILL_INTERVAL_DAYS, cfg.distill)
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
