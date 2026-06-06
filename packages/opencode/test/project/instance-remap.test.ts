import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { ProjectID } from "../../src/project/schema"

const project = {
  id: ProjectID.make("test"),
  name: "test",
  path: {
    root: "/projects/myapp",
    config: "/projects/myapp/.opencode",
    cwd: "/projects/myapp",
  },
  git: undefined,
} as any

function withContext<T>(ctx: Parameters<typeof Instance.restore>[0], fn: () => T): T {
  return Instance.restore(ctx, fn)
}

describe("Instance.remapArgs", () => {
  test("noop when pathRemapFrom not set", () => {
    const args = { filePath: "/projects/myapp/src/foo.ts", content: "hello" }
    const result = withContext({ directory: "/tmp/worktree-1", worktree: "/tmp/worktree-1", project }, () =>
      Instance.remapArgs(args),
    )
    expect(result).toEqual(args)
  })

  test("noop when pathRemapFrom equals directory", () => {
    const args = { filePath: "/projects/myapp/src/foo.ts" }
    const result = withContext(
      { directory: "/projects/myapp", worktree: "/projects/myapp", project, pathRemapFrom: "/projects/myapp" },
      () => Instance.remapArgs(args),
    )
    expect(result).toEqual(args)
  })

  test("remaps filePath from project root to worktree", () => {
    const args = { filePath: "/projects/myapp/src/foo.ts", oldString: "abc", newString: "xyz" }
    const result = withContext(
      { directory: "/tmp/worktree-1", worktree: "/tmp/worktree-1", project, pathRemapFrom: "/projects/myapp" },
      () => Instance.remapArgs(args),
    )
    expect(result.filePath).toBe("/tmp/worktree-1/src/foo.ts")
    expect(result.oldString).toBe("abc")
    expect(result.newString).toBe("xyz")
  })

  test("remaps path key", () => {
    const args = { path: "/projects/myapp/src", pattern: "**/*.ts" }
    const result = withContext(
      { directory: "/tmp/worktree-1", worktree: "/tmp/worktree-1", project, pathRemapFrom: "/projects/myapp" },
      () => Instance.remapArgs(args),
    )
    expect(result.path).toBe("/tmp/worktree-1/src")
    expect(result.pattern).toBe("**/*.ts")
  })

  test("remaps workdir key", () => {
    const args = { command: "ls -la", workdir: "/projects/myapp/build" }
    const result = withContext(
      { directory: "/tmp/worktree-1", worktree: "/tmp/worktree-1", project, pathRemapFrom: "/projects/myapp" },
      () => Instance.remapArgs(args),
    )
    expect(result.workdir).toBe("/tmp/worktree-1/build")
    expect(result.command).toBe("ls -la")
  })

  test("remaps exact match (directory root itself)", () => {
    const args = { path: "/projects/myapp" }
    const result = withContext(
      { directory: "/tmp/worktree-1", worktree: "/tmp/worktree-1", project, pathRemapFrom: "/projects/myapp" },
      () => Instance.remapArgs(args),
    )
    expect(result.path).toBe("/tmp/worktree-1")
  })

  test("does not remap non-whitelisted keys", () => {
    const args = { filePath: "/projects/myapp/a.ts", content: "/projects/myapp/should-not-remap" }
    const result = withContext(
      { directory: "/tmp/worktree-1", worktree: "/tmp/worktree-1", project, pathRemapFrom: "/projects/myapp" },
      () => Instance.remapArgs(args),
    )
    expect(result.filePath).toBe("/tmp/worktree-1/a.ts")
    expect(result.content).toBe("/projects/myapp/should-not-remap")
  })

  test("does not remap values that do not start with pathRemapFrom", () => {
    const args = { filePath: "/other/project/file.ts" }
    const result = withContext(
      { directory: "/tmp/worktree-1", worktree: "/tmp/worktree-1", project, pathRemapFrom: "/projects/myapp" },
      () => Instance.remapArgs(args),
    )
    expect(result.filePath).toBe("/other/project/file.ts")
  })

  test("does not remap non-string values in whitelisted keys", () => {
    const args = { path: 42, filePath: null }
    const result = withContext(
      { directory: "/tmp/worktree-1", worktree: "/tmp/worktree-1", project, pathRemapFrom: "/projects/myapp" },
      () => Instance.remapArgs(args as any),
    )
    expect(result.path).toBe(42)
    expect(result.filePath).toBe(null)
  })

  test("remaps multiple path keys in same args", () => {
    const args = { filePath: "/projects/myapp/a.ts", path: "/projects/myapp/b", dir: "/projects/myapp" }
    const result = withContext(
      { directory: "/tmp/worktree-1", worktree: "/tmp/worktree-1", project, pathRemapFrom: "/projects/myapp" },
      () => Instance.remapArgs(args),
    )
    expect(result.filePath).toBe("/tmp/worktree-1/a.ts")
    expect(result.path).toBe("/tmp/worktree-1/b")
    expect(result.dir).toBe("/tmp/worktree-1")
  })

  test("handles prefix that is substring of path but not directory boundary", () => {
    // /projects/myapp-v2/foo should NOT be remapped when from is /projects/myapp
    const args = { filePath: "/projects/myapp-v2/foo.ts" }
    const result = withContext(
      { directory: "/tmp/worktree-1", worktree: "/tmp/worktree-1", project, pathRemapFrom: "/projects/myapp" },
      () => Instance.remapArgs(args),
    )
    expect(result.filePath).toBe("/projects/myapp-v2/foo.ts")
  })

  test("does not mutate original args object", () => {
    const args = { filePath: "/projects/myapp/src/foo.ts" }
    withContext(
      { directory: "/tmp/worktree-1", worktree: "/tmp/worktree-1", project, pathRemapFrom: "/projects/myapp" },
      () => Instance.remapArgs(args),
    )
    expect(args.filePath).toBe("/projects/myapp/src/foo.ts")
  })

  test("all whitelisted keys are remapped", () => {
    const keys = ["filePath", "path", "workdir", "file_path", "directory", "dir", "file", "folder"]
    for (const key of keys) {
      const args = { [key]: "/projects/myapp/x" }
      const result = withContext(
        { directory: "/tmp/wt", worktree: "/tmp/wt", project, pathRemapFrom: "/projects/myapp" },
        () => Instance.remapArgs(args),
      )
      expect(result[key]).toBe("/tmp/wt/x")
    }
  })
})

