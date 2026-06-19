import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { WireDiagnostics } from "../../src/session/wire-diagnostics"
import { Global } from "../../src/global"
import type { Config } from "../../src/config/config"

describe("session.wire-diagnostics", () => {
  const dir = path.join(Global.Path.data, "wire-diagnostics")

  afterEach(async () => {
    // Clean up test artifacts
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  function cfg(enabled: boolean): Config.Info {
    return { experimental: { wire_diagnostics: enabled } } as unknown as Config.Info
  }

  function event(overrides?: Partial<WireDiagnostics.RequestEvent>): WireDiagnostics.RequestEvent {
    return {
      ts: Date.now(),
      sessionID: "sess-1",
      modelID: "gpt-4o",
      messages: { count: 3, byRole: { system: 1, user: 1, assistant: 1, tool: 0 }, totalBytes: 500 },
      tools: { count: 5, schemaBytes: 2048 },
      providerOptions: { bytes: 128 },
      response: {
        inputTokens: 1000,
        outputTokens: 200,
        cacheRead: 800,
        cacheWrite: 100,
        durationMs: 1500,
        toolCalls: 2,
      },
      ...overrides,
    }
  }

  test("enabled returns false when flag absent", () => {
    expect(WireDiagnostics.enabled({} as Config.Info)).toBe(false)
  })

  test("enabled returns false when flag is false", () => {
    expect(WireDiagnostics.enabled(cfg(false))).toBe(false)
  })

  test("enabled returns true when flag is true", () => {
    expect(WireDiagnostics.enabled(cfg(true))).toBe(true)
  })

  test("open returns undefined when disabled", () => {
    expect(WireDiagnostics.open("sess-1", cfg(false))).toBeUndefined()
  })

  test("open returns handle when enabled", () => {
    const handle = WireDiagnostics.open("sess-1", cfg(true))
    expect(handle).toBeDefined()
    handle!.close()
  })

  test("log writes JSONL to file", async () => {
    const handle = WireDiagnostics.open("sess-write", cfg(true))!
    const ev = event({ sessionID: "sess-write" })
    handle.log(ev)
    // Wait for async write
    await Bun.sleep(100)
    handle.close()

    const files = await fs.readdir(dir)
    const match = files.find((f) => f.startsWith("sess-write-"))
    expect(match).toBeDefined()

    const content = await fs.readFile(path.join(dir, match!), "utf8")
    const lines = content.trim().split("\n")
    expect(lines.length).toBe(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.sessionID).toBe("sess-write")
    expect(parsed.modelID).toBe("gpt-4o")
    expect(parsed.response.inputTokens).toBe(1000)
  })

  test("log appends multiple events", async () => {
    const handle = WireDiagnostics.open("sess-multi", cfg(true))!
    handle.log(event({ sessionID: "sess-multi", modelID: "model-a" }))
    handle.log(event({ sessionID: "sess-multi", modelID: "model-b" }))
    handle.log(event({ sessionID: "sess-multi", modelID: "model-c" }))
    await Bun.sleep(100)
    handle.close()

    const files = await fs.readdir(dir)
    const match = files.find((f) => f.startsWith("sess-multi-"))!
    const content = await fs.readFile(path.join(dir, match), "utf8")
    const lines = content.trim().split("\n")
    expect(lines.length).toBe(3)
    expect(JSON.parse(lines[0]).modelID).toBe("model-a")
    expect(JSON.parse(lines[1]).modelID).toBe("model-b")
    expect(JSON.parse(lines[2]).modelID).toBe("model-c")
  })

  test("close stops further writes", async () => {
    const handle = WireDiagnostics.open("sess-close", cfg(true))!
    handle.log(event({ sessionID: "sess-close", modelID: "before" }))
    await Bun.sleep(50)
    handle.close()
    handle.log(event({ sessionID: "sess-close", modelID: "after" }))
    await Bun.sleep(50)

    const files = await fs.readdir(dir)
    const match = files.find((f) => f.startsWith("sess-close-"))!
    const content = await fs.readFile(path.join(dir, match), "utf8")
    const lines = content.trim().split("\n")
    expect(lines.length).toBe(1)
    expect(JSON.parse(lines[0]).modelID).toBe("before")
  })

  test("no content fields in logged event (privacy)", async () => {
    const handle = WireDiagnostics.open("sess-priv", cfg(true))!
    handle.log(event({ sessionID: "sess-priv" }))
    await Bun.sleep(100)
    handle.close()

    const files = await fs.readdir(dir)
    const match = files.find((f) => f.startsWith("sess-priv-"))!
    const content = await fs.readFile(path.join(dir, match), "utf8")
    const parsed = JSON.parse(content.trim())
    // Ensure no content/text/prompt fields leak
    expect(parsed.content).toBeUndefined()
    expect(parsed.text).toBeUndefined()
    expect(parsed.prompt).toBeUndefined()
    // Only metrics
    expect(parsed.messages.count).toBeDefined()
    expect(parsed.messages.totalBytes).toBeDefined()
    expect(parsed.response.durationMs).toBeDefined()
  })

  test("file name format is sessionID-unixTs.jsonl", async () => {
    const before = Math.floor(Date.now() / 1000)
    const handle = WireDiagnostics.open("sess-name", cfg(true))!
    handle.log(event())
    await Bun.sleep(50)
    handle.close()
    const after = Math.floor(Date.now() / 1000)

    const files = await fs.readdir(dir)
    const match = files.find((f) => f.startsWith("sess-name-"))!
    expect(match).toMatch(/^sess-name-\d+\.jsonl$/)
    const ts = parseInt(match.replace("sess-name-", "").replace(".jsonl", ""))
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })
})
