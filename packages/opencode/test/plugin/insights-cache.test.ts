import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { FacetCache, FACET_CACHE_VERSION } from "../../src/plugin/insights/cache"
import type { SessionFacet } from "../../src/plugin/insights/types"

const makeFacet = (sessionId: string): SessionFacet => ({
  sessionId,
  underlyingGoal: "test goal",
  goalCategories: { implement_feature: 0.9 },
  outcome: "success",
  satisfaction: { happy: 0.8 },
  frictionCounts: {},
  frictionDetail: "",
  primarySuccess: "did the thing",
  briefSummary: "summary",
})

describe("FacetCache", () => {
  test("FACET_CACHE_VERSION is v2", () => {
    expect(FACET_CACHE_VERSION).toBe("v2")
  })

  test("constructor creates directory", async () => {
    await using tmp = await tmpdir()
    const cacheDir = path.join(tmp.path, "cache")
    new FacetCache(cacheDir)
    expect(existsSync(cacheDir)).toBe(true)
  })

  test("constructor handles existing directory", async () => {
    await using tmp = await tmpdir()
    const cacheDir = path.join(tmp.path, "cache")
    mkdirSync(cacheDir, { recursive: true })
    const cache = new FacetCache(cacheDir)
    expect(cache.dir).toBe(cacheDir)
  })

  test("has returns false for missing entry", async () => {
    await using tmp = await tmpdir()
    const cache = new FacetCache(path.join(tmp.path, "cache"))
    expect(cache.has("nonexistent")).toBe(false)
  })

  test("has returns true after put", async () => {
    await using tmp = await tmpdir()
    const cache = new FacetCache(path.join(tmp.path, "cache"))
    cache.put("sess1", makeFacet("sess1"))
    expect(cache.has("sess1")).toBe(true)
  })

  test("get returns null for missing entry", async () => {
    await using tmp = await tmpdir()
    const cache = new FacetCache(path.join(tmp.path, "cache"))
    expect(cache.get("nonexistent")).toBeNull()
  })

  test("get returns stored facet", async () => {
    await using tmp = await tmpdir()
    const cache = new FacetCache(path.join(tmp.path, "cache"))
    const facet = makeFacet("sess2")
    cache.put("sess2", facet)
    expect(cache.get("sess2")).toEqual(facet)
  })

  test("get returns null for corrupted JSON", async () => {
    await using tmp = await tmpdir()
    const cacheDir = path.join(tmp.path, "cache")
    const cache = new FacetCache(cacheDir)
    writeFileSync(path.join(cacheDir, "bad.json"), "not json")
    expect(cache.get("bad")).toBeNull()
  })

  test("put uses atomic write (no .tmp left)", async () => {
    await using tmp = await tmpdir()
    const cacheDir = path.join(tmp.path, "cache")
    const cache = new FacetCache(cacheDir)
    cache.put("sess3", makeFacet("sess3"))
    expect(existsSync(path.join(cacheDir, "sess3.json.tmp"))).toBe(false)
    expect(existsSync(path.join(cacheDir, "sess3.json"))).toBe(true)
  })

  test("put overwrites existing entry", async () => {
    await using tmp = await tmpdir()
    const cache = new FacetCache(path.join(tmp.path, "cache"))
    cache.put("sess4", makeFacet("sess4"))
    const updated = { ...makeFacet("sess4"), outcome: "partial" }
    cache.put("sess4", updated)
    expect(cache.get("sess4")!.outcome).toBe("partial")
  })

  test("clear removes all json and tmp files", async () => {
    await using tmp = await tmpdir()
    const cacheDir = path.join(tmp.path, "cache")
    const cache = new FacetCache(cacheDir)
    cache.put("a", makeFacet("a"))
    cache.put("b", makeFacet("b"))
    writeFileSync(path.join(cacheDir, "orphan.json.tmp"), "tmp")
    writeFileSync(path.join(cacheDir, "keep.txt"), "not cleared")
    cache.clear()
    expect(cache.has("a")).toBe(false)
    expect(cache.has("b")).toBe(false)
    expect(existsSync(path.join(cacheDir, "orphan.json.tmp"))).toBe(false)
    expect(existsSync(path.join(cacheDir, "keep.txt"))).toBe(true)
  })

  test("clear on empty dir does not throw", async () => {
    await using tmp = await tmpdir()
    const cache = new FacetCache(path.join(tmp.path, "cache"))
    expect(() => cache.clear()).not.toThrow()
  })

  test("stored data is pretty-printed JSON", async () => {
    await using tmp = await tmpdir()
    const cacheDir = path.join(tmp.path, "cache")
    const cache = new FacetCache(cacheDir)
    const facet = makeFacet("pretty")
    cache.put("pretty", facet)
    const raw = readFileSync(path.join(cacheDir, "pretty.json"), "utf-8")
    expect(raw).toBe(JSON.stringify(facet, null, 2))
  })
})
