import { afterEach, describe, expect, mock, test } from "bun:test"
import fs from "fs/promises"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { CompressionEligible, log } from "../../src/session/route-logger"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

function deferred<T>() {
  const result = {} as { promise: Promise<T>; resolve: (value: T) => void }
  result.promise = new Promise((resolve) => {
    result.resolve = resolve
  })
  return result
}

afterEach(() => {
  mock.restore()
})

async function waitLog(check: (text: string) => boolean) {
  for (let i = 0; i < 50; i++) {
    const file = Log.file()
    const text = file ? await fs.readFile(file, "utf8").catch(() => "") : ""
    if (check(text)) return text
    await Bun.sleep(10)
  }
  const file = Log.file()
  return file ? await fs.readFile(file, "utf8").catch(() => "") : ""
}

describe("session.route-logger", () => {
  test("emits events without structured logs when disabled", async () => {
    await using tmp = await tmpdir()
    await Log.init({ print: false, dev: true, level: "DEBUG" })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const hit = deferred<{ type: string; properties: { eligible: boolean; reason: string } }>()
        const unsub = Bus.subscribe(CompressionEligible, (event) => hit.resolve(event))
        try {
          await log(
            {
              sessionID: "session-1",
              step: 2,
              eligible: false,
              reason: "no_tool",
              modelID: "gpt-5.2",
              providerID: "openai",
            },
            Config.Info.parse({ hybrid: { enabled: true, log_routing: false } }),
          )
          const event = await hit.promise
          const text = await waitLog((text) => text.length > 0)
          expect(event.properties.eligible).toBe(false)
          expect(event.properties.reason).toBe("no_tool")
          expect(text.includes("service=hybrid")).toBe(false)
        } finally {
          unsub()
          await Log.init({ print: false, dev: true, level: "DEBUG" })
        }
      },
    })
  })

  test("emits events and structured logs when enabled", async () => {
    await using tmp = await tmpdir()
    await Log.init({ print: false, dev: true, level: "DEBUG" })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const hit = deferred<{ type: string; properties: { eligible: boolean; tool?: string } }>()
        const unsub = Bus.subscribe(CompressionEligible, (event) => hit.resolve(event))
        try {
          await log(
            {
              sessionID: "session-2",
              step: 3,
              eligible: true,
              reason: "grep_threshold",
              tool: "grep",
              modelID: "llama3.2:8b",
              providerID: "openai-compatible",
              lineCount: 150,
            },
            Config.Info.parse({ hybrid: { enabled: true, log_routing: true } }),
          )
          const event = await hit.promise
          const text = await waitLog((text) => text.includes("service=hybrid"))
          expect(event.properties.eligible).toBe(true)
          expect(event.properties.tool).toBe("grep")
          expect(text.includes("service=hybrid")).toBe(true)
        } finally {
          unsub()
          await Log.init({ print: false, dev: true, level: "DEBUG" })
        }
      },
    })
  })
})
