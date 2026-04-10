import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { useTerminalTitle } from "../../../../src/cli/cmd/tui/component/terminal-title"

describe("useTerminalTitle", () => {
  test("sets OpenCode title for home route", async () => {
    const calls: string[] = []

    await new Promise<void>((resolve) => {
      createRoot((dispose) => {
        const [enabled] = createSignal(true)
        const [route] = createStore({ type: "home" as const })
        useTerminalTitle({
          terminalTitleEnabled: enabled,
          route: { data: route },
          sync: {
            session: {
              get() {
                return undefined
              },
            },
          },
          renderer: {
            setTerminalTitle(value: string) {
              calls.push(value)
            },
          },
        })
        queueMicrotask(() => {
          dispose()
          resolve()
        })
      })
    })

    expect(calls).toContain("OpenCode")
  })

  test("preserves 40-char custom session titles", async () => {
    const calls: string[] = []

    await new Promise<void>((resolve) => {
      createRoot((dispose) => {
        const [enabled] = createSignal(true)
        const [route] = createStore({ type: "session" as const, sessionID: "ses_1" })
        useTerminalTitle({
          terminalTitleEnabled: enabled,
          route: { data: route },
          sync: {
            session: {
              get() {
                return { title: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN" }
              },
            },
          },
          renderer: {
            setTerminalTitle(value: string) {
              calls.push(value)
            },
          },
        })
        queueMicrotask(() => {
          dispose()
          resolve()
        })
      })
    })

    expect(calls.at(-1)).toBe("OC | abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN")
  })
})
