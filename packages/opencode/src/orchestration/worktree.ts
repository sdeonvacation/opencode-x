import { Log } from "../util/log"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod"
import path from "path"
import os from "os"

export namespace OrchestrationWorktree {
  const log = Log.create({ service: "orchestration-worktree" })

  export const WorktreeError = NamedError.create("OrchestrationWorktreeError", z.object({ message: z.string() }))

  export const MergeConflict = NamedError.create(
    "OrchestrationMergeConflict",
    z.object({
      message: z.string(),
      branch: z.string(),
    }),
  )

  export type WorktreePath = string & { readonly __tag: "WorktreePath" }

  async function exec(cmd: string, cwd?: string): Promise<{ stdout: string; stderr: string; code: number }> {
    const proc = Bun.spawn(["sh", "-c", cmd], { cwd, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const code = await proc.exited
    return { stdout: stdout.trim(), stderr: stderr.trim(), code }
  }

  /**
   * Create a git worktree for subagent isolation.
   * Returns the path to the new worktree directory.
   */
  export async function create(input: { sessionID: string; cwd: string }): Promise<WorktreePath> {
    const dir = path.join(os.tmpdir(), `opencode-worker-${input.sessionID}`)
    const result = await exec(`git worktree add "${dir}" HEAD`, input.cwd)
    if (result.code !== 0) {
      throw new WorktreeError({ message: `Failed to create worktree: ${result.stderr}` })
    }
    log.info("created", { sessionID: input.sessionID, path: dir })
    return dir as WorktreePath
  }

  /**
   * Merge worktree changes back into the main working directory via cherry-pick.
   * Throws MergeConflict if the cherry-pick fails.
   */
  export async function merge(input: {
    sessionID: string
    worktree: WorktreePath
    cwd: string
  }): Promise<{ merged: boolean; branch: string }> {
    const branch = `opencode-worker-${input.sessionID}`

    const checkout = await exec(`git checkout -b "${branch}"`, input.worktree)
    if (checkout.code !== 0) {
      throw new WorktreeError({ message: `Failed to create branch: ${checkout.stderr}` })
    }

    await exec("git add -A", input.worktree)
    await exec('git commit -m "worktree: changes from subagent" --allow-empty', input.worktree)

    const pick = await exec(`git cherry-pick "${branch}"`, input.cwd)
    if (pick.code !== 0) {
      await exec("git cherry-pick --abort", input.cwd)
      throw new MergeConflict({
        message: `Merge conflict from worktree. Branch preserved: ${branch}`,
        branch,
      })
    }

    log.info("merged", { sessionID: input.sessionID, branch })
    return { merged: true, branch }
  }

  /**
   * Remove worktree and delete the temporary branch.
   */
  export async function cleanup(input: { sessionID: string; worktree: WorktreePath; cwd: string }): Promise<void> {
    const branch = `opencode-worker-${input.sessionID}`

    await exec(`git worktree remove "${input.worktree}" --force`, input.cwd)
    await exec(`git branch -D "${branch}"`, input.cwd)

    log.info("cleaned", { sessionID: input.sessionID })
  }
}
