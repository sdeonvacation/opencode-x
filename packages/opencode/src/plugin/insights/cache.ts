import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { SessionFacet } from "./types"

export const FACET_CACHE_VERSION = "v2"

export class FacetCache {
  readonly dir: string

  constructor(dir: string) {
    this.dir = dir
    mkdirSync(dir, { recursive: true })
  }

  has(sessionId: string): boolean {
    return existsSync(join(this.dir, `${sessionId}.json`))
  }

  get(sessionId: string): SessionFacet | null {
    const path = join(this.dir, `${sessionId}.json`)
    try {
      const text = readFileSync(path, "utf-8")
      return JSON.parse(text) as SessionFacet
    } catch {
      return null
    }
  }

  put(sessionId: string, facet: SessionFacet): void {
    const tmp = join(this.dir, `${sessionId}.json.tmp`)
    const final = join(this.dir, `${sessionId}.json`)
    writeFileSync(tmp, JSON.stringify(facet, null, 2), "utf-8")
    renameSync(tmp, final)
  }

  clear(): void {
    try {
      const entries = readdirSync(this.dir)
      entries
        .filter((e) => e.endsWith(".json") || e.endsWith(".json.tmp"))
        .forEach((e) => unlinkSync(join(this.dir, e)))
    } catch {}
  }
}
