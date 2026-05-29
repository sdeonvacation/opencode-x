import { test, expect, describe } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { matchAny, parsePaths } from "../../src/skill/paths"
import { tmpdir } from "../fixture/fixture"

describe("parsePaths", () => {
  test("undefined input returns undefined", () => {
    expect(parsePaths(undefined)).toBeUndefined()
  })

  test("null input returns undefined", () => {
    expect(parsePaths(null)).toBeUndefined()
  })

  test("match-all '**' returns undefined", () => {
    expect(parsePaths("**")).toBeUndefined()
  })

  test("string with trailing /** strips suffix", () => {
    expect(parsePaths("src/**")).toEqual(["src"])
  })

  test("array preserves entries and strips /**", () => {
    expect(parsePaths(["src/**", "**/*.ts"])).toEqual(["src", "**/*.ts"])
  })

  test("string with semicolons splits into array", () => {
    expect(parsePaths("src/**;tests/**")).toEqual(["src", "tests"])
  })

  test("empty entries skipped", () => {
    expect(parsePaths(["", "src/**", "  "])).toEqual(["src"])
  })

  test("non-string non-array returns undefined", () => {
    expect(parsePaths(42)).toBeUndefined()
  })

  test("array of only match-all returns undefined", () => {
    expect(parsePaths(["**"])).toBeUndefined()
  })

  test("empty array returns undefined", () => {
    expect(parsePaths([])).toBeUndefined()
  })

  test("traversal '../etc' rejected", () => {
    expect(parsePaths(["../etc"])).toBeUndefined()
  })

  test("absolute path rejected", () => {
    expect(parsePaths(["/etc/passwd"])).toBeUndefined()
  })

  test("interior '..' rejected", () => {
    expect(parsePaths(["src/../node_modules"])).toBeUndefined()
  })

  test("mix keeps safe and drops unsafe", () => {
    expect(parsePaths(["src/**", "../bad", "lib/**"])).toEqual(["src", "lib"])
  })
})

describe("matchAny", () => {
  test("matches when file exists", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "foo.py"), "x")
        await Bun.write(path.join(dir, "bar.ts"), "y")
      },
    })
    expect(await matchAny(["**/*.py"], tmp.path)).toBe(true)
  })

  test("no match when no file matches", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "foo.py"), "x")
      },
    })
    expect(await matchAny(["**/*.rs"], tmp.path)).toBe(false)
  })

  test("returns true on first matching pattern", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "bar.ts"), "y")
      },
    })
    expect(await matchAny(["**/*.rs", "**/*.ts"], tmp.path)).toBe(true)
  })

  test("nested directory match", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const sub = path.join(dir, "src", "deep")
        await fs.mkdir(sub, { recursive: true })
        await Bun.write(path.join(sub, "x.py"), "x")
      },
    })
    expect(await matchAny(["src"], tmp.path)).toBe(false)
    expect(await matchAny(["**/*.py"], tmp.path)).toBe(true)
  })
})
