import { describe, expect, test, mock } from "bun:test"

mock.module("../../src/cli/cmd/tui/ui/dialog-prompt", () => ({
  DialogPrompt: {
    show: (dialog: { replace: (fn: unknown, onCancel?: unknown) => void }) =>
      new Promise<string | null>((resolve) => {
        dialog.replace(
          () => null,
          () => resolve(null),
        )
      }),
  },
}))

const { createLoopCommand } = await import("../../src/cli/cmd/tui/command/loop-command")

function createDeps(overrides?: Partial<Parameters<typeof createLoopCommand>[0]>) {
  let cleared = false
  let replaced = false
  let navigated: { type: string; sessionID: string } | undefined
  let shown: { message: string; variant: string } | undefined
  let fetchCalls: { url: string; opts?: RequestInit }[] = []

  const base = {
    dialog: {
      clear: () => {
        cleared = true
      },
      replace: (_fn: unknown) => {
        replaced = true
      },
    },
    sdk: {
      url: "http://localhost:3000",
      fetch: async (input: string | URL | Request, opts?: RequestInit) => {
        fetchCalls.push({ url: String(input), opts })
        return new Response(JSON.stringify([]), { status: 200 })
      },
    },
    toast: {
      show: (opts: { message: string; variant: string }) => {
        shown = opts
      },
    },
    route: {
      data: { type: "session", sessionID: "sess-1" } as { type: string; sessionID?: string },
      navigate: (route: { type: "session"; sessionID: string }) => {
        navigated = route
      },
    },
    ...overrides,
  }
  return {
    base,
    state: () => ({ cleared, replaced, shown, navigated, fetchCalls }),
  }
}

describe("createLoopCommand", () => {
  test("returns correct command option shape", () => {
    const { base } = createDeps()
    const cmd = createLoopCommand(base)

    expect(cmd.title).toBe("Loop")
    expect(cmd.value).toBe("session.loop")
    expect(cmd.category).toBe("Session")
    expect(cmd.keybind).toBe("loop_panel")
    expect(cmd.slash).toEqual({ name: "loop" })
  })

  test("onSelect shows warning when no active session", async () => {
    const { base, state } = createDeps({
      route: {
        data: { type: "home" },
        navigate: () => {},
      },
    })
    const cmd = createLoopCommand(base)

    await cmd.onSelect?.({} as never)

    expect(state().shown).toEqual({ message: "No active session", variant: "warning" })
    expect(state().cleared).toBe(true)
  })

  test("onSelect shows warning when sessionID missing", async () => {
    const { base, state } = createDeps({
      route: {
        data: { type: "session" },
        navigate: () => {},
      },
    })
    const cmd = createLoopCommand(base)

    await cmd.onSelect?.({} as never)

    expect(state().shown).toEqual({ message: "No active session", variant: "warning" })
    expect(state().cleared).toBe(true)
  })

  test("onSelect fetches loops and opens panel on session route", async () => {
    const { base, state } = createDeps()
    const cmd = createLoopCommand(base)

    await cmd.onSelect?.({} as never)

    expect(state().fetchCalls.length).toBe(1)
    expect(state().fetchCalls[0].url).toBe("http://localhost:3000/session/sess-1/loops")
    expect(state().replaced).toBe(true)
  })

  test("onSelect shows error toast when API fails", async () => {
    const { base, state } = createDeps({
      sdk: {
        url: "http://localhost:3000",
        fetch: async (_input: string | URL | Request, _init?: RequestInit) =>
          new Response(JSON.stringify({ error: "DB gone" }), { status: 500 }),
      },
    })
    const cmd = createLoopCommand(base)

    await cmd.onSelect?.({} as never)

    expect(state().shown?.variant).toBe("error")
    expect(state().shown?.message).toContain("DB gone")
    expect(state().cleared).toBe(true)
  })
})
