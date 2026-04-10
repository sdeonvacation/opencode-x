import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { DialogAlert } from "../../../../src/cli/cmd/tui/ui/dialog-alert"
import { DialogConfirm } from "../../../../src/cli/cmd/tui/ui/dialog-confirm"
import { TuiEvent } from "../../../../src/cli/cmd/tui/event"
import {
  type AppEventListenersDeps,
  setupAppEventListeners,
} from "../../../../src/cli/cmd/tui/effect/app-event-listeners"

describe("setupAppEventListeners", () => {
  afterEach(() => {
    mock.restore()
  })

  function createKV(value?: string): AppEventListenersDeps["kv"] {
    function get<T>(_key: string): T | undefined
    function get<T>(_key: string, defaultValue: T): T
    function get<T>(_key: string, defaultValue?: T) {
      return (value as T | undefined) ?? defaultValue
    }

    function set<T>(_key: string, _value: T) {}

    return {
      get,
      set,
    }
  }

  test("registers all listeners and cleanup unsubscribes them", () => {
    const off = Array.from({ length: 6 }, () => mock(() => {}))
    const all = [...off]
    const on: AppEventListenersDeps["sdk"]["event"]["on"] = (_type, _handler) => off.shift()!
    const kv = createKV()

    const result = setupAppEventListeners({
      sdk: {
        event: { on },
        client: {
          global: {
            async upgrade() {
              return { data: { success: true, version: "1.0.0" } }
            },
          },
        },
      },
      route: { data: { type: "home" }, navigate() {} },
      command: { trigger() {} },
      toast: { show() {} },
      dialog: {} as AppEventListenersDeps["dialog"],
      kv,
      exit: async () => {},
    })

    expect(off).toHaveLength(0)
    result.forEach((fn) => fn())
    for (const unsub of all) {
      expect(unsub).toHaveBeenCalledTimes(1)
    }
  })

  test("command and toast listeners forward payloads", () => {
    const handlers = new Map<string, (evt: unknown) => void>()
    const trigger = mock((_command: string) => {})
    const show = mock((_opts: unknown) => {})
    const kv = createKV()

    setupAppEventListeners({
      sdk: {
        event: {
          on(type, handler) {
            handlers.set(type, handler as (evt: unknown) => void)
            return () => {}
          },
        },
        client: {
          global: {
            async upgrade() {
              return { data: { success: true, version: "1.0.0" } }
            },
          },
        },
      },
      route: { data: { type: "home" }, navigate() {} },
      command: { trigger },
      toast: { show },
      dialog: {} as AppEventListenersDeps["dialog"],
      kv,
      exit: async () => {},
    })

    handlers.get(TuiEvent.CommandExecute.type)?.({ properties: { command: "session.list" } })
    handlers.get(TuiEvent.ToastShow.type)?.({
      properties: { title: "t", message: "m", variant: "info", duration: 123 },
    })

    expect(trigger).toHaveBeenCalledWith("session.list")
    expect(show).toHaveBeenCalledWith({ title: "t", message: "m", variant: "info", duration: 123 })
  })

  test("update listener skips or performs upgrade flows", async () => {
    const handlers = new Map<string, (evt: unknown) => Promise<void> | void>()
    const calls: Array<[string, string]> = []
    function set<T>(key: string, value: T) {
      calls.push([key, value as string])
    }
    const show = mock((_opts: unknown) => {})
    const upgrade = mock(async (_input: { target: string }) => ({ data: { success: true, version: "2.0.0" } }))
    const exit = mock(async () => {})
    const confirm = spyOn(DialogConfirm, "show")
    const alert = spyOn(DialogAlert, "show").mockImplementation(async () => {})
    const kv = {
      ...createKV(),
      set,
    }

    setupAppEventListeners({
      sdk: {
        event: {
          on(type, handler) {
            handlers.set(type, handler as (evt: unknown) => Promise<void> | void)
            return () => {}
          },
        },
        client: { global: { upgrade } },
      },
      route: { data: { type: "home" }, navigate() {} },
      command: { trigger() {} },
      toast: { show },
      dialog: {} as AppEventListenersDeps["dialog"],
      kv,
      exit,
    })

    confirm.mockImplementationOnce(async () => false)
    await handlers.get("installation.update-available")?.({ properties: { version: "2.0.0" } })
    expect(calls).toContainEqual(["skipped_version", "2.0.0"])
    expect(upgrade).not.toHaveBeenCalled()

    confirm.mockImplementationOnce(async () => true)
    await handlers.get("installation.update-available")?.({ properties: { version: "2.0.0" } })
    expect(show).toHaveBeenCalledWith({
      variant: "info",
      message: "Updating to v2.0.0...",
      duration: 30000,
    })
    expect(upgrade).toHaveBeenCalledWith({ target: "2.0.0" })
    expect(alert).toHaveBeenCalled()
    expect(exit).toHaveBeenCalledTimes(1)
  })
})
