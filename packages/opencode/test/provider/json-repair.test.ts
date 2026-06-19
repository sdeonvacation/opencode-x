import { describe, expect, test } from "bun:test"
import { JsonRepair } from "../../src/provider/json-repair"

describe("JsonRepair.repair", () => {
  test("returns undefined for empty input", () => {
    expect(JsonRepair.repair("")).toBeUndefined()
  })

  test("returns undefined for null-ish input", () => {
    expect(JsonRepair.repair("")).toBeUndefined()
  })

  test("returns valid JSON unchanged", () => {
    const input = '{"name":"bash","command":"ls"}'
    expect(JsonRepair.repair(input)).toBe(input)
  })

  test("closes unclosed object", () => {
    const input = '{"name":"bash","command":"ls"'
    const result = JsonRepair.repair(input)
    expect(result).toBeDefined()
    expect(JSON.parse(result!)).toEqual({ name: "bash", command: "ls" })
  })

  test("closes unclosed array", () => {
    const input = '["a","b","c"'
    const result = JsonRepair.repair(input)
    expect(result).toBeDefined()
    expect(JSON.parse(result!)).toEqual(["a", "b", "c"])
  })

  test("closes nested unclosed containers", () => {
    const input = '{"items":[1,2,3'
    const result = JsonRepair.repair(input)
    expect(result).toBeDefined()
    const parsed = JSON.parse(result!)
    expect(parsed.items).toEqual([1, 2, 3])
  })

  test("closes unclosed string", () => {
    const input = '{"name":"bash'
    const result = JsonRepair.repair(input)
    expect(result).toBeDefined()
    expect(JSON.parse(result!)).toEqual({ name: "bash" })
  })

  test("strips trailing comma before closing object", () => {
    const input = '{"a":1,"b":2,'
    const result = JsonRepair.repair(input)
    expect(result).toBeDefined()
    expect(JSON.parse(result!)).toEqual({ a: 1, b: 2 })
  })

  test("strips trailing comma before closing array", () => {
    const input = "[1,2,3,"
    const result = JsonRepair.repair(input)
    expect(result).toBeDefined()
    expect(JSON.parse(result!)).toEqual([1, 2, 3])
  })

  test("strips trailing comma inside existing closer", () => {
    const input = '{"a":1,"b":2,}'
    const result = JsonRepair.repair(input)
    expect(result).toBeDefined()
    expect(JSON.parse(result!)).toEqual({ a: 1, b: 2 })
  })

  test("fixes truncated decimal number", () => {
    const input = '{"value":3.'
    const result = JsonRepair.repair(input)
    expect(result).toBeDefined()
    expect(JSON.parse(result!).value).toBe(3.0)
  })

  test("strips null bytes", () => {
    const input = '{"a":\x001}\x00'
    const result = JsonRepair.repair(input)
    expect(result).toBeDefined()
    expect(JSON.parse(result!)).toEqual({ a: 1 })
  })

  test("strips control characters", () => {
    const input = '{"a":\x02"hello"\x03}'
    const result = JsonRepair.repair(input)
    expect(result).toBeDefined()
    expect(JSON.parse(result!)).toEqual({ a: "hello" })
  })

  test("preserves tabs and newlines", () => {
    const input = '{\n\t"a": 1\n}'
    const result = JsonRepair.repair(input)
    expect(result).toBeDefined()
    expect(JSON.parse(result!)).toEqual({ a: 1 })
  })

  test("handles escaped quotes in strings", () => {
    const input = '{"path":"C:\\\\Users\\\\test"'
    const result = JsonRepair.repair(input)
    expect(result).toBeDefined()
    expect(JSON.parse(result!).path).toBe("C:\\Users\\test")
  })

  test("handles deeply nested truncation", () => {
    const input = '{"a":{"b":{"c":[1,2'
    const result = JsonRepair.repair(input)
    expect(result).toBeDefined()
    const parsed = JSON.parse(result!)
    expect(parsed.a.b.c).toEqual([1, 2])
  })

  test("returns undefined for completely unrecoverable input", () => {
    const result = JsonRepair.repair("not json at all")
    expect(result).toBeUndefined()
  })

  test("handles real-world truncated tool call args", () => {
    const input = '{"command":"git log --oneline -10","description":"Show recent commits'
    const result = JsonRepair.repair(input)
    expect(result).toBeDefined()
    const parsed = JSON.parse(result!)
    expect(parsed.command).toBe("git log --oneline -10")
    expect(parsed.description).toBe("Show recent commits")
  })
})

describe("JsonRepair.isRepairable", () => {
  test("returns false for empty input", () => {
    expect(JsonRepair.isRepairable("", "some error")).toBe(false)
  })

  test("returns true for unexpected end error", () => {
    expect(JsonRepair.isRepairable("{", "Unexpected end of JSON input")).toBe(true)
  })

  test("returns true for unterminated error", () => {
    expect(JsonRepair.isRepairable('{"a":', "Unterminated string")).toBe(true)
  })

  test("returns true for expected token error", () => {
    expect(JsonRepair.isRepairable("{", "Expected property name")).toBe(true)
  })

  test("returns true for json keyword in error", () => {
    expect(JsonRepair.isRepairable("{", "JSON parse failed")).toBe(true)
  })

  test("returns true for parse keyword in error", () => {
    expect(JsonRepair.isRepairable("{", "Failed to parse arguments")).toBe(true)
  })

  test("returns true for invalid keyword in error", () => {
    expect(JsonRepair.isRepairable("{", "Invalid JSON")).toBe(true)
  })

  test("returns true for JSON-like input with generic error", () => {
    expect(JsonRepair.isRepairable('{"key":"value"', "something went wrong")).toBe(true)
  })

  test("returns true for array-like input with generic error", () => {
    expect(JsonRepair.isRepairable("[1,2,3", "something went wrong")).toBe(true)
  })

  test("returns false for non-JSON input with non-matching error", () => {
    expect(JsonRepair.isRepairable("hello world", "tool not found")).toBe(false)
  })
})
