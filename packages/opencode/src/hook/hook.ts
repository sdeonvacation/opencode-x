import { Effect } from "effect"
import { Log } from "../util/log"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod"
import path from "path"
import os from "os"
import { Instance } from "../project/instance"

export namespace Hook {
  const log = Log.create({ service: "hook" })
  const TIMEOUT = 10_000

  export type Event =
    | "PreToolUse"
    | "PostToolUse"
    | "PostToolUseFailure"
    | "Notification"
    | "Stop"
    | "SessionStart"
    | "UserPromptSubmit"
    | "SubagentStart"
    | "SubagentStop"

  export const EVENTS: Event[] = [
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "Notification",
    "Stop",
    "SessionStart",
    "UserPromptSubmit",
    "SubagentStart",
    "SubagentStop",
  ]

  export type HookDef = {
    type: "command"
    command: string
    timeout?: number
  }

  export type Rule = {
    matcher?: string
    hooks: HookDef[]
  }

  export type Rules = Record<Event, Rule[]>

  export type Payload = {
    tool?: string
    input?: unknown
    result?: unknown
    sessionID?: string
    model?: string
    prompt?: string
  }

  export const HookDenied = NamedError.create(
    "HookDenied",
    z.object({
      message: z.string(),
      tool: z.string().optional(),
    }),
  )

  function matches(pattern: string, value: string): boolean {
    if (pattern === "*") return true
    if (pattern === value) return true
    if (!pattern.includes("*") && !pattern.includes("?")) return false
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")
    return new RegExp("^" + escaped + "$").test(value)
  }

  function empty(): Rules {
    return {
      PreToolUse: [],
      PostToolUse: [],
      PostToolUseFailure: [],
      Notification: [],
      Stop: [],
      SessionStart: [],
      UserPromptSubmit: [],
      SubagentStart: [],
      SubagentStop: [],
    }
  }

  function merge(base: Rules, source: Record<string, unknown>): Rules {
    const result = { ...base }
    for (const key of EVENTS) {
      if (Array.isArray(source[key])) {
        result[key] = source[key] as Rule[]
      }
    }
    return result
  }

  function dedupeRules(rules: Rule[]): Rule[] {
    const seen = new Set<string>()
    const result: Rule[] = []
    for (const rule of rules) {
      const key = JSON.stringify({ matcher: rule.matcher ?? "", hooks: rule.hooks })
      if (seen.has(key)) continue
      seen.add(key)
      result.push(rule)
    }
    return result
  }

  function mergeAll(base: Rules, sources: Record<string, unknown>[]): Rules {
    const result = { ...base }
    for (const key of EVENTS) {
      const combined: Rule[] = []
      for (const source of sources) {
        if (Array.isArray(source[key])) {
          combined.push(...(source[key] as Rule[]))
        }
      }
      if (combined.length > 0) {
        result[key] = dedupeRules(combined)
      }
    }
    return result
  }

  export type CommandDef = {
    name: string
    description?: string
  }

  async function readFile(): Promise<unknown> {
    const sources: Record<string, unknown>[] = []

    // Source 1: User-level ~/.config/opencode/hooks.json
    const user = path.join(os.homedir(), ".config", "opencode", "hooks.json")
    try {
      const text = await Bun.file(user).text()
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === "object") sources.push(parsed)
    } catch {
      // file doesn't exist or invalid JSON — continue
    }

    // Source 2: Project-level .claude/settings.json (Claude Code convention)
    const project = path.join(Instance.directory, ".claude", "settings.json")
    try {
      const text = await Bun.file(project).text()
      const parsed = JSON.parse(text)
      if (parsed.hooks && typeof parsed.hooks === "object") sources.push(parsed.hooks)
    } catch {
      // file doesn't exist or invalid JSON — continue
    }

    // Source 3: Claude Code ~/.claude/settings.json
    const claude = path.join(os.homedir(), ".claude", "settings.json")
    try {
      const text = await Bun.file(claude).text()
      const parsed = JSON.parse(text)
      if (parsed.hooks && typeof parsed.hooks === "object") sources.push(parsed.hooks)
    } catch {
      // file doesn't exist or invalid JSON — continue
    }

