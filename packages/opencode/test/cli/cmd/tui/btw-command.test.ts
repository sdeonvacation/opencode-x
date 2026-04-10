import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { DialogPrompt } from "../../../../src/cli/cmd/tui/ui/dialog-prompt"
import { type BtwCommandDeps, createBtwCommand } from "../../../../src/cli/cmd/tui/command/btw-command"
import type { DialogContext } from "../../../../src/cli/cmd/tui/ui/dialog"

describe("createBtwCommand", () => {
  afterEach(() => {
    mock.restore()
  })

  test("opens provider dialog when no model and no providers", async () => {
    spyOn(DialogPrompt, "show").mockImplementation(async () => "quick question")
    const clear = mock(() => {})
    const replace = mock((_view?: unknown, _onClose?: unknown) => {})
    const show = mock((_opts: unknown) => {})

    const dialog = { clear, replace, stack: [], size: "medium", setSize() {} } as DialogContext
    const deps: BtwCommandDeps = {
      dialog,
      local: { model: { current: () => undefined } },
      toast: { show },
      sync: { data: { provider: [] } },
      sdk: {
        client: {
          session: {
            create: async () => ({ data: { id: "unused" } }),
            fork: async () => ({ data: { id: "unused" } }),
            promptAsync: async () => undefined,
            abort: async () => undefined,
            delete: async () => undefined,
          },
        },
      },
      route: { data: { type: "home" } },
    }
    const command = createBtwCommand(deps)

    await command.onSelect!(dialog)

    expect(show).toHaveBeenCalledWith({
      variant: "warning",
      message: "Connect a provider to send prompts",
      duration: 3000,
    })
    expect(replace).toHaveBeenCalledTimes(1)
    expect(clear).not.toHaveBeenCalled()
  })

  test("creates btw session and installs cleanup handlers", async () => {
    spyOn(DialogPrompt, "show").mockImplementation(async () => "what is up")
    const clear = mock(() => {})
    const replace = mock((_view?: unknown, _onClose?: unknown) => {})
    const create = mock(async () => ({ data: { id: "ses_btw" } }))
    const fork = mock(async (_input: { sessionID: string }) => ({ data: { id: "ses_btw" } }))
    const promptAsync = mock(
      async (_input: {
        sessionID: string
        contextSessionID?: string
        parts: { type: "text"; text: string }[]
        small?: boolean
      }) => undefined,
    )
    const abort = mock(async (_input: { sessionID: string }) => undefined)
    const del = mock(async (_input: { sessionID: string }) => undefined)

    const session: BtwCommandDeps["sdk"]["client"]["session"] = {
      create,
      fork,
      promptAsync,
      abort,
      delete: del,
    }

    const dialog = { clear, replace, stack: [], size: "medium", setSize() {} } as DialogContext
    const deps: BtwCommandDeps = {
      dialog,
      local: { model: { current: () => ({ providerID: "p", modelID: "m" }) } },
      toast: { show() {} },
      sync: { data: { provider: [{ id: "p" }] } },
      sdk: { client: { session } },
      route: { data: { type: "home" } },
    }
    const command = createBtwCommand(deps)

    await command.onSelect!(dialog)

    expect(create).toHaveBeenCalledTimes(1)
    expect(promptAsync).toHaveBeenCalledWith({
      sessionID: "ses_btw",
      parts: [
        {
          type: "text",
          text: "Answer the following question concisely, in plain text, without using any markdown formatting.\n\nwhat is up",
        },
      ],
      small: true,
    })
    expect(replace).toHaveBeenCalledTimes(1)

    const onClose = replace.mock.calls[0]?.[1]
    expect(typeof onClose).toBe("function")
    if (typeof onClose === "function") {
      await (onClose as () => void | Promise<void>)()
    }
    expect(abort).toHaveBeenCalledWith({ sessionID: "ses_btw" })
    expect(del).toHaveBeenCalledWith({ sessionID: "ses_btw" })
  })
})
