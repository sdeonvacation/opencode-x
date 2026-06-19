export async function gitDiff(cwd: string): Promise<string> {
  // Stage all files (including untracked) so new files appear in the diff
  const add = Bun.spawn(["git", "add", "-A"], { cwd, stdout: "pipe", stderr: "pipe" })
  await add.exited
  const proc = Bun.spawn(["git", "diff", "HEAD", "--binary", "--staged"], { cwd, stdout: "pipe", stderr: "pipe" })
  const text = await new Response(proc.stdout).text()
  await proc.exited
  return text
}

export async function gitApply(patch: string, cwd: string): Promise<{ success: boolean; error: string }> {
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
