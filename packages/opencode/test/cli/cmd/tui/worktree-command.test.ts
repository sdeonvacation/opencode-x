import { afterEach, describe, expect, mock, test } from "bun:test"
import { type WorktreeCommandDeps, createWorktreeCommand } from "../../../../src/cli/cmd/tui/command/worktree-command"
import type { DialogContext } from "../../../../src/cli/cmd/tui/ui/dialog"

function makeDeps(overrides?: Partial<WorktreeCommandDeps>): WorktreeCommandDeps {
  return {
    dialog: { clear: mock(() => {}), replace: mock((_view?: unknown, _onClose?: unknown) => {}) },
    sdk: {
      client: {
        worktree: {
          create: mock(async () => ({ data: { name: "feat", branch: "feat", directory: "/tmp/wt/feat" } })),
          list: mock(async () => ({ data: ["/tmp/wt/a", "/tmp/wt/b"] })),
          remove: mock(async () => ({ data: true })),
        },
        project: { current: mock(async () => ({})) },
      },
      changeDirectory: mock(async () => {}),
    },
    toast: { show: mock(() => {}) },
    sync: { path: { worktree: "/project", directory: "/tmp/wt/a" } },
    ...overrides,
  }
}

describe("createWorktreeCommand", () => {
  afterEach(() => {
    mock.restore()
  })

  test("returns correct command metadata", () => {
    const cmd = createWorktreeCommand(makeDeps())
    expect(cmd.title).toBe("Worktree")
    expect(cmd.value).toBe("worktree.manage")
    expect(cmd.slash).toEqual({ name: "worktree", aliases: ["wt"] })
    expect(cmd.category).toBe("System")
  })

  test("onSelect opens sub-action dialog", async () => {
    const d = makeDeps()
    const cmd = createWorktreeCommand(d)
    const dialog = {
      clear: d.dialog.clear,
      replace: d.dialog.replace,
      stack: [],
      size: "medium",
      setSize() {},
    } as DialogContext
    await cmd.onSelect!(dialog)
    expect(d.dialog.replace).toHaveBeenCalledTimes(1)
  })
})
