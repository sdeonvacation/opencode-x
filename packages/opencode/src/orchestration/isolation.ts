import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Worktree } from "@/worktree"
import * as PatchLock from "./patch-lock"
import { Log } from "@/util/log"

const log = Log.create({ service: "isolation" })

export type IsolationInput = {
  sessionID: string
  run: () => Promise<string>
  name?: string
}

export type PatchResult =
  | { status: "applied" }
  | { status: "empty" }
  | { status: "conflict"; branch: string; message: string }

export type IsolationResult = {
  output: string
  patch: PatchResult
}

export async function isolatedRun(input: IsolationInput): Promise<IsolationResult> {
  // Capture parent context before any async work (required for background mode where ALS is lost)
  const project = Instance.project.id
  const target = Instance.directory

  const info = await Worktree.makeWorktreeInfo(input.name ?? input.sessionID)
  log.info("isolatedRun started", { sessionID: input.sessionID, branch: info.branch, directory: info.directory })
  await Worktree.createFromInfo(info)

  let output = ""
  let diff = ""

  try {
    const result = await Instance.provide({
      directory: info.directory,
      isolated: true,
      init: InstanceBootstrap,
      fn: async () => {
        try {
          const text = await input.run()
          const patch = await gitDiff(info.directory)
          return { output: text, patch }
        } finally {
          await Instance.dispose()
        }
      },
    })
    output = result.output
    diff = result.patch
  } catch (e) {
    log.error("isolated run failed", { error: e instanceof Error ? e.message : String(e) })
    try {
      diff = await gitDiff(info.directory)
    } catch {}
    output = e instanceof Error ? e.message : String(e)
  }

  if (!diff.trim()) {
    await cleanup(info.directory)
    return { output, patch: { status: "empty" } }
  }

  await PatchLock.acquire(project)
  try {
    const applied = await gitApply(diff, target)
    if (!applied.success) {
      log.warn("patch conflict", { branch: info.branch, error: applied.error })
      // Do NOT remove worktree on conflict — branch preserved for user recovery
      return { output, patch: { status: "conflict", branch: info.branch, message: applied.error } }
    }
  } finally {
    PatchLock.release(project)
  }

  await cleanup(info.directory)
  return { output, patch: { status: "applied" } }
}

async function gitDiff(cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", "diff", "HEAD", "--binary"], { cwd, stdout: "pipe", stderr: "pipe" })
  const text = await new Response(proc.stdout).text()
  await proc.exited
  return text
}

async function gitApply(patch: string, cwd: string): Promise<{ success: boolean; error: string }> {
  const proc = Bun.spawn(["git", "apply", "--3way", "-"], {
    cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  proc.stdin.write(patch)
  proc.stdin.end()
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (code !== 0) return { success: false, error: stderr || "git apply failed" }
  return { success: true, error: "" }
}

async function cleanup(directory: string) {
  try {
    await Worktree.remove({ directory })
  } catch (e) {
    log.warn("worktree cleanup failed", { directory, error: e instanceof Error ? e.message : String(e) })
  }
}
