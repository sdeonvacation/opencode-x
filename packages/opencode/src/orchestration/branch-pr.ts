import { Log } from "../util/log"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod"
import path from "path"
import os from "os"
import fs from "fs/promises"

export type WorktreeInfo = {
  id: string
  worktree: string
  base: string
  cwd: string
}

export type DiffResult = {
  files_changed: number
  insertions: number
  deletions: number
  files: Array<{
    path: string
    status: "A" | "M" | "D"
    patch: string
  }>
  truncated: boolean
}

export type ApplyResult = {
  applied: string[]
  conflicts: string[]
}

export namespace OrchestrationBranchPR {
  const log = Log.create({ service: "branch-pr" })

  export const WorktreeError = NamedError.create("BranchPRError", z.object({ message: z.string() }))
  export const ApplyConflict = NamedError.create(
    "BranchPRApplyConflict",
    z.object({ message: z.string(), files: z.array(z.string()) }),
  )

  async function exec(cmd: string, cwd?: string): Promise<{ stdout: string; stderr: string; code: number }> {
    const proc = Bun.spawn(["sh", "-c", cmd], { cwd, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const code = await proc.exited
    return { stdout: stdout.trim(), stderr: stderr.trim(), code }
  }

  async function execArray(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string; code: number }> {
    const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const code = await proc.exited
    return { stdout: stdout.trim(), stderr: stderr.trim(), code }
  }

  function slugify(input: string): string {
    return input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 30)
  }

  /** Create a detached worktree (no branch) for subagent isolation */
  export async function create(input: { session: string; cwd: string; slug: string }): Promise<WorktreeInfo> {
    const sid = input.session.slice(0, 8)
    const slug = slugify(input.slug)
    const id = `${sid}-${slug}-${Date.now().toString(36)}`
    const worktree = path.join(os.tmpdir(), `opencode-brpr-${id}`)

    const head = await exec("git rev-parse HEAD", input.cwd)
    if (head.code !== 0) throw new WorktreeError({ message: `Failed to get HEAD: ${head.stderr}` })
    const base = head.stdout

    const result = await exec(`git worktree add --detach "${worktree}" HEAD`, input.cwd)
    if (result.code !== 0) {
      throw new WorktreeError({ message: `Failed to create worktree: ${result.stderr}` })
    }

    // Symlink node_modules so subagent can resolve dependencies
    const nm = path.join(input.cwd, "node_modules")
    const target = path.join(worktree, "node_modules")
    await fs.symlink(nm, target, "dir").catch(() => {})

    log.info("created", { id, worktree, base: base.slice(0, 8) })
    return { id, worktree, base, cwd: input.cwd }
  }

  /** Compute diff between worktree state and its base (HEAD at creation time) */
  export async function diff(input: { worktree: WorktreeInfo; maxLines?: number }): Promise<DiffResult> {
    const limit = input.maxLines ?? 500
    const cwd = input.worktree.worktree

    // Compare working tree changes against base commit
    const patch = await exec(`git diff "${input.worktree.base}" -- .`, cwd)
    const numstat = await exec(`git diff --numstat "${input.worktree.base}" -- .`, cwd)
    const nameStatus = await exec(`git diff --name-status "${input.worktree.base}" -- .`, cwd)

    // Capture untracked files (new files created by subagent)
    const untracked = await exec("git ls-files --others --exclude-standard", cwd)

    const files: DiffResult["files"] = []
    const statuses = new Map<string, "A" | "M" | "D">()

    for (const line of nameStatus.stdout.split("\n").filter(Boolean)) {
      const [s, ...rest] = line.split("\t")
      const filepath = rest.join("\t")
      if (s === "A") statuses.set(filepath, "A")
      else if (s === "D") statuses.set(filepath, "D")
      else statuses.set(filepath, "M")
    }

    for (const filepath of untracked.stdout.split("\n").filter(Boolean)) {
      if (!statuses.has(filepath)) statuses.set(filepath, "A")
    }

    // Split full patch by file
    const patches = patch.stdout ? patch.stdout.split(/^diff --git /m).slice(1) : []
    let lines = 0
    let truncated = false

    for (const p of patches) {
      const header = p.split("\n")[0]
      const filepath = header.replace(/^a\/(.+?) b\/.*$/, "$1")
      const content = "diff --git " + p
      const count = content.split("\n").length

      if (lines + count > limit) {
        truncated = true
        files.push({ path: filepath, status: statuses.get(filepath) ?? "M", patch: "(truncated)" })
      } else {
        files.push({ path: filepath, status: statuses.get(filepath) ?? "M", patch: content })
        lines += count
      }
    }

    // For untracked files not already in the git diff, generate a patch
    for (const filepath of untracked.stdout.split("\n").filter(Boolean)) {
      if (files.some((f) => f.path === filepath)) continue
      const content = await Bun.file(path.join(cwd, filepath))
        .text()
        .catch(() => "")
      const patchLines = content.split("\n")
      const count = patchLines.length + 4
      if (lines + count > limit) {
        truncated = true
        files.push({ path: filepath, status: "A", patch: "(truncated)" })
      } else {
        const fake = [
          `diff --git a/${filepath} b/${filepath}`,
          "new file mode 100644",
          `--- /dev/null`,
          `+++ b/${filepath}`,
          `@@ -0,0 +1,${patchLines.length} @@`,
          ...patchLines.map((l) => `+${l}`),
        ].join("\n")
        files.push({ path: filepath, status: "A", patch: fake })
        lines += count
      }
    }

    // Count insertions/deletions from numstat
    let insertions = 0
    let deletions = 0
    for (const line of numstat.stdout.split("\n").filter(Boolean)) {
      const [ins, del] = line.split("\t")
      if (ins !== "-") insertions += Number(ins)
      if (del !== "-") deletions += Number(del)
    }

    // Add untracked file lines as insertions
    for (const filepath of untracked.stdout.split("\n").filter(Boolean)) {
      if (statuses.get(filepath) === "A" && !nameStatus.stdout.includes(filepath)) {
        const content = await Bun.file(path.join(cwd, filepath))
          .text()
          .catch(() => "")
        insertions += content.split("\n").length
      }
    }

    return { files_changed: files.length, insertions, deletions, files, truncated }
  }

  /** Check if a single file has a conflict in the real working directory */
  async function checkConflict(filepath: string, status: "A" | "M" | "D", worktree: WorktreeInfo): Promise<boolean> {
    const cwd = worktree.cwd
    if (status === "A") {
      const exists = await Bun.file(path.join(cwd, filepath)).exists()
      if (exists) {
        const baseCheck = await execArray(["git", "rev-parse", `${worktree.base}:${filepath}`], cwd)
        if (baseCheck.code !== 0) return true // didn't exist at base, exists now
        // Existed at base — check if modified since base
        const realHash = await execArray(["git", "hash-object", path.join(cwd, filepath)])
        if (realHash.code !== 0) return false
        return realHash.stdout !== baseCheck.stdout
      }
      return false
    }
    // M or D — conflict if real file hash differs from base hash
    const realHash = await execArray(["git", "hash-object", path.join(cwd, filepath)])
    if (realHash.code !== 0) return false // file doesn't exist (for D: already deleted — no conflict)
    const baseHash = await execArray(["git", "rev-parse", `${worktree.base}:${filepath}`], cwd)
    if (baseHash.code !== 0) return false
    return realHash.stdout !== baseHash.stdout
  }

  /**
   * Apply changes from worktree to the real project directory.
   * Copies modified/new files, removes deleted files.
   * Two-pass: detects all conflicts first, applies only if none found.
   */
  export async function apply(input: { worktree: WorktreeInfo }): Promise<ApplyResult> {
    const cwd = input.worktree.cwd
    const wt = input.worktree.worktree

    const nameStatus = await exec(`git diff --name-status "${input.worktree.base}" -- .`, wt)
    const untracked = await exec("git ls-files --others --exclude-standard", wt)

    const changes: Array<{ filepath: string; status: "A" | "M" | "D" }> = []

    for (const line of nameStatus.stdout.split("\n").filter(Boolean)) {
      const [s, ...rest] = line.split("\t")
      const filepath = rest.join("\t")
      const status = s === "A" ? "A" : s === "D" ? "D" : "M"
      changes.push({ filepath, status })
    }

    for (const filepath of untracked.stdout.split("\n").filter(Boolean)) {
      if (!changes.some((c) => c.filepath === filepath)) {
        changes.push({ filepath, status: "A" })
      }
    }

    // Pass 1: detect all conflicts (write nothing)
    const conflicts: string[] = []
    for (const { filepath, status } of changes) {
      const conflict = await checkConflict(filepath, status, input.worktree)
      if (conflict) conflicts.push(filepath)
    }

    if (conflicts.length > 0) {
      log.warn("apply-conflicts", { count: conflicts.length, files: conflicts })
      return { applied: [], conflicts }
    }

    // Pass 2: apply all files (guaranteed conflict-free)
    const applied: string[] = []
    for (const { filepath, status } of changes) {
      if (status === "D") {
        await fs.unlink(path.join(cwd, filepath)).catch(() => {})
      } else {
        const src = path.join(wt, filepath)
        const dst = path.join(cwd, filepath)
        await fs.mkdir(path.dirname(dst), { recursive: true })
        await fs.copyFile(src, dst)
      }
      applied.push(filepath)
    }

    log.info("applied", { count: applied.length })
    return { applied, conflicts: [] }
  }

  /** Remove the detached worktree */
  export async function cleanup(input: { worktree: WorktreeInfo }): Promise<void> {
    await exec(`git worktree remove "${input.worktree.worktree}" --force`, input.worktree.cwd)
    log.info("cleaned", { id: input.worktree.id })
  }

  /** Sweep orphan worktrees older than TTL */
  export async function sweep(input: { cwd: string; ttl: number }): Promise<{ removed: string[] }> {
    const result = await exec("git worktree list --porcelain", input.cwd)
    if (result.code !== 0) return { removed: [] }

    const removed: string[] = []
    const blocks = result.stdout.split("\n\n").filter(Boolean)
    const now = Date.now()

    for (const block of blocks) {
      const match = block.match(/^worktree (.+)$/m)
      if (!match?.[1]) continue
      const wtPath = match[1]
      if (!wtPath.includes("opencode-brpr-")) continue

      try {
        const stat = await fs.stat(wtPath)
        if (now - stat.mtimeMs > input.ttl) {
          await exec(`git worktree remove "${wtPath}" --force`, input.cwd)
          removed.push(wtPath)
        }
      } catch {
        // Directory gone — prune
        await exec("git worktree prune", input.cwd)
      }
    }

    if (removed.length) log.info("swept", { count: removed.length })
    return { removed }
  }
}
