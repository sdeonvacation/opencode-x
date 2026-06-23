import { afterEach, describe, expect, mock, test } from "bun:test"
import { type ClearCommandsDeps, createClearCommands } from "../../../../src/cli/cmd/tui/command/clear-commands"
import type { DialogContext } from "../../../../src/cli/cmd/tui/ui/dialog"

describe("createClearCommands", () => {
  afterEach(() => {
    mock.restore()
  })

  function createGet(value: number): ClearCommandsDeps["kv"]["get"] {
    function get<T>(_key: string): T | undefined
    function get<T>(_key: string, defaultValue: T): T
    function get<T>(_key: string, defaultValue?: T) {
      return (value as T | undefined) ?? defaultValue
    }

    return get
  }

  const dialog = { clear() {} } as DialogContext

  test("clear command preserves assistant cost and deletes messages", async () => {
    const messages = [
      { info: { id: "m1", role: "assistant", cost: 2 } },
      { info: { id: "m2", role: "user", cost: 0 } },
      { info: { id: "m3", role: "assistant", cost: 3 } },
    ]
    const get = createGet(4)
    const setCalls: Array<[string, number]> = []
    function set<T>(key: string, value: T) {
      setCalls.push([key, value as number])
    }
    const show = mock((_opts: unknown) => {})
    const syncSession = mock(async (_sessionID: string, _opts: { force: boolean }) => {})
    const api: ClearCommandsDeps["sdk"]["client"]["session"] = {
      messages: mock(async (_input: { sessionID: string }) => ({ data: messages })),
      deleteMessage: mock(async (_input: { sessionID: string; messageID: string }) => undefined),
      clearTodo: mock(async (_input: { sessionID: string }) => undefined),
      delete: mock(async (_input: { sessionID: string }) => undefined),
      children: mock(async (_input: { sessionID: string }) => ({ data: [] })),
    }

    const deps: ClearCommandsDeps = {
      sdk: { client: { session: api } },
      sync: { session: { sync: syncSession } },
      kv: { get, set },
      toast: { show },
      route: { data: { type: "session", sessionID: "ses_1" } },
    }
    const [clear] = createClearCommands(deps)

    await clear.onSelect!(dialog)

    expect(setCalls).toContainEqual(["cleared_cost_ses_1", 9])
    expect(api.deleteMessage).toHaveBeenCalledTimes(3)
    expect(api.clearTodo).toHaveBeenCalledWith({ sessionID: "ses_1" })
    expect(syncSession).toHaveBeenCalledWith("ses_1", { force: true })
    expect(show).toHaveBeenCalledWith({ variant: "info", message: "Cleared 3 message(s)" })
  })

  test("clear command shows info toast when no messages", async () => {
    const show = mock((_opts: unknown) => {})
    const api: ClearCommandsDeps["sdk"]["client"]["session"] = {
      messages: mock(async (_input: { sessionID: string }) => ({ data: [] })),
      deleteMessage: mock(async (_input: { sessionID: string; messageID: string }) => undefined),
      clearTodo: mock(async (_input: { sessionID: string }) => undefined),
      delete: mock(async (_input: { sessionID: string }) => undefined),
      children: mock(async (_input: { sessionID: string }) => ({ data: [] })),
    }

    const deps: ClearCommandsDeps = {
      sdk: { client: { session: api } },
      sync: { session: { async sync() {} } },
      kv: { get: createGet(0), set<T>(_key: string, _value: T) {} },
      toast: { show },
      route: { data: { type: "session", sessionID: "ses_1" } },
    }
    const [clear] = createClearCommands(deps)

    await clear.onSelect!(dialog)

    expect(api.deleteMessage).not.toHaveBeenCalled()
    expect(show).toHaveBeenCalledWith({ variant: "info", message: "No messages to clear" })
  })

  test("clear command does nothing when not on session route", async () => {
    const show = mock((_opts: unknown) => {})
    const deleteMessage = mock(async (_input: { sessionID: string; messageID: string }) => undefined)
    const api: ClearCommandsDeps["sdk"]["client"]["session"] = {
      messages: mock(async (_input: { sessionID: string }) => ({ data: [{ info: { id: "m1", role: "user" } }] })),
      deleteMessage,
      clearTodo: mock(async (_input: { sessionID: string }) => undefined),
      delete: mock(async (_input: { sessionID: string }) => undefined),
      children: mock(async (_input: { sessionID: string }) => ({ data: [] })),
    }

    const deps: ClearCommandsDeps = {
      sdk: { client: { session: api } },
      sync: { session: { async sync() {} } },
      kv: { get: createGet(0), set<T>(_key: string, _value: T) {} },
      toast: { show },
      route: { data: { type: "home" } },
    }
    const [clear] = createClearCommands(deps)

    await clear.onSelect!(dialog)

    expect(deleteMessage).not.toHaveBeenCalled()
  })
})
