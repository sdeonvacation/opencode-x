import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Clipboard } from "../../../../src/cli/cmd/tui/util/clipboard"
import { type CopyHandlerDeps, setupConsoleCopyHandler } from "../../../../src/cli/cmd/tui/util/copy-handler"

describe("setupConsoleCopyHandler", () => {
  afterEach(() => {
    mock.restore()
  })

  test("copies non-empty text and clears selection", async () => {
    const copy = spyOn(Clipboard, "copy").mockImplementation(async () => {})
    const show = mock((_opts: unknown) => {})
    const error = mock((_err: unknown) => {})
    const clearSelection = mock(() => {})
    const deps: CopyHandlerDeps = {
      renderer: {
        console: {},
        getSelection: () => null,
        clearSelection,
      },
      toast: { show, error },
    }

    setupConsoleCopyHandler(deps)

    await deps.renderer.console.onCopySelection?.("hello")

    expect(copy).toHaveBeenCalledWith("hello")
    expect(show).toHaveBeenCalledWith({ message: "Copied to clipboard", variant: "info" })
    expect(error).not.toHaveBeenCalled()
    expect(clearSelection).toHaveBeenCalledTimes(1)
  })

  test("ignores empty text", async () => {
    const copy = spyOn(Clipboard, "copy").mockImplementation(async () => {})
    const show = mock((_opts: unknown) => {})
    const clearSelection = mock(() => {})
    const deps: CopyHandlerDeps = {
      renderer: {
        console: {},
        getSelection: () => null,
        clearSelection,
      },
      toast: { show, error() {} },
    }

    setupConsoleCopyHandler(deps)

    await deps.renderer.console.onCopySelection?.("")

    expect(copy).not.toHaveBeenCalled()
    expect(show).not.toHaveBeenCalled()
    expect(clearSelection).not.toHaveBeenCalled()
  })
})
