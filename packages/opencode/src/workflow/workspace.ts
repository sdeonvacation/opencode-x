import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import path from "path"

export namespace WorkflowWorkspace {
  export type FileHooks = {
    readFile: (path: string) => string
    writeFile: (path: string, content: string) => void
    exists: (path: string) => boolean
    glob: (pattern: string) => string[]
  }

  export function resolveInWorkspace(root: string, target: string): string | undefined {
    const resolved = path.resolve(root, target)
    const normalized = path.normalize(resolved)
    const base = path.normalize(root)
    if (normalized === base) return normalized
    if (!normalized.startsWith(base + path.sep)) return undefined
    return normalized
  }

  export function makeFileHooks(root: string): FileHooks {
    return {
      readFile(p) {
        const resolved = resolveInWorkspace(root, p)
        if (!resolved) throw new Error("path escapes workspace: " + p)
        return readFileSync(resolved, "utf-8")
      },
      writeFile(p, content) {
        const resolved = resolveInWorkspace(root, p)
        if (!resolved) throw new Error("path escapes workspace: " + p)
        mkdirSync(path.dirname(resolved), { recursive: true })
        writeFileSync(resolved, content)
      },
      exists(p) {
        const resolved = resolveInWorkspace(root, p)
        if (!resolved) return false
        return existsSync(resolved)
      },
      glob(pattern) {
        const g = new Bun.Glob(pattern)
        return Array.from(g.scanSync({ cwd: root }))
      },
    }
  }
}
