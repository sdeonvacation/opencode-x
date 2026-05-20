import path from "path"
import fs from "fs"
import { Global } from "../global"
import { Log } from "../util/log"

export namespace PersistentMemory {
  const log = Log.create({ service: "persistent-memory" })
  const MAX_FILES = 200
  const MAX_LINES = 500

  export type MemoryType = "user" | "project" | "feedback"

  export type Entry = {
    name: string
    type: MemoryType
    created: string
    project?: string
    content: string
    path: string
    mtime: number
  }

  function dir(): string {
    return path.join(Global.Path.data, "memory")
  }

  export function list(opts?: { type?: MemoryType; limit?: number }): Entry[] {
    const root = dir()
    if (!fs.existsSync(root)) return []

    const files = fs
      .readdirSync(root)
      .filter((f) => f.endsWith(".md"))
      .map((f) => {
        const full = path.join(root, f)
        const stat = fs.statSync(full)
        return { file: f, path: full, mtime: stat.mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, MAX_FILES)

    const entries: Entry[] = []
    for (const item of files) {
      const entry = parse(item.path, item.mtime)
      if (!entry) continue
      if (opts?.type && entry.type !== opts.type) continue
      entries.push(entry)
    }

    return opts?.limit ? entries.slice(0, opts.limit) : entries
  }

  function parse(filepath: string, mtime: number): Entry | undefined {
    try {
      const raw = fs.readFileSync(filepath, "utf8")
      const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
      if (!match) return undefined

      const frontmatter = match[1]
      const content = match[2].trim()

      const name = extract(frontmatter, "name") ?? path.basename(filepath, ".md")
      const type = (extract(frontmatter, "type") ?? "user") as MemoryType
      const created = extract(frontmatter, "created") ?? ""
      const project = extract(frontmatter, "project")

      return { name, type, created, project, content, path: filepath, mtime }
    } catch {
      return undefined
    }
  }

  function extract(yaml: string, key: string): string | undefined {
    const match = yaml.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))
    return match?.[1]?.trim()
  }

  export function write(input: { name: string; type: MemoryType; content: string; project?: string }): void {
    const root = dir()
    fs.mkdirSync(root, { recursive: true })

    const slug = input.name.replace(/[^a-z0-9-]/gi, "-").toLowerCase()
    const filename = `${input.type}-${slug}.md`
    const filepath = path.join(root, filename)

    const lines = [
      "---",
      `name: ${input.name}`,
      `type: ${input.type}`,
      `created: ${new Date().toISOString().split("T")[0]}`,
      ...(input.project ? [`project: ${input.project}`] : []),
      "---",
      "",
      input.content,
    ]

    fs.writeFileSync(filepath, lines.join("\n"))
    log.info("written", { name: input.name, type: input.type, path: filepath })
  }

  export function inject(opts?: { project?: string }): string {
    const entries = list()
    if (entries.length === 0) return ""

    const filtered = opts?.project ? entries.filter((e) => !e.project || e.project === opts.project) : entries

    const lines: string[] = []
    let total = 0
    for (const entry of filtered) {
      const block = `[${entry.type}] ${entry.name}: ${entry.content}`
      const count = block.split("\n").length
      if (total + count > MAX_LINES) break
      lines.push(block)
      total += count
    }

    if (lines.length === 0) return ""
    return `<persistent-memory>\n${lines.join("\n\n")}\n</persistent-memory>`
  }
}
