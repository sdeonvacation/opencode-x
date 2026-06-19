import path from "path"
import fs from "fs/promises"
import { Token } from "@/util/token"

export async function readBudgeted(filepath: string, budget: number): Promise<{ content: string; truncated: boolean }> {
  const file = Bun.file(filepath)
  if (!(await file.exists())) return { content: "", truncated: false }
  const raw = await file.text()
  if (Token.estimate(raw) <= budget) return { content: raw, truncated: false }
  return { content: raw.slice(0, budget * 4), truncated: true }
}

export async function readDirBudgeted(dir: string, budget: number): Promise<{ content: string; truncated: boolean }> {
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return { content: "", truncated: false }
  }
  const files = entries.filter((e) => e.endsWith(".md")).sort()
  if (files.length === 0) return { content: "", truncated: false }

  let used = 0
  const parts: string[] = []
  let truncated = false
  for (const file of files) {
    const raw = await Bun.file(path.join(dir, file)).text()
    const cost = Token.estimate(raw)
    if (used + cost > budget) {
      truncated = true
      break
    }
    used += cost
    parts.push(raw.trim())
  }
  return { content: parts.join("\n\n"), truncated }
}

export async function readBudgetedSectionAware(
  path: string,
  budget: number,
): Promise<{ content: string; truncated: boolean; sections: string[] }> {
  const file = Bun.file(path)
  if (!(await file.exists())) return { content: "", truncated: false, sections: [] }
  const raw = await file.text()
  if (Token.estimate(raw) <= budget) return { content: raw, truncated: false, sections: extract(raw) }
  const parts = raw.split(/(?=^## )/m)
  let used = 0
  const included: string[] = []
  const names: string[] = []
  for (const part of parts) {
    const cost = Token.estimate(part)
    if (used + cost > budget) break
    used += cost
    included.push(part)
    const heading = part.match(/^## (.+)$/m)
    if (heading) names.push(heading[1])
  }
  return {
    content: included.join(""),
    truncated: true,
    sections: names,
  }
}

function extract(raw: string): string[] {
  return [...raw.matchAll(/^## (.+)$/gm)].map((m) => m[1])
}
