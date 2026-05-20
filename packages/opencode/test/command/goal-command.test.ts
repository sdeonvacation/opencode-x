import { describe, expect, test } from "bun:test"
import { createGoalCommand } from "../../src/cli/cmd/tui/command/goal-command"

function deps(overrides?: Partial<Parameters<typeof createGoalCommand>[0]>) {
  let cleared = false
  let replaced = false
  let shown: { message: string; variant: string } | undefined
  const base = {
    dialog: {
      clear: () => {
        cleared = true
      },
      replace: () => {
        replaced = true
      },
      setSize: () => {},
    },
    sdk: {
      client: {
        session: {
          goal: async () => ({}),
        },
      },
    },
    toast: {
      show: (opts: any) => {
        shown = opts
      },
    },
    route: {
      data: { type: "session", sessionID: "sess-1" },
    },
    ...overrides,
  }
  return { base, state: () => ({ cleared, replaced, shown }) }
}

describe("createGoalCommand", () => {
  test("returns correct command option shape", () => {
    const { base } = deps()
    const cmd = createGoalCommand(base)

    expect(cmd.title).toBe("Set goal")
    expect(cmd.value).toBe("session.goal")
    expect(cmd.category).toBe("Session")
    expect(cmd.slash).toEqual({ name: "goal" })
  })

  test("onSelect opens dialog when on session route", () => {
    const { base, state } = deps()
    const cmd = createGoalCommand(base)

    cmd.onSelect?.({} as any)

    expect(state().replaced).toBe(true)
    expect(state().cleared).toBe(false)
  })

  test("onSelect shows warning when no active session", () => {
    const { base, state } = deps({
      route: { data: { type: "home" } },
    })
    const cmd = createGoalCommand(base)

    cmd.onSelect?.({} as any)

    expect(state().shown).toEqual({ message: "No active session", variant: "warning" })
    expect(state().cleared).toBe(true)
  })

  test("onSelect shows warning when sessionID missing", () => {
    const { base, state } = deps({
      route: { data: { type: "session" } },
    })
    const cmd = createGoalCommand(base)

    cmd.onSelect?.({} as any)

    expect(state().shown).toEqual({ message: "No active session", variant: "warning" })
    expect(state().cleared).toBe(true)
  })
})
