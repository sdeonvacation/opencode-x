import { describe, expect, test } from "bun:test"
import { extractJson, JsonParseError, mapLimit } from "../../src/plugin/insights/llm"

describe("extractJson", () => {
  test("extracts JSON from plain text", () => {
    const result = extractJson('Here is the result: {"foo": "bar", "num": 42}')
    expect(result).toEqual({ foo: "bar", num: 42 })
  })

  test("extracts JSON wrapped in markdown code fences", () => {
    const text = '```json\n{"key": "value"}\n```'
    expect(extractJson(text)).toEqual({ key: "value" })
  })

  test("extracts JSON with surrounding prose", () => {
    const text = 'Some preamble text\n{"a": 1, "b": [2, 3]}\nSome trailing text'
    expect(extractJson(text)).toEqual({ a: 1, b: [2, 3] })
  })

  test("handles nested objects", () => {
    const text = '{"outer": {"inner": true}}'
    expect(extractJson(text)).toEqual({ outer: { inner: true } })
  })

  test("throws JsonParseError when no braces found", () => {
    expect(() => extractJson("no json here")).toThrow(JsonParseError)
  })

  test("throws JsonParseError for invalid JSON", () => {
    expect(() => extractJson("{not valid json}")).toThrow(JsonParseError)
  })

  test("JsonParseError includes raw field", () => {
    try {
      extractJson("{broken: true}")
      expect.unreachable("should throw")
    } catch (e) {
      expect(e).toBeInstanceOf(JsonParseError)
      expect((e as JsonParseError).raw).toBe("{broken: true}")
    }
  })

  test("strips code fence with language specifier", () => {
    const text = '```\n{"x": 1}\n```'
    expect(extractJson(text)).toEqual({ x: 1 })
  })

  test("throws when only opening brace", () => {
    expect(() => extractJson("{ no close")).toThrow(JsonParseError)
  })

  test("handles multiple objects - takes outermost braces", () => {
    const text = '{"a": 1} extra {"b": 2}'
    // first { to last } includes everything
    expect(() => extractJson(text)).not.toThrow()
  })
})

describe("mapLimit", () => {
  test("processes all items", async () => {
    const items = [1, 2, 3, 4, 5]
    const results = await mapLimit(items, 3, async (item) => item * 2)
    expect(results).toEqual([2, 4, 6, 8, 10])
  })

  test("respects concurrency limit", async () => {
    let concurrent = 0
    let maxConcurrent = 0
    const items = [1, 2, 3, 4, 5, 6]

    await mapLimit(items, 2, async (item) => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await new Promise((r) => setTimeout(r, 10))
      concurrent--
      return item
    })

    expect(maxConcurrent).toBeLessThanOrEqual(2)
  })

  test("preserves order", async () => {
    const items = [30, 10, 20]
    const results = await mapLimit(items, 3, async (item) => {
      await new Promise((r) => setTimeout(r, item))
      return item
    })
    expect(results).toEqual([30, 10, 20])
  })

  test("passes index to callback", async () => {
    const items = ["a", "b", "c"]
    const indices: number[] = []
    await mapLimit(items, 2, async (_, idx) => {
      indices.push(idx)
    })
    expect(indices.sort()).toEqual([0, 1, 2])
  })

  test("handles empty array", async () => {
    const results = await mapLimit([], 5, async (item: number) => item)
    expect(results).toEqual([])
  })

  test("handles limit greater than items", async () => {
    const items = [1, 2]
    const results = await mapLimit(items, 10, async (item) => item + 1)
    expect(results).toEqual([2, 3])
  })

  test("propagates errors", async () => {
    const items = [1, 2, 3]
    const promise = mapLimit(items, 2, async (item) => {
      if (item === 2) throw new Error("boom")
      return item
    })
    expect(promise).rejects.toThrow("boom")
  })
})
