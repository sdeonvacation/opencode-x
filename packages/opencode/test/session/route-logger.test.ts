import { afterEach, describe, expect, mock, test } from "bun:test"
import fs from "fs/promises"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { RouteDecided, log } from "../../src/session/route-logger"
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
        const hit = deferred<{ type: string; properties: { route: string; reason: string } }>()
        const unsub = Bus.subscribe(RouteDecided, (event) => hit.resolve(event))
        try {
          await log(
            {
              sessionID: "session-1",
              step: 2,
              route: "cloud",
              reason: "reasoning",
              modelID: "gpt-5.2",
              providerID: "openai",
            },
            Config.Info.parse({ hybrid: { enabled: true, log_routing: false } }),
          )
          const event = await hit.promise
          const text = await waitLog((text) => text.length > 0)
          expect(event.properties.route).toBe("cloud")
          expect(event.properties.reason).toBe("reasoning")
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
        const hit = deferred<{ type: string; properties: { route: string; tool?: string } }>()
        const unsub = Bus.subscribe(RouteDecided, (event) => hit.resolve(event))
        try {
          await log(
            {
              sessionID: "session-2",
              step: 3,
              route: "local",
              reason: "local_only",
              tool: "grep",
              modelID: "llama3.2:8b",
              providerID: "openai-compatible",
            },
            Config.Info.parse({ hybrid: { enabled: true, log_routing: true } }),
          )
          const event = await hit.promise
          const text = await waitLog((text) => text.includes("service=hybrid"))
          expect(event.properties.route).toBe("local")
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
