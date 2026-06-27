import path from "path"

export namespace LoopParser {
  export class InvalidIntervalError extends Error {
    constructor(
      public raw: string,
      reason: string,
    ) {
      super(`Invalid interval "${raw}": ${reason}`)
      this.name = "InvalidIntervalError"
    }
  }

  const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
  const MIN_INTERVAL_MS = 60_000

  export function parseInterval(raw: string): number {
    const match = raw.match(/^(\d+)([smhd])$/)
    if (!match) throw new InvalidIntervalError(raw, "expected format: Ns, Nm, Nh, or Nd")
    const ms = parseInt(match[1], 10) * UNITS[match[2]]
    if (ms < MIN_INTERVAL_MS) throw new InvalidIntervalError(raw, "minimum interval is 60s")
    return ms
  }

  export function parseCommand(input: string): { intervalMs: number; prompt: string | undefined } {
    const trimmed = input.trim()
    const spaceIdx = trimmed.indexOf(" ")
    if (spaceIdx === -1) return { intervalMs: parseInterval(trimmed), prompt: undefined }
    const intervalRaw = trimmed.slice(0, spaceIdx)
    const prompt = trimmed.slice(spaceIdx + 1).trim()
    return { intervalMs: parseInterval(intervalRaw), prompt: prompt || undefined }
  }

  export async function resolvePrompt(input?: { prompt?: string; projectDir?: string }): Promise<string | undefined> {
    if (input?.prompt) return input.prompt

    // Project-level loop.md
    if (input?.projectDir) {
      const projectPath = path.join(input.projectDir, ".opencode", "loop.md")
      const projectFile = Bun.file(projectPath)
      if (await projectFile.exists()) return (await projectFile.text()).trim() || undefined
    }

    // Global loop.md
    const home = process.env.HOME ?? process.env.USERPROFILE ?? ""
    const globalPath = path.join(home, ".config", "opencode", "loop.md")
    const globalFile = Bun.file(globalPath)
    if (await globalFile.exists()) return (await globalFile.text()).trim() || undefined

    return undefined
  }
}
