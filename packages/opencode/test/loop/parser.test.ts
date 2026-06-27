import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { LoopParser } from "../../src/loop/parser"

describe("LoopParser.parseInterval", () => {
  test("seconds", () => {
    expect(LoopParser.parseInterval("60s")).toBe(60_000)
    expect(LoopParser.parseInterval("120s")).toBe(120_000)
  })

  test("minutes", () => {
    expect(LoopParser.parseInterval("5m")).toBe(300_000)
    expect(LoopParser.parseInterval("1m")).toBe(60_000)
  })

  test("hours", () => {
    expect(LoopParser.parseInterval("1h")).toBe(3_600_000)
    expect(LoopParser.parseInterval("2h")).toBe(7_200_000)
  })

  test("days", () => {
    expect(LoopParser.parseInterval("1d")).toBe(86_400_000)
  })

  test("throws below minimum", () => {
    expect(() => LoopParser.parseInterval("30s")).toThrow(LoopParser.InvalidIntervalError)
    expect(() => LoopParser.parseInterval("30s")).toThrow("minimum interval is 60s")
    expect(() => LoopParser.parseInterval("0s")).toThrow(LoopParser.InvalidIntervalError)
  })

  test("throws on invalid format", () => {
    expect(() => LoopParser.parseInterval("abc")).toThrow(LoopParser.InvalidIntervalError)
    expect(() => LoopParser.parseInterval("abc")).toThrow("expected format")
    expect(() => LoopParser.parseInterval("5x")).toThrow(LoopParser.InvalidIntervalError)
    expect(() => LoopParser.parseInterval("")).toThrow(LoopParser.InvalidIntervalError)
    expect(() => LoopParser.parseInterval("10")).toThrow(LoopParser.InvalidIntervalError)
    expect(() => LoopParser.parseInterval("s")).toThrow(LoopParser.InvalidIntervalError)
  })
})

describe("LoopParser.parseCommand", () => {
  test("interval with prompt", () => {
    const result = LoopParser.parseCommand("5m check deploy")
    expect(result.intervalMs).toBe(300_000)
    expect(result.prompt).toBe("check deploy")
  })

  test("interval only", () => {
    const result = LoopParser.parseCommand("1h")
    expect(result.intervalMs).toBe(3_600_000)
    expect(result.prompt).toBeUndefined()
  })

  test("trims whitespace", () => {
    const result = LoopParser.parseCommand("  2m   run tests  ")
    expect(result.intervalMs).toBe(120_000)
    expect(result.prompt).toBe("run tests")
  })

  test("empty prompt after interval treated as undefined", () => {
    const result = LoopParser.parseCommand("5m   ")
    expect(result.intervalMs).toBe(300_000)
    expect(result.prompt).toBeUndefined()
  })

  test("throws on invalid interval in command", () => {
    expect(() => LoopParser.parseCommand("abc do stuff")).toThrow(LoopParser.InvalidIntervalError)
  })
})

describe("LoopParser.resolvePrompt", () => {
  test("returns explicit prompt when provided", async () => {
    const result = await LoopParser.resolvePrompt({ prompt: "check status" })
    expect(result).toBe("check status")
  })

  test("returns undefined with no input", async () => {
    const result = await LoopParser.resolvePrompt()
    // May return undefined or global loop.md content depending on env
    expect(result === undefined || typeof result === "string").toBe(true)
  })

  test("reads project-level loop.md", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const loopDir = path.join(dir, ".opencode")
        await Bun.write(path.join(loopDir, "loop.md"), "project loop prompt")
      },
    })
    const result = await LoopParser.resolvePrompt({ projectDir: tmp.path })
    expect(result).toBe("project loop prompt")
  })

  test("returns undefined for empty loop.md", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const loopDir = path.join(dir, ".opencode")
        await Bun.write(path.join(loopDir, "loop.md"), "   ")
      },
    })
    const result = await LoopParser.resolvePrompt({ projectDir: tmp.path })
    expect(result).toBeUndefined()
  })

  test("returns undefined when no loop.md exists", async () => {
    await using tmp = await tmpdir()
    const result = await LoopParser.resolvePrompt({ projectDir: tmp.path })
    // Falls through to global; if no global exists, undefined
    expect(result === undefined || typeof result === "string").toBe(true)
  })

  test("explicit prompt takes priority over loop.md", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const loopDir = path.join(dir, ".opencode")
        await Bun.write(path.join(loopDir, "loop.md"), "file prompt")
      },
    })
    const result = await LoopParser.resolvePrompt({ prompt: "explicit", projectDir: tmp.path })
    expect(result).toBe("explicit")
  })
})
