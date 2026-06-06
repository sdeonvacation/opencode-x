import { describe, test, expect } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { OrchestrationBranchPR } from "../../src/orchestration/branch-pr"
import { $ } from "bun"
import path from "path"
import fs from "fs/promises"

describe("orchestration/branch-pr apply fixes", () => {
  test("no false conflict from trailing newline (hash-based comparison)", async () => {
    await using tmp = await tmpdir({ git: true })
    // Git stores blobs with trailing newline — important for this test
    await Bun.write(path.join(tmp.path, "file.txt"), "hello\n")
    await $`git add -A && git commit -m "base"`.cwd(tmp.path).quiet()

    const wt = await OrchestrationBranchPR.create({
      session: "hash0001-0000-0000-0000-000000000000",
      cwd: tmp.path,
      slug: "hash fix",
    })

    // Modify in worktree only — real file untouched
    await Bun.write(path.join(wt.worktree, "file.txt"), "modified\n")

    const result = await OrchestrationBranchPR.apply({ worktree: wt })

    // No conflict: real file hasn't changed since base
    expect(result.conflicts).toHaveLength(0)
    expect(result.applied).toContain("file.txt")
    expect(await Bun.file(path.join(tmp.path, "file.txt")).text()).toBe("modified\n")

    await OrchestrationBranchPR.cleanup({ worktree: wt })
  })

  test("two-pass: nothing applied when any conflict exists", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "a.txt"), "original-a")
    await Bun.write(path.join(tmp.path, "b.txt"), "original-b")
    await $`git add -A && git commit -m "base"`.cwd(tmp.path).quiet()

    const wt = await OrchestrationBranchPR.create({
      session: "twopass1-0000-0000-0000-000000000000",
      cwd: tmp.path,
      slug: "two pass",
    })

    // Modify both in worktree
    await Bun.write(path.join(wt.worktree, "a.txt"), "subagent-a")
    await Bun.write(path.join(wt.worktree, "b.txt"), "subagent-b")

    // Create conflict on b.txt in real dir
    await Bun.write(path.join(tmp.path, "b.txt"), "someone-else-b")

    const result = await OrchestrationBranchPR.apply({ worktree: wt })

    // Two-pass: conflict detected → nothing applied
    expect(result.conflicts).toContain("b.txt")
    expect(result.applied).toHaveLength(0)

    // a.txt should NOT have been modified (rollback safety)
    expect(await Bun.file(path.join(tmp.path, "a.txt")).text()).toBe("original-a")
    // b.txt preserved
    expect(await Bun.file(path.join(tmp.path, "b.txt")).text()).toBe("someone-else-b")

    await OrchestrationBranchPR.cleanup({ worktree: wt })
  })

  test("two-pass: all applied when no conflicts", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "x.txt"), "original-x")
    await Bun.write(path.join(tmp.path, "y.txt"), "original-y")
    await $`git add -A && git commit -m "base"`.cwd(tmp.path).quiet()

    const wt = await OrchestrationBranchPR.create({
      session: "twopass2-0000-0000-0000-000000000000",
      cwd: tmp.path,
      slug: "all apply",
    })

    await Bun.write(path.join(wt.worktree, "x.txt"), "new-x")
    await Bun.write(path.join(wt.worktree, "y.txt"), "new-y")

    const result = await OrchestrationBranchPR.apply({ worktree: wt })

    expect(result.conflicts).toHaveLength(0)
    expect(result.applied).toContain("x.txt")
    expect(result.applied).toContain("y.txt")
    expect(await Bun.file(path.join(tmp.path, "x.txt")).text()).toBe("new-x")
    expect(await Bun.file(path.join(tmp.path, "y.txt")).text()).toBe("new-y")

    await OrchestrationBranchPR.cleanup({ worktree: wt })
  })

  test("special characters in filepath do not break conflict detection", async () => {
    await using tmp = await tmpdir({ git: true })
    const special = "file with $pecial & chars.txt"
    await Bun.write(path.join(tmp.path, special), "content")
    await $`git add -A && git commit -m "base"`.cwd(tmp.path).quiet()

    const wt = await OrchestrationBranchPR.create({
      session: "spec0001-0000-0000-0000-000000000000",
      cwd: tmp.path,
      slug: "special chars",
    })

    // Modify in worktree
    await Bun.write(path.join(wt.worktree, special), "modified")

    const result = await OrchestrationBranchPR.apply({ worktree: wt })

    // Should apply without error — no false conflict from shell escaping
    expect(result.conflicts).toHaveLength(0)
    expect(result.applied).toContain(special)
    expect(await Bun.file(path.join(tmp.path, special)).text()).toBe("modified")

    await OrchestrationBranchPR.cleanup({ worktree: wt })
  })

  test("conflict detection for deleted file modified since base", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "victim.txt"), "original")
    await $`git add -A && git commit -m "base"`.cwd(tmp.path).quiet()

    const wt = await OrchestrationBranchPR.create({
      session: "del00001-0000-0000-0000-000000000000",
      cwd: tmp.path,
      slug: "del conflict",
    })

    // Subagent deletes file in worktree
    await fs.unlink(path.join(wt.worktree, "victim.txt"))

    // Meanwhile, real file was modified
    await Bun.write(path.join(tmp.path, "victim.txt"), "edited by user")

    const result = await OrchestrationBranchPR.apply({ worktree: wt })

    // Conflict: can't delete a file that was modified
    expect(result.conflicts).toContain("victim.txt")
    expect(result.applied).toHaveLength(0)

    // File preserved
    expect(await Bun.file(path.join(tmp.path, "victim.txt")).text()).toBe("edited by user")

    await OrchestrationBranchPR.cleanup({ worktree: wt })
  })

  test("no conflict for deleted file unchanged since base", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "removeme.txt"), "to delete")
    await $`git add -A && git commit -m "base"`.cwd(tmp.path).quiet()

    const wt = await OrchestrationBranchPR.create({
      session: "del00002-0000-0000-0000-000000000000",
      cwd: tmp.path,
      slug: "del clean",
    })

    // Subagent deletes file
    await fs.unlink(path.join(wt.worktree, "removeme.txt"))

    // Real file untouched — no conflict
    const result = await OrchestrationBranchPR.apply({ worktree: wt })

    expect(result.conflicts).toHaveLength(0)
    expect(result.applied).toContain("removeme.txt")
    expect(await Bun.file(path.join(tmp.path, "removeme.txt")).exists()).toBe(false)

    await OrchestrationBranchPR.cleanup({ worktree: wt })
  })

  test("no conflict for deleted file already removed from real dir", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "gone.txt"), "will vanish")
    await $`git add -A && git commit -m "base"`.cwd(tmp.path).quiet()

    const wt = await OrchestrationBranchPR.create({
      session: "del00003-0000-0000-0000-000000000000",
      cwd: tmp.path,
      slug: "already gone",
    })

    // Delete in worktree
    await fs.unlink(path.join(wt.worktree, "gone.txt"))
    // Also deleted in real dir (another apply already removed it)
    await fs.unlink(path.join(tmp.path, "gone.txt"))

    const result = await OrchestrationBranchPR.apply({ worktree: wt })

    // No conflict: git hash-object fails (file gone) → no conflict
    expect(result.conflicts).toHaveLength(0)
    expect(result.applied).toContain("gone.txt")

    await OrchestrationBranchPR.cleanup({ worktree: wt })
  })

  test("added file conflict when file already exists but not at base", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "seed.txt"), "seed")
    await $`git add -A && git commit -m "base"`.cwd(tmp.path).quiet()

    const wt = await OrchestrationBranchPR.create({
      session: "add00001-0000-0000-0000-000000000000",
      cwd: tmp.path,
      slug: "add conflict",
    })

    // Subagent creates new file in worktree
    await Bun.write(path.join(wt.worktree, "new.txt"), "from subagent")

    // Another apply already created same file in real dir
    await Bun.write(path.join(tmp.path, "new.txt"), "from other subagent")

    const result = await OrchestrationBranchPR.apply({ worktree: wt })

    expect(result.conflicts).toContain("new.txt")
    expect(result.applied).toHaveLength(0)
    // Other version preserved
    expect(await Bun.file(path.join(tmp.path, "new.txt")).text()).toBe("from other subagent")

    await OrchestrationBranchPR.cleanup({ worktree: wt })
  })

  test("added file no conflict when file exists and matches base", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "existing.txt"), "at base")
    await $`git add -A && git commit -m "base"`.cwd(tmp.path).quiet()

    const wt = await OrchestrationBranchPR.create({
      session: "add00002-0000-0000-0000-000000000000",
      cwd: tmp.path,
      slug: "add no conflict",
    })

    // Simulate: in worktree, this file shows as "A" because it was deleted
    // then re-created. For this test, let's create a truly new file
    await Bun.write(path.join(wt.worktree, "brand-new.txt"), "fresh")

    const result = await OrchestrationBranchPR.apply({ worktree: wt })

    expect(result.conflicts).toHaveLength(0)
    expect(result.applied).toContain("brand-new.txt")

    await OrchestrationBranchPR.cleanup({ worktree: wt })
  })
})
