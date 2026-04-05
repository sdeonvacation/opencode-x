import { describe, expect, test } from "bun:test"
import { Config } from "../../src/config/config"

describe("config parallel tool call fields", () => {
  test("accepts boolean and undefined values", () => {
    const parsed = Config.Info.parse({
      experimental: {
        parallel_tool_calls: true,
        parallel_read: false,
      },
    })
    expect(parsed.experimental?.parallel_tool_calls).toBe(true)
    expect(parsed.experimental?.parallel_read).toBe(false)

    const empty = Config.Info.parse({ experimental: {} })
    expect(empty.experimental?.parallel_tool_calls).toBeUndefined()
    expect(empty.experimental?.parallel_read).toBeUndefined()
  })

  test("accepts provider and agent parallel overrides", () => {
    const parsed = Config.Info.parse({
      agent: {
        parallel: {
          mode: "subagent",
          parallelToolCalls: true,
        },
      },
      provider: {
        openai: {
          parallelToolCalls: false,
        },
      },
    })

    expect(parsed.agent?.parallel?.parallelToolCalls).toBe(true)
    expect(parsed.provider?.openai?.parallelToolCalls).toBe(false)
  })

  test("rejects invalid values", () => {
    expect(() =>
      Config.Info.parse({
        experimental: {
          parallel_tool_calls: "yes",
        },
      }),
    ).toThrow()

    expect(() =>
      Config.Info.parse({
        experimental: {
          parallel_read: 1,
        },
      }),
    ).toThrow()

    expect(() =>
      Config.Info.parse({
        agent: {
          parallel: {
            parallelToolCalls: "yes",
          },
        },
      }),
    ).toThrow()

    expect(() =>
      Config.Info.parse({
        provider: {
          openai: {
            parallelToolCalls: "no",
          },
        },
      }),
    ).toThrow()
  })
})
