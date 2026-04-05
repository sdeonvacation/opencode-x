import { describe, expect, test } from "bun:test"
import { resolve } from "../../src/orchestration/category-routing"

describe("orchestration/category-routing", () => {
  const fallback = { providerID: "openai", modelID: "gpt-5" }
  const categories = {
    explore: { providerID: "anthropic", modelID: "claude-4" },
  }

  test("returns mapped model for known category", () => {
    expect(resolve({ category: "explore", categories, fallback })).toEqual(categories.explore)
  })

  test("falls back for unknown category", () => {
    expect(resolve({ category: "build", categories, fallback })).toEqual(fallback)
  })

  test("falls back for undefined category", () => {
    expect(resolve({ categories, fallback })).toEqual(fallback)
  })

  test("falls back for empty category map", () => {
    expect(resolve({ category: "explore", categories: {}, fallback })).toEqual(fallback)
  })
})
