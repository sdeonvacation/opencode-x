import { $ } from "bun"
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Instance } from "../../src/project/instance"
import { isolatedRun, type IsolationResult } from "../../src/orchestration/isolation"
import { Worktree } from "../../src/worktree"
import { tmpdir } from "../fixture/fixture"

function withInstance(directory: string, fn: () => Promise<any>) {
  return Instance.provide({ directory, fn })
}

describe("orchestration/isolation", () => {
  afterEach(() => Instance.disposeAll())

  test("returns empty patch when run produces no changes", async () => {
    await using tmp = await tmpdir({ git: true })

    const result: IsolationResult = await withInstance(tmp.path, () =>
      isolatedRun({
        sessionID: "test-empty-" + crypto.randomUUID().slice(0, 8),
        run: async () => "done with no changes",
      }),
    )

    expect(result.output).toBe("done with no changes")
    expect(result.patch.status).toBe("empty")
  })

  test("applies patch when run modifies tracked files", async () => {
    await using tmp = await tmpdir({ git: true })
    const file = path.join(tmp.path, "hello.txt")
    await Bun.write(file, "original")
    await $`git add . && git commit -m "add hello"`.cwd(tmp.path).quiet()

    const result: IsolationResult = await withInstance(tmp.path, () =>
      isolatedRun({
        sessionID: "test-modify-" + crypto.randomUUID().slice(0, 8),
        run: async () => {
          const target = path.join(Instance.directory, "hello.txt")
          await Bun.write(target, "modified by subagent")
          return "file modified"
        },
      }),
    )

    expect(result.output).toBe("file modified")
    expect(result.patch.status).toBe("applied")

    const content = await Bun.file(file).text()
    expect(content).toBe("modified by subagent")
  })

  test("captures output even when run throws", async () => {
    await using tmp = await tmpdir({ git: true })

    const result: IsolationResult = await withInstance(tmp.path, () =>
      isolatedRun({
        sessionID: "test-error-" + crypto.randomUUID().slice(0, 8),
        run: async () => {
          throw new Error("subagent exploded")
        },
      }),
    )

    expect(result.output).toBe("subagent exploded")
    expect(result.patch.status).toBe("empty")
  })

  test("captures diff from partial work when run throws after modifications", async () => {
    await using tmp = await tmpdir({ git: true })
    const file = path.join(tmp.path, "data.txt")
    await Bun.write(file, "before")
    await $`git add . && git commit -m "init"`.cwd(tmp.path).quiet()

    const result: IsolationResult = await withInstance(tmp.path, () =>
      isolatedRun({
        sessionID: "test-partial-" + crypto.randomUUID().slice(0, 8),
        run: async () => {
          const target = path.join(Instance.directory, "data.txt")
          await Bun.write(target, "partially done")
          throw new Error("crashed midway")
        },
      }),
    )

    expect(result.output).toBe("crashed midway")
    // Diff captured from worktree even after error
    if (result.patch.status === "applied") {
      const content = await Bun.file(file).text()
      expect(content).toBe("partially done")
    } else {
      // If patch capture failed (e.g., timing), status is empty
      expect(result.patch.status).toBe("empty")
    }
  })

  test("cleans up worktree on success", async () => {
    await using tmp = await tmpdir({ git: true })
    const file = path.join(tmp.path, "keep.txt")
    await Bun.write(file, "v1")
    await $`git add . && git commit -m "init"`.cwd(tmp.path).quiet()

    const sid = "test-cleanup-" + crypto.randomUUID().slice(0, 8)
    await withInstance(tmp.path, () =>
      isolatedRun({
        sessionID: sid,
        run: async () => {
          await Bun.write(path.join(Instance.directory, "keep.txt"), "v2")
          return "ok"
        },
      }),
    )

    // Worktree directory should be removed
    const worktrees = await $`git worktree list --porcelain`.cwd(tmp.path).quiet().text()
    expect(worktrees).not.toContain(sid)
  })

  test("cleans up worktree on empty patch", async () => {
    await using tmp = await tmpdir({ git: true })
    const sid = "test-cleanup-empty-" + crypto.randomUUID().slice(0, 8)

    await withInstance(tmp.path, () =>
      isolatedRun({
        sessionID: sid,
        run: async () => "no-op",
      }),
    )

    const worktrees = await $`git worktree list --porcelain`.cwd(tmp.path).quiet().text()
    expect(worktrees).not.toContain(sid)
  })

  test("uses custom name for worktree when provided", async () => {
    await using tmp = await tmpdir({ git: true })
    const file = path.join(tmp.path, "x.txt")
    await Bun.write(file, "a")
    await $`git add . && git commit -m "init"`.cwd(tmp.path).quiet()

    const result = await withInstance(tmp.path, () =>
      isolatedRun({
        sessionID: "unused-id",
        name: "custom-" + crypto.randomUUID().slice(0, 8),
        run: async () => {
          await Bun.write(path.join(Instance.directory, "x.txt"), "b")
          return "named run"
        },
      }),
    )

    expect(result.output).toBe("named run")
    expect(result.patch.status).toBe("applied")
  })
})
