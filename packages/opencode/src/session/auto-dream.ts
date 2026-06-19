import { Database, like, desc, asc } from "../storage/db"
import { SessionTable } from "./session.sql"
import { Flag } from "../flag/flag"
import type { Config } from "../config/config"

export namespace AutoDream {
  export const DAY_MS = 86_400_000
  export const DEFAULT_DREAM_INTERVAL_DAYS = 7
  export const DEFAULT_DISTILL_INTERVAL_DAYS = 30
  export const MIN_SPAWN_GAP_MS = 10_000

  export const AUTO_DREAM_TITLE = "Auto Dream"
  export const AUTO_DISTILL_TITLE = "Auto Distill"

  export const DREAM_TASK = `You are a dream consolidation agent. Review all recent sessions in this project and consolidate important learnings, patterns, and facts into persistent memory entries (type: "project").

Focus on:
- Discovered codebase conventions not in AGENTS.md
- Common error patterns and their fixes
- API quirks or undocumented behavior
- User preferences observed across sessions
- Architectural decisions and their rationale

Rules:
- Only write facts you can verify from actual session content
- Do not hallucinate or speculate
- Use short, factual memory names (2-4 words, kebab-case)
- Skip anything already in persistent memory
- Maximum 10 new memories per run`

  export const DISTILL_TASK = `Review recent sessions for complex workflows worth extracting into skills.

Key criteria — only create a skill if ALL are true:
- Non-obvious: agent would get it wrong without explicit guidance
- Complex: 5+ steps with specific commands, file paths, or code templates
- Recurring: performed 2+ times across sessions
- Not covered: persistent memories alone are insufficient

Do NOT create skills for simple patterns already in memory (git flows, basic flag removal, etc). A good skill has exact file paths, code templates, ordering constraints, and gotcha warnings.

If nothing qualifies, output "No skills worth creating" and explain why candidates were rejected.`

  let lastDreamSpawn = 0
  let lastDistillSpawn = 0

  export function shouldAutoDream(cfg: Config.Info): boolean {
    try {
      if (!Flag.OPENCODE_EXPERIMENTAL_DREAM && !cfg.experimental?.dream_and_distill) return false
      if (cfg.dream?.auto === false) return false

      const now = Date.now()
      if (now - lastDreamSpawn < MIN_SPAWN_GAP_MS) return false

      const interval = (cfg.dream?.interval_days ?? DEFAULT_DREAM_INTERVAL_DAYS) * DAY_MS

      const last = Database.use((db) =>
        db
          .select({ time_created: SessionTable.time_created })
          .from(SessionTable)
          .where(like(SessionTable.title, `${AUTO_DREAM_TITLE}%`))
          .orderBy(desc(SessionTable.time_created))
          .limit(1)
          .all(),
      )
      if (last.length > 0 && now - last[0].time_created < interval) return false

      const oldest = Database.use((db) =>
        db
          .select({ time_created: SessionTable.time_created })
          .from(SessionTable)
          .orderBy(asc(SessionTable.time_created))
          .limit(1)
          .all(),
      )
      if (oldest.length === 0 || now - oldest[0].time_created < interval) return false

      lastDreamSpawn = now
      return true
    } catch {
      return false
    }
  }

  export function shouldAutoDistill(cfg: Config.Info): boolean {
    try {
      if (!Flag.OPENCODE_EXPERIMENTAL_DREAM && !cfg.experimental?.dream_and_distill) return false
      if (cfg.distill?.auto === false) return false

      const now = Date.now()
      if (now - lastDistillSpawn < MIN_SPAWN_GAP_MS) return false

      const interval = (cfg.distill?.interval_days ?? DEFAULT_DISTILL_INTERVAL_DAYS) * DAY_MS

      const last = Database.use((db) =>
        db
          .select({ time_created: SessionTable.time_created })
          .from(SessionTable)
          .where(like(SessionTable.title, `${AUTO_DISTILL_TITLE}%`))
          .orderBy(desc(SessionTable.time_created))
          .limit(1)
          .all(),
      )
      if (last.length > 0 && now - last[0].time_created < interval) return false

      const oldest = Database.use((db) =>
        db
          .select({ time_created: SessionTable.time_created })
          .from(SessionTable)
          .orderBy(asc(SessionTable.time_created))
          .limit(1)
          .all(),
      )
      if (oldest.length === 0 || now - oldest[0].time_created < interval) return false

      lastDistillSpawn = now
      return true
    } catch {
      return false
    }
  }

  /** Reset debounce timestamps (for testing) */
  export function reset() {
    lastDreamSpawn = 0
    lastDistillSpawn = 0
  }
}