    if (sources.length === 0) return null
    return sources
  }

  export async function load(): Promise<Rules> {
    const base = empty()
    const parsed = await readFile()
    if (!parsed) return base
    if (Array.isArray(parsed)) return mergeAll(base, parsed)
    if (typeof parsed === "object") return mergeAll(base, [parsed as Record<string, unknown>])
    return base
  }

  export async function loadCommands(): Promise<CommandDef[]> {
    const results: CommandDef[] = []

    // Source 1: ~/.claude/hooks/commands.json (simple override)
    const simple = path.join(os.homedir(), ".claude", "hooks", "commands.json")
    try {
      const text = await Bun.file(simple).text()
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) {
        for (const c of parsed) {
          if (c && typeof c === "object" && typeof c.name === "string") {
            results.push({ name: c.name, description: c.description })
          }
        }
      }
    } catch {}

    // Source 2: Installed Claude Code plugins
    const manifest = path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json")
    try {
      const text = await Bun.file(manifest).text()
      const parsed = JSON.parse(text)
      const plugins = parsed?.plugins
      if (plugins && typeof plugins === "object") {
        for (const [key, entries] of Object.entries(plugins)) {
          const plugin = key.split("@")[0]
          const entry = (entries as any[])?.[0]
          const dir = entry?.installPath
          if (!dir) continue
          const skills = path.join(dir, "skills")
          try {
            const items = await Array.fromAsync(new Bun.Glob("*/SKILL.md").scan({ cwd: skills, onlyFiles: true }))
            for (const item of items) {
              try {
                const content = await Bun.file(path.join(skills, item)).text()
                const fm = parseSkillFrontmatter(content)
                if (!fm.name) continue
                const cmd = fm.trigger || fm.name
                if (results.some((r) => r.name === cmd)) continue
                results.push({ name: cmd, description: fm.description?.split("\n")[0]?.trim() })
              } catch {}
            }
          } catch {}
        }
      }
    } catch {}

    return results
  }

  function parseSkillFrontmatter(content: string): { name?: string; description?: string; trigger?: string } {
    const match = content.match(/^---\n([\s\S]*?)\n---/)
    if (!match) return {}
    const block = match[1]
    const name = block.match(/^name:\s*(.+)/m)?.[1]?.trim()
    let description = ""
    const multiline = block.match(/^description:\s*[>|]?\s*\n((?:[ \t].*(?:\n|$))*)/m)
    if (multiline) {
      description = multiline[1].replace(/^\s+/gm, "").trim()
    } else {
      const inline = block.match(/^description:\s*(.+)/m)?.[1]?.trim()
      if (inline) description = inline
    }
    const trigger = description.match(/Trigger:\s*\/([^\s]+)/)?.[1]
    return { name, description: description.replace(/\s*Trigger:.*/, "").trim(), trigger }
  }

  async function execute(def: HookDef, payload: Payload): Promise<{ code: number; stdout: string; stderr: string }> {
    // Claude Code spec: `timeout` is in SECONDS. Convert to ms for setTimeout.
    const timeout = def.timeout != null ? def.timeout * 1000 : TIMEOUT
    const env = {
      ...process.env,
      CLAUDE_TOOL_NAME: payload.tool ?? "",
      CLAUDE_TOOL_INPUT: payload.input ? JSON.stringify(payload.input) : "",
      CLAUDE_SESSION_ID: payload.sessionID ?? "",
      CLAUDE_MODEL: payload.model ?? "",
      CLAUDE_TOOL_RESULT: payload.result !== undefined ? JSON.stringify(payload.result) : "",
      CLAUDE_USER_PROMPT: payload.prompt ?? "",
    }

    const body = JSON.stringify(payload)
    const proc = Bun.spawn(["sh", "-c", def.command], {
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })

    proc.stdin.write(body)
    proc.stdin.end()

    const timer = setTimeout(() => proc.kill(), timeout)
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const code = await proc.exited
    clearTimeout(timer)

    return { code, stdout: stdout.trim(), stderr: stderr.trim() }
  }

  export type DispatchResult = {
    allowed: true
    /** Collected stdout from all successful hooks (non-empty only) */
    output: string[]
  }

  export const dispatch = Effect.fn("Hook.dispatch")(function* (
    event: Event,
    payload: Payload,
    rules: Rules,
    cfg?: { hooks?: Record<string, Rule[]> },
  ) {
    // Config hooks override loaded rules for the given event
    let active = rules[event] ?? []
    if (cfg?.hooks?.[event]) {
      active = cfg.hooks[event] as Rule[]
    }

    const tool = payload.tool ?? ""
    const matched = active.filter((r) => !r.matcher || matches(r.matcher, tool))
    const output: string[] = []

    for (const rule of matched) {
      for (const hook of rule.hooks) {
        const result = yield* Effect.promise(() => execute(hook, payload))

        if ((event === "PreToolUse" || event === "UserPromptSubmit") && result.code !== 0) {
          return yield* Effect.fail(
            new HookDenied({
              message: result.stderr || `Hook denied tool execution (exit code ${result.code})`,
              tool: payload.tool,
            }),
          )
        }

        if (result.code !== 0) {
          log.warn("hook-failed", {
            event,
            tool,
            code: result.code,
            stderr: result.stderr,
          })
        } else if (result.stdout) {
          output.push(result.stdout)
        }
      }
    }

    return { allowed: true as const, output }
  })
}