describe("Instance.resolvePath", () => {
  test("relative path joins to directory", () => {
    const result = withContext({ directory: "/tmp/worktree-1", worktree: "/tmp/worktree-1", project }, () =>
      Instance.resolvePath("src/foo.ts"),
    )
    expect(result).toBe("/tmp/worktree-1/src/foo.ts")
  })

  test("absolute path unchanged when no pathRemapFrom", () => {
    const result = withContext({ directory: "/tmp/worktree-1", worktree: "/tmp/worktree-1", project }, () =>
      Instance.resolvePath("/some/other/path.ts"),
    )
    expect(result).toBe("/some/other/path.ts")
  })

  test("absolute path remapped when matching pathRemapFrom", () => {
    const result = withContext(
      { directory: "/tmp/worktree-1", worktree: "/tmp/worktree-1", project, pathRemapFrom: "/projects/myapp" },
      () => Instance.resolvePath("/projects/myapp/src/main.ts"),
    )
    expect(result).toBe("/tmp/worktree-1/src/main.ts")
  })

  test("exact pathRemapFrom maps to directory", () => {
    const result = withContext(
      { directory: "/tmp/worktree-1", worktree: "/tmp/worktree-1", project, pathRemapFrom: "/projects/myapp" },
      () => Instance.resolvePath("/projects/myapp"),
    )
    expect(result).toBe("/tmp/worktree-1")
  })

  test("absolute path not matching prefix unchanged", () => {
    const result = withContext(
      { directory: "/tmp/worktree-1", worktree: "/tmp/worktree-1", project, pathRemapFrom: "/projects/myapp" },
      () => Instance.resolvePath("/other/project/file.ts"),
    )
    expect(result).toBe("/other/project/file.ts")
  })

  test("does not false-match prefix substring", () => {
    const result = withContext(
      { directory: "/tmp/worktree-1", worktree: "/tmp/worktree-1", project, pathRemapFrom: "/projects/myapp" },
      () => Instance.resolvePath("/projects/myapp-v2/file.ts"),
    )
    expect(result).toBe("/projects/myapp-v2/file.ts")
  })
})
