import { $ } from "bun"
import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Worktree } from "../../src/worktree"
import { tmpdir } from "../fixture/fixture"

function withInstance(directory: string, fn: () => Promise<any>) {
  return Instance.provide({ directory, fn })
}

describe("Worktree.findByName", () => {
  afterEach(() => Instance.disposeAll())

  test("returns null when no worktree exists with given name", async () => {
    await using tmp = await tmpdir({ git: true })

    const result = await withInstance(tmp.path, () => Worktree.findByName("nonexistent"))

    expect(result).toBeNull()
  })

  test("returns Info when worktree exists", async () => {
    await using tmp = await tmpdir({ git: true })

    const info = await withInstance(tmp.path, () => Worktree.create({ name: "lookup-test" }))

    // Wait for bootstrap
    await Bun.sleep(500)

    const found = await withInstance(tmp.path, () => Worktree.findByName("lookup-test"))

    expect(found).not.toBeNull()
    expect(found!.name).toBe("lookup-test")
    expect(found!.branch).toBe("opencode/lookup-test")
    expect(found!.directory).toBe(info.directory)

    // Cleanup
    await withInstance(info.directory, () => Instance.dispose())
    await Bun.sleep(100)
    await withInstance(tmp.path, () => Worktree.remove({ directory: info.directory }))
  })

  test("returns null after worktree is removed", async () => {
    await using tmp = await tmpdir({ git: true })

    const info = await withInstance(tmp.path, () => Worktree.create({ name: "remove-find" }))
    await Bun.sleep(500)

    await withInstance(info.directory, () => Instance.dispose())
    await Bun.sleep(100)
    await withInstance(tmp.path, () => Worktree.remove({ directory: info.directory }))

    const found = await withInstance(tmp.path, () => Worktree.findByName("remove-find"))

    expect(found).toBeNull()
  })

  test("throws NotGitError for non-git directories", async () => {
    await using tmp = await tmpdir()

    await expect(withInstance(tmp.path, () => Worktree.findByName("anything"))).rejects.toThrow("WorktreeNotGitError")
  })

  test("returns null when directory no longer exists on disk", async () => {
    await using tmp = await tmpdir({ git: true })

    const info = await withInstance(tmp.path, () => Worktree.create({ name: "ghost" }))
    await Bun.sleep(500)

    // Remove directory without git worktree remove (simulates missing dir)
    await withInstance(info.directory, () => Instance.dispose())
    await Bun.sleep(100)
    const { default: fs } = await import("fs/promises")
    await fs.rm(info.directory, { recursive: true, force: true })

    const found = await withInstance(tmp.path, () => Worktree.findByName("ghost"))

    expect(found).toBeNull()

    // Cleanup git state
    await $`git worktree prune`.cwd(tmp.path).quiet()
  })
})
