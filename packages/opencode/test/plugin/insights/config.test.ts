import { describe, expect, test } from "bun:test"
import { parseModel, dateStamp } from "../../../src/plugin/insights/config"

describe("parseModel", () => {
  test("returns DEFAULT_MODEL for undefined", () => {
    const result = parseModel(undefined)
    expect(result.providerID).toBe("anthropic")
    expect(result.modelID).toBe("claude-haiku-4-5")
  })

  test("returns DEFAULT_MODEL for empty string", () => {
    const result = parseModel("")
    expect(result.providerID).toBe("anthropic")
    expect(result.modelID).toBe("claude-haiku-4-5")
  })

  test("returns DEFAULT_MODEL for whitespace-only string", () => {
    const result = parseModel("   ")
    expect(result.providerID).toBe("anthropic")
    expect(result.modelID).toBe("claude-haiku-4-5")
  })

  test("parses provider/model format", () => {
    expect(parseModel("anthropic/claude-haiku-4-5")).toEqual({
      providerID: "anthropic",
      modelID: "claude-haiku-4-5",
    })
  })

  test("parses different provider", () => {
    expect(parseModel("openai/gpt-4o-mini")).toEqual({
      providerID: "openai",
      modelID: "gpt-4o-mini",
    })
  })

  test("defaults providerID to anthropic when no slash", () => {
    expect(parseModel("claude-haiku-4-5")).toEqual({
      providerID: "anthropic",
      modelID: "claude-haiku-4-5",
    })
  })

  test("trims whitespace", () => {
    expect(parseModel("  openai/gpt-4o-mini  ")).toEqual({
      providerID: "openai",
      modelID: "gpt-4o-mini",
    })
  })

  test("handles model with multiple slashes", () => {
    expect(parseModel("google/gemini/2.0-flash")).toEqual({
      providerID: "google",
      modelID: "gemini/2.0-flash",
    })
  })
})

describe("dateStamp", () => {
  test("returns YYYY-MM-DD format", () => {
    const stamp = dateStamp()
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  test("returns today's date", () => {
    const expected = new Date().toISOString().slice(0, 10)
    expect(dateStamp()).toBe(expected)
  })
})
