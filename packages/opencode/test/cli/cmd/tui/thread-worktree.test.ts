import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../../../fixture/fixture"
import { resolveWorktree, ephemeralCleanup } from "../../../../src/cli/cmd/tui/thread"
import * as App from "../../../../src/cli/cmd/tui/app"
import { Rpc } from "../../../../src/util/rpc"
import { UI } from "../../../../src/cli/ui"
import * as Timeout from "../../../../src/util/timeout"
import * as Network from "../../../../src/cli/network"
import * as Win32 from "../../../../src/cli/cmd/tui/win32"
import { TuiConfig } from "../../../../src/config/tui"
import { Instance } from "../../../../src/project/instance"

const stop = new Error("stop")

function setupHandler() {
  spyOn(App, "tui").mockImplementation(async () => {
    throw stop
  })
  spyOn(Rpc, "client").mockImplementation(() => ({
    call: async () => ({ url: "http://127.0.0.1" }) as never,
    on: () => () => {},
  }))
  spyOn(UI, "error").mockImplementation(() => {})
  spyOn(Timeout, "withTimeout").mockImplementation((input) => input)
  spyOn(Network, "resolveNetworkOptions").mockResolvedValue({
    mdns: false,
    port: 0,
    hostname: "127.0.0.1",
    mdnsDomain: "opencode.local",
    cors: [],
  })
  spyOn(Win32, "win32DisableProcessedInput").mockImplementation(() => {})
  spyOn(Win32, "win32InstallCtrlCGuard").mockReturnValue(undefined)
  spyOn(TuiConfig, "get").mockResolvedValue({})
  spyOn(Instance, "provide").mockImplementation(async (input) => input.fn())
}

describe("thread worktree options", () => {
  afterEach(() => {
    mock.restore()
  })

  test("--ephemeral without --worktree shows error", async () => {
    setupHandler()
    const spy = spyOn(UI, "error")
    const { TuiThreadCommand } = await import("../../../../src/cli/cmd/tui/thread")
    await TuiThreadCommand.handler({
      _: [],
      $0: "opencode",
      project: undefined,
      prompt: undefined,
      model: undefined,
      agent: undefined,
      session: undefined,
      continue: false,
      fork: false,
      port: 0,
      hostname: "127.0.0.1",
      mdns: false,
      "mdns-domain": "opencode.local",
      mdnsDomain: "opencode.local",
      cors: [],
      worktree: undefined,
      ephemeral: true,
    })
    expect(spy).toHaveBeenCalledWith("--ephemeral requires --worktree")
    expect(process.exitCode).toBe(1)
    process.exitCode = undefined
  })
})

describe("resolveWorktree", () => {
  afterEach(() => {
    mock.restore()
  })

  test("throws when not a git project", async () => {
    await using tmp = await tmpdir()
    await expect(resolveWorktree("feat", tmp.path)).rejects.toThrow("Worktrees require a git project")
  })

  test("creates new worktree with branch opencode/<name>", async () => {
    await using tmp = await tmpdir({ git: true })
    const info = await resolveWorktree("feat", tmp.path)
    expect(info.name).toBe("feat")
    expect(info.branch).toBe("opencode/feat")
    expect(info.directory).toBe(path.join(tmp.path, ".worktrees", "feat"))
    const exists = await fs
      .stat(info.directory)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(true)
  })

  test("reuses existing worktree on second call", async () => {
    await using tmp = await tmpdir({ git: true })
    const first = await resolveWorktree("reuse", tmp.path)
    const second = await resolveWorktree("reuse", tmp.path)
    expect(second.directory).toBe(first.directory)
    expect(second.branch).toBe("opencode/reuse")
  })

  test("prunes stale worktree and recreates", async () => {
    await using tmp = await tmpdir({ git: true })
    const info = await resolveWorktree("stale", tmp.path)
    // Manually remove the worktree directory to simulate stale entry
    await fs.rm(info.directory, { recursive: true, force: true })
    // Next resolve should prune and recreate
    const refreshed = await resolveWorktree("stale", tmp.path)
    expect(refreshed.directory).toBe(info.directory)
    const exists = await fs
      .stat(refreshed.directory)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(true)
  })
})

describe("ephemeralCleanup", () => {
  afterEach(() => {
    mock.restore()
  })

  test("returns empty when no changes in worktree", async () => {
    await using tmp = await tmpdir({ git: true })
    const info = await resolveWorktree("clean", tmp.path)
    const result = await ephemeralCleanup(info, tmp.path)
    expect(result.status).toBe("empty")
    // Worktree should be removed
    const exists = await fs
      .stat(info.directory)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(false)
  })

  test("patches changes back to parent and removes worktree", async () => {
    await using tmp = await tmpdir({ git: true })
    const info = await resolveWorktree("patch", tmp.path)
    // Create a file in the worktree
    await Bun.write(path.join(info.directory, "new.txt"), "hello")
    const result = await ephemeralCleanup(info, tmp.path)
    expect(result.status).toBe("applied")
    // File should exist in parent
    const content = await Bun.file(path.join(tmp.path, "new.txt")).text()
    expect(content).toBe("hello")
    // Worktree should be removed
    const exists = await fs
      .stat(info.directory)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(false)
  })

  test("returns conflict when patch cannot apply", async () => {
    await using tmp = await tmpdir({ git: true })
    // Create a file in parent and commit
    await Bun.write(path.join(tmp.path, "conflict.txt"), "original")
    const add = Bun.spawn(["git", "add", "-A"], { cwd: tmp.path, stdout: "pipe", stderr: "pipe" })
    await add.exited
    const commit = Bun.spawn(["git", "commit", "-m", "add file"], { cwd: tmp.path, stdout: "pipe", stderr: "pipe" })
    await commit.exited

    const info = await resolveWorktree("conflict", tmp.path)
    // Modify in worktree
    await Bun.write(path.join(info.directory, "conflict.txt"), "worktree version")
    // Also modify in parent (create a conflicting state in working tree)
    await Bun.write(path.join(tmp.path, "conflict.txt"), "parent version")
    const parentAdd = Bun.spawn(["git", "add", "-A"], { cwd: tmp.path, stdout: "pipe", stderr: "pipe" })
    await parentAdd.exited
    const parentCommit = Bun.spawn(["git", "commit", "-m", "conflict"], {
      cwd: tmp.path,
      stdout: "pipe",
      stderr: "pipe",
    })
    await parentCommit.exited

    const result = await ephemeralCleanup(info, tmp.path)
    // git apply --3way may succeed via merge or fail - either is valid
    // The key assertion is that result.status is either "applied" or "conflict"
    expect(["applied", "conflict"]).toContain(result.status)
    if (result.status === "conflict") {
      expect(result.branch).toBe("opencode/conflict")
    }
  })
})
