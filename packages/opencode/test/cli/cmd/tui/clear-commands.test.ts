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
      summarize: mock(
        async (_input: { sessionID: string; providerID: string; modelID: string; auto: boolean }) => undefined,
      ),
    }

    const deps: ClearCommandsDeps = {
      sdk: { client: { session: api } },
      sync: { session: { sync: syncSession } },
      kv: { get, set },
      toast: { show },
      route: { data: { type: "session", sessionID: "ses_1" } },
      local: { model: { current: () => undefined } },
    }
    const [clear] = createClearCommands(deps)

    await clear.onSelect!(dialog)

    expect(setCalls).toContainEqual(["cleared_cost_ses_1", 9])
    expect(api.deleteMessage).toHaveBeenCalledTimes(3)
    expect(syncSession).toHaveBeenCalledWith("ses_1", { force: true })
    expect(show).toHaveBeenCalledWith({ variant: "info", message: "Cleared 3 message(s)" })
  })

  test("compact command requires a selected model", async () => {
    const show = mock((_opts: unknown) => {})
    const api: ClearCommandsDeps["sdk"]["client"]["session"] = {
      messages: mock(async (_input: { sessionID: string }) => ({
        data: [{ info: { id: "m1", role: "user", cost: 0 } }],
      })),
      deleteMessage: mock(async (_input: { sessionID: string; messageID: string }) => undefined),
      summarize: mock(
        async (_input: { sessionID: string; providerID: string; modelID: string; auto: boolean }) => undefined,
      ),
    }

    const deps: ClearCommandsDeps = {
      sdk: { client: { session: api } },
      sync: { session: { async sync() {} } },
      kv: {
        get: createGet(0),
        set<T>(_key: string, _value: T) {},
      },
      toast: { show },
      route: { data: { type: "session", sessionID: "ses_1" } },
      local: { model: { current: () => undefined } },
    }
    const [, compact] = createClearCommands(deps)

    await compact.onSelect!(dialog)

    expect(api.summarize).not.toHaveBeenCalled()
    expect(show).toHaveBeenCalledWith({
      variant: "error",
      message: "No model selected. Please select a model first.",
    })
  })
})
