import { describe, test, expect } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { OrchestrationBranchPR } from "../../src/orchestration/branch-pr"
import { $ } from "bun"
import path from "path"
import fs from "fs/promises"

describe("orchestration/branch-pr (worktree)", () => {
  test("create returns WorktreeInfo with id, worktree path, base, cwd", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "file.txt"), "hello")
    await $`git add -A && git commit -m "seed"`.cwd(tmp.path).quiet()

    const wt = await OrchestrationBranchPR.create({
      session: "abc12345-dead-beef-1234-567890abcdef",
      cwd: tmp.path,
      slug: "test feature",
    })

    expect(wt.id).toContain("abc12345")
    expect(wt.id).toContain("test-feature")
    expect(wt.worktree).toContain("opencode-brpr-")
    expect(wt.base).toHaveLength(40)
    expect(wt.cwd).toBe(tmp.path)

    await OrchestrationBranchPR.cleanup({ worktree: wt })
  })

  test("create uses detached worktree (no branch created)", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "file.txt"), "hello")
    await $`git add -A && git commit -m "seed"`.cwd(tmp.path).quiet()

    const wt = await OrchestrationBranchPR.create({
      session: "detach01-0000-0000-0000-000000000000",
      cwd: tmp.path,
      slug: "detach test",
    })

    // No branch should be created
    const branches = await $`git branch --list "opencode/*"`.cwd(tmp.path).quiet().text()
    expect(branches.trim()).toBe("")

    // Worktree should exist as directory
    const stat = await fs.stat(wt.worktree)
    expect(stat.isDirectory()).toBe(true)

    await OrchestrationBranchPR.cleanup({ worktree: wt })
  })

  test("create throws WorktreeError on invalid cwd", async () => {
    await expect(
      OrchestrationBranchPR.create({
        session: "err00000-0000-0000-0000-000000000000",
        cwd: "/nonexistent-dir-12345",
        slug: "fail",
      }),
    ).rejects.toThrow()
  })

  test("diff detects modified files in worktree", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "file.txt"), "original")
    await $`git add -A && git commit -m "base"`.cwd(tmp.path).quiet()

    const wt = await OrchestrationBranchPR.create({
      session: "diff0001-0000-0000-0000-000000000000",
      cwd: tmp.path,
      slug: "diff test",
    })

    // Modify file in worktree
    await Bun.write(path.join(wt.worktree, "file.txt"), "modified")

    const result = await OrchestrationBranchPR.diff({ worktree: wt })

    expect(result.files_changed).toBe(1)
    expect(result.insertions).toBeGreaterThan(0)
    expect(result.files[0].path).toBe("file.txt")
    expect(result.files[0].status).toBe("M")
    expect(result.truncated).toBe(false)

    await OrchestrationBranchPR.cleanup({ worktree: wt })
  })

  test("diff detects new untracked files", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "base.txt"), "base")
    await $`git add -A && git commit -m "base"`.cwd(tmp.path).quiet()

    const wt = await OrchestrationBranchPR.create({
      session: "diff0002-0000-0000-0000-000000000000",
      cwd: tmp.path,
      slug: "untracked",
    })

    await Bun.write(path.join(wt.worktree, "new.txt"), "brand new file")

    const result = await OrchestrationBranchPR.diff({ worktree: wt })

    expect(result.files_changed).toBe(1)
    const added = result.files.find((f) => f.path === "new.txt")
    expect(added).toBeDefined()
    expect(added!.status).toBe("A")

    await OrchestrationBranchPR.cleanup({ worktree: wt })
  })

  test("diff detects deleted files", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "doomed.txt"), "will be deleted")
    await $`git add -A && git commit -m "base"`.cwd(tmp.path).quiet()

    const wt = await OrchestrationBranchPR.create({
      session: "diff0003-0000-0000-0000-000000000000",
      cwd: tmp.path,
      slug: "delete",
    })

    await fs.unlink(path.join(wt.worktree, "doomed.txt"))

    const result = await OrchestrationBranchPR.diff({ worktree: wt })

    expect(result.files_changed).toBe(1)
    expect(result.files[0].status).toBe("D")
    expect(result.deletions).toBeGreaterThan(0)

    await OrchestrationBranchPR.cleanup({ worktree: wt })
  })

  test("diff returns empty when no changes", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "file.txt"), "unchanged")
    await $`git add -A && git commit -m "base"`.cwd(tmp.path).quiet()

    const wt = await OrchestrationBranchPR.create({
      session: "diff0004-0000-0000-0000-000000000000",
      cwd: tmp.path,
      slug: "empty",
    })

    const result = await OrchestrationBranchPR.diff({ worktree: wt })

    expect(result.files_changed).toBe(0)
    expect(result.insertions).toBe(0)
    expect(result.deletions).toBe(0)
    expect(result.files).toHaveLength(0)

    await OrchestrationBranchPR.cleanup({ worktree: wt })
  })

  test("diff truncates when exceeding maxLines", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "base.txt"), "base")
    await $`git add -A && git commit -m "base"`.cwd(tmp.path).quiet()

    const wt = await OrchestrationBranchPR.create({
      session: "diff0005-0000-0000-0000-000000000000",
      cwd: tmp.path,
      slug: "truncate",
    })

    // Create a large file that will exceed maxLines=5
    const big = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n")
    await Bun.write(path.join(wt.worktree, "big.txt"), big)

    const result = await OrchestrationBranchPR.diff({ worktree: wt, maxLines: 5 })

    expect(result.truncated).toBe(true)
    expect(result.files.some((f) => f.patch === "(truncated)")).toBe(true)

    await OrchestrationBranchPR.cleanup({ worktree: wt })
  })

  test("apply copies modified files to real directory", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "file.txt"), "original")
    await $`git add -A && git commit -m "base"`.cwd(tmp.path).quiet()

    const wt = await OrchestrationBranchPR.create({
      session: "apply001-0000-0000-0000-000000000000",
      cwd: tmp.path,
      slug: "apply mod",
    })

    await Bun.write(path.join(wt.worktree, "file.txt"), "modified by subagent")

    const result = await OrchestrationBranchPR.apply({ worktree: wt })

    expect(result.applied).toContain("file.txt")
    expect(result.conflicts).toHaveLength(0)

    // Verify file was copied to real directory
    const content = await Bun.file(path.join(tmp.path, "file.txt")).text()
    expect(content).toBe("modified by subagent")

    await OrchestrationBranchPR.cleanup({ worktree: wt })
  })

  test("apply copies new files to real directory", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "existing.txt"), "base")
    await $`git add -A && git commit -m "base"`.cwd(tmp.path).quiet()

    const wt = await OrchestrationBranchPR.create({
      session: "apply002-0000-0000-0000-000000000000",
      cwd: tmp.path,
      slug: "apply new",
    })

    await Bun.write(path.join(wt.worktree, "brand-new.txt"), "new content")

    const result = await OrchestrationBranchPR.apply({ worktree: wt })

    expect(result.applied).toContain("brand-new.txt")
    expect(result.conflicts).toHaveLength(0)

    const content = await Bun.file(path.join(tmp.path, "brand-new.txt")).text()
    expect(content).toBe("new content")

    await OrchestrationBranchPR.cleanup({ worktree: wt })
  })

  test("apply deletes files from real directory", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "to-delete.txt"), "will be gone")
    await $`git add -A && git commit -m "base"`.cwd(tmp.path).quiet()

    const wt = await OrchestrationBranchPR.create({
      session: "apply003-0000-0000-0000-000000000000",
      cwd: tmp.path,
      slug: "apply del",
    })

    await fs.unlink(path.join(wt.worktree, "to-delete.txt"))

    const result = await OrchestrationBranchPR.apply({ worktree: wt })

    expect(result.applied).toContain("to-delete.txt")
    expect(result.conflicts).toHaveLength(0)

    const exists = await Bun.file(path.join(tmp.path, "to-delete.txt")).exists()
    expect(exists).toBe(false)

    await OrchestrationBranchPR.cleanup({ worktree: wt })
  })

  test("apply creates parent directories for new files", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "root.txt"), "base")
    await $`git add -A && git commit -m "base"`.cwd(tmp.path).quiet()

    const wt = await OrchestrationBranchPR.create({
      session: "apply004-0000-0000-0000-000000000000",
      cwd: tmp.path,
      slug: "nested",
    })

    await fs.mkdir(path.join(wt.worktree, "deep", "nested"), { recursive: true })
    await Bun.write(path.join(wt.worktree, "deep", "nested", "file.txt"), "deep content")

    const result = await OrchestrationBranchPR.apply({ worktree: wt })

    expect(result.applied).toContain("deep/nested/file.txt")
    const content = await Bun.file(path.join(tmp.path, "deep", "nested", "file.txt")).text()
    expect(content).toBe("deep content")

    await OrchestrationBranchPR.cleanup({ worktree: wt })
  })

  test("apply detects conflict when file modified in real dir since base", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "shared.txt"), "original")
    await $`git add -A && git commit -m "base"`.cwd(tmp.path).quiet()

    const wt = await OrchestrationBranchPR.create({
      session: "conf0001-0000-0000-0000-000000000000",
      cwd: tmp.path,
      slug: "conflict",
    })

    // Modify in worktree (subagent)
    await Bun.write(path.join(wt.worktree, "shared.txt"), "subagent version")

    // Simulate another apply modifying the same file in real dir
    await Bun.write(path.join(tmp.path, "shared.txt"), "other subagent version")

    const result = await OrchestrationBranchPR.apply({ worktree: wt })

    expect(result.conflicts).toContain("shared.txt")
    expect(result.applied).not.toContain("shared.txt")

    // Real file should be unchanged (conflict preserved it)
    const content = await Bun.file(path.join(tmp.path, "shared.txt")).text()
    expect(content).toBe("other subagent version")

    await OrchestrationBranchPR.cleanup({ worktree: wt })
  })

  test("apply detects conflict when new file created by another apply", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "base.txt"), "base")
    await $`git add -A && git commit -m "base"`.cwd(tmp.path).quiet()

    const wt = await OrchestrationBranchPR.create({
      session: "conf0002-0000-0000-0000-000000000000",
      cwd: tmp.path,
      slug: "new conflict",
    })

    // Create file in worktree
    await Bun.write(path.join(wt.worktree, "collision.txt"), "my version")

    // Another apply already created same file in real dir
    await Bun.write(path.join(tmp.path, "collision.txt"), "other version")

    const result = await OrchestrationBranchPR.apply({ worktree: wt })

    expect(result.conflicts).toContain("collision.txt")
    expect(result.applied).not.toContain("collision.txt")

    // Other version preserved
    const content = await Bun.file(path.join(tmp.path, "collision.txt")).text()
    expect(content).toBe("other version")

    await OrchestrationBranchPR.cleanup({ worktree: wt })
  })

  test("apply handles mixed applied and conflicting files", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "clean.txt"), "clean")
    await Bun.write(path.join(tmp.path, "conflict.txt"), "original")
    await $`git add -A && git commit -m "base"`.cwd(tmp.path).quiet()

    const wt = await OrchestrationBranchPR.create({
      session: "conf0003-0000-0000-0000-000000000000",
      cwd: tmp.path,
      slug: "mixed",
    })

    // Modify both in worktree
    await Bun.write(path.join(wt.worktree, "clean.txt"), "clean modified")
    await Bun.write(path.join(wt.worktree, "conflict.txt"), "subagent")

    // Only conflict.txt modified in real dir
    await Bun.write(path.join(tmp.path, "conflict.txt"), "someone else")

    const result = await OrchestrationBranchPR.apply({ worktree: wt })

    // All-or-nothing: conflict means nothing applied
    expect(result.applied).toEqual([])
    expect(result.conflicts).toContain("conflict.txt")

    // Neither file modified in real dir
    expect(await Bun.file(path.join(tmp.path, "clean.txt")).text()).toBe("clean")
    expect(await Bun.file(path.join(tmp.path, "conflict.txt")).text()).toBe("someone else")

    await OrchestrationBranchPR.cleanup({ worktree: wt })
  })

  test("cleanup removes worktree directory", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "file.txt"), "content")
    await $`git add -A && git commit -m "base"`.cwd(tmp.path).quiet()

    const wt = await OrchestrationBranchPR.create({
      session: "clean001-0000-0000-0000-000000000000",
      cwd: tmp.path,
      slug: "cleanup",
    })

    const exists = await fs
      .stat(wt.worktree)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(true)

    await OrchestrationBranchPR.cleanup({ worktree: wt })

    const gone = await fs
      .stat(wt.worktree)
      .then(() => false)
      .catch(() => true)
    expect(gone).toBe(true)
  })

  test("sweep removes old worktrees", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "file.txt"), "content")
    await $`git add -A && git commit -m "base"`.cwd(tmp.path).quiet()

    const wt = await OrchestrationBranchPR.create({
      session: "sweep001-0000-0000-0000-000000000000",
      cwd: tmp.path,
      slug: "sweep test",
    })

    // Set mtime to past (older than TTL)
    const past = new Date(Date.now() - 100_000)
    await fs.utimes(wt.worktree, past, past)

    // Sweep with small TTL
    const result = await OrchestrationBranchPR.sweep({ cwd: tmp.path, ttl: 1000 })

    expect(result.removed.length).toBeGreaterThanOrEqual(1)
    expect(result.removed[0]).toContain("opencode-brpr-")
  })

  test("sweep skips recent worktrees", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "file.txt"), "content")
    await $`git add -A && git commit -m "base"`.cwd(tmp.path).quiet()

    const wt = await OrchestrationBranchPR.create({
      session: "sweep002-0000-0000-0000-000000000000",
      cwd: tmp.path,
      slug: "recent",
    })

    // Sweep with large TTL — recent worktree should survive
    const result = await OrchestrationBranchPR.sweep({ cwd: tmp.path, ttl: 999_999_999 })

    expect(result.removed).toHaveLength(0)

    await OrchestrationBranchPR.cleanup({ worktree: wt })
  })

  test("multiple worktrees can coexist from same repo", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "file.txt"), "content")
    await $`git add -A && git commit -m "base"`.cwd(tmp.path).quiet()

    const wt1 = await OrchestrationBranchPR.create({
      session: "multi001-0000-0000-0000-000000000000",
      cwd: tmp.path,
      slug: "first",
    })

    const wt2 = await OrchestrationBranchPR.create({
      session: "multi001-0000-0000-0000-000000000000",
      cwd: tmp.path,
      slug: "second",
    })

    expect(wt1.worktree).not.toBe(wt2.worktree)
    expect(wt1.id).not.toBe(wt2.id)

    // Both should be usable
    await Bun.write(path.join(wt1.worktree, "from-wt1.txt"), "wt1")
    await Bun.write(path.join(wt2.worktree, "from-wt2.txt"), "wt2")

    const d1 = await OrchestrationBranchPR.diff({ worktree: wt1 })
    const d2 = await OrchestrationBranchPR.diff({ worktree: wt2 })

    expect(d1.files_changed).toBe(1)
    expect(d2.files_changed).toBe(1)

    await OrchestrationBranchPR.cleanup({ worktree: wt1 })
    await OrchestrationBranchPR.cleanup({ worktree: wt2 })
  })

  test("apply with no changes returns empty applied list", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "file.txt"), "unchanged")
    await $`git add -A && git commit -m "base"`.cwd(tmp.path).quiet()

    const wt = await OrchestrationBranchPR.create({
      session: "noop0001-0000-0000-0000-000000000000",
      cwd: tmp.path,
      slug: "noop",
    })

    const result = await OrchestrationBranchPR.apply({ worktree: wt })

    expect(result.applied).toHaveLength(0)
    expect(result.conflicts).toHaveLength(0)

    await OrchestrationBranchPR.cleanup({ worktree: wt })
  })
})
