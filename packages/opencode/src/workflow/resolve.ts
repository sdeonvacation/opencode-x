import { readFileSync, existsSync } from "fs"
import path from "path"
import { Global } from "@/global"

export namespace WorkflowResolve {
  export type Resolved = {
    path: string
    source: string
    sha: string
  }

  const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/

  export function safeName(name: string): boolean {
    if (name.includes("..") || name.includes("/") || name.includes("\\")) return false
    if (name.includes("\0")) return false
    return NAME_PATTERN.test(name)
  }

  export function resolve(name: string, dir: string): Resolved | undefined {
    if (!safeName(name)) return undefined

    // 1. Walk up from project dir
    let current = path.resolve(dir)
    while (true) {
      const file = path.join(current, ".opencode", "workflows", `${name}.js`)
      if (existsSync(file)) return read(file)

      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }

    // 2. Fallback: global config dir (~/.config/opencode/workflows/)
    const global = path.join(Global.Path.config, "workflows", `${name}.js`)
    if (existsSync(global)) return read(global)

    return undefined
  }

  function read(file: string): Resolved {
    const source = readFileSync(file, "utf-8")
    const sha = new Bun.CryptoHasher("sha256").update(source).digest("hex")
    return { path: file, source, sha }
  }
}
