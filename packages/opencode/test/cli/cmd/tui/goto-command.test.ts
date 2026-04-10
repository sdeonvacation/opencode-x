import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { DialogPrompt } from "../../../../src/cli/cmd/tui/ui/dialog-prompt"
import { Filesystem } from "../../../../src/util/filesystem"
import { type GotoCommandDeps, createGotoCommand } from "../../../../src/cli/cmd/tui/command/goto-command"
import type { DialogContext } from "../../../../src/cli/cmd/tui/ui/dialog"

describe("createGotoCommand", () => {
  afterEach(() => {
    mock.restore()
  })

  test("shows error for invalid directory", async () => {
    const clear = mock(() => {})
    const replace = mock((_view?: unknown, _onClose?: unknown) => {})
    const show = mock((_opts: unknown) => {})
    const prompt = spyOn(DialogPrompt, "show").mockImplementation(async () => "/missing")
    const isDir = spyOn(Filesystem, "isDir").mockImplementation(async () => false)
    const changeDirectory = mock(async (_path: string) => {})

    const dialog = { clear, replace, stack: [], size: "medium", setSize() {} } as DialogContext
    const deps: GotoCommandDeps = {
      dialog,
      toast: { show },
      sdk: { changeDirectory },
      sync: { data: { path: { directory: "/cwd" } } },
    }
    const command = createGotoCommand(deps)

    await command.onSelect!(dialog)

    expect(prompt).toHaveBeenCalled()
    expect(isDir).toHaveBeenCalledWith("/missing")
    expect(changeDirectory).not.toHaveBeenCalled()
    expect(show).toHaveBeenCalledWith({ variant: "error", message: "Invalid directory: /missing" })
    expect(clear).toHaveBeenCalledTimes(1)
  })

  test("changes directory when path is valid", async () => {
    const clear = mock(() => {})
    const replace = mock((_view?: unknown, _onClose?: unknown) => {})
    const show = mock((_opts: unknown) => {})
    spyOn(DialogPrompt, "show").mockImplementation(async () => "~/work")
    spyOn(Filesystem, "isDir").mockImplementation(async () => true)
    const changeDirectory = mock(async (_path: string) => {})
    const home = process.env.HOME || ""

    const dialog = { clear, replace, stack: [], size: "medium", setSize() {} } as DialogContext
    const deps: GotoCommandDeps = {
      dialog,
      toast: { show },
      sdk: { changeDirectory },
      sync: { data: { path: { directory: "/cwd" } } },
    }
    const command = createGotoCommand(deps)

    await command.onSelect!(dialog)

    expect(changeDirectory).toHaveBeenCalledWith(`${home}/work`)
    expect(show).toHaveBeenCalledWith({ variant: "info", message: "Changed to ~/work" })
    expect(clear).toHaveBeenCalledTimes(1)
  })
})
