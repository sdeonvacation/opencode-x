import path from "path"
import { Glob } from "../util/glob"

export function parsePaths(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined

  let items: string[] = []
  if (typeof raw === "string") {
    items = raw.split(";").map((s) => s.trim())
  } else if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== "string") continue
      items.push(...item.split(";").map((s) => s.trim()))
    }
  } else {
    return undefined
  }

  const out: string[] = []
  for (const item of items) {
    if (!item) continue
    if (item === "**") continue
    const stripped = item.endsWith("/**") ? item.slice(0, -3) : item
    if (!stripped) continue
    if (path.isAbsolute(stripped)) continue
    if (stripped.startsWith("..") || stripped.includes("/../")) continue
    out.push(stripped)
  }

  if (out.length === 0) return undefined
  return out
}

export async function matchAny(patterns: string[], cwd: string): Promise<boolean> {
  for (const pattern of patterns) {
    const matches = await Glob.scan(pattern, {
      cwd,
      include: "file",
      absolute: false,
      dot: false,
      symlink: true,
    })
    if (matches.length > 0) return true
  }
  return false
}
