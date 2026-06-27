import { Database, like, desc, asc } from "../storage/db"
import { SessionTable } from "./session.sql"
import { Flag } from "../flag/flag"
import type { Config } from "../config/config"

export namespace AutoDream {
  export const DAY_MS = 86_400_000
  export const DEFAULT_DREAM_INTERVAL_DAYS = 7
  export const DEFAULT_DISTILL_INTERVAL_DAYS = 30
  export const MIN_SPAWN_GAP_MS = 10_000

  export const DEFAULT_DREAM_MAX_SESSIONS = 50
  export const DEFAULT_DREAM_MAX_MESSAGES = 200

  export const AUTO_DREAM_TITLE = "Auto Dream"
  export const AUTO_DISTILL_TITLE = "Auto Distill"

  export const DREAM_TASK = `You are a dream consolidation agent. Review recent sessions and consolidate learnings that would be useful in ANY project using the same technology stack — not facts specific to this codebase.

Core test: "Does this apply beyond this project?" If no, skip it.

Extract only general facts — useful outside this codebase:
- Tool/library/API quirks and gotchas
- Error patterns and fixes that could recur anywhere
- User workflow or style preferences observed across sessions
- Non-obvious behaviors discovered during debugging

Do NOT extract:
- This codebase's file paths, module names, or directory structure
- This project's architectural decisions or conventions
- Config values or settings specific to this repo
- Patterns only applicable because of how THIS project is structured

Rules:
- Only write facts you can verify from actual session content
- Do not hallucinate or speculate
- Use short, factual memory names (2-4 words, kebab-case)
- Memory type: "user" for general tech-stack knowledge, "feedback" for user-preference corrections
- Skip anything already in persistent memory
- Maximum 10 new memories per run
- If nothing general qualifies, output "No general memories to extract" and stop`

  export const DISTILL_TASK = `Review recent sessions for complex workflows worth extracting into skills.

Key criteria — only create a skill if ALL are true:
- Non-obvious: agent would get it wrong without explicit guidance
- Complex: 5+ steps with specific commands, file paths, or code templates
- Recurring: performed 2+ times across sessions
- Not covered: persistent memories alone are insufficient

Do NOT create skills for simple patterns already in memory (git flows, basic flag removal, etc). A good skill has exact file paths, code templates, ordering constraints, and gotcha warnings.

If nothing qualifies, output "No skills worth creating" and explain why candidates were rejected.`

  export const DISTILL_SESSION_TASK = `Review this session for complex workflows worth extracting into reusable skills.

Key criteria — only create a skill if ALL are true:
- Non-obvious: agent would get it wrong without explicit guidance
- Complex: 5+ steps with specific commands, file paths, or code templates
- Demonstrated: clearly performed in this session with enough detail to reproduce
- Not covered: persistent memories alone are insufficient

Generality preference: prefer skills that apply across projects using the same tech stack. Abstract away project-specific paths into generic patterns (e.g. "src/<module>/" not "src/session/"). Only create a project-local skill when the workflow is inherently tied to this codebase's unique structure and cannot be generalized.

Do NOT create skills for simple patterns already in memory (git flows, basic flag removal, etc). A good skill has exact code templates, ordering constraints, and gotcha warnings — written so they're useful in ANY project with the same technology.

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
