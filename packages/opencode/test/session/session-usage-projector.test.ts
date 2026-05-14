import { describe, expect, test } from "bun:test"
import { usage } from "../../src/session/projectors"

describe("usage()", () => {
  test("returns zero for null", () => {
    const u = usage(null)
    expect(u.cost).toBe(0)
    expect(u.tokens_input).toBe(0)
    expect(u.tokens_output).toBe(0)
    expect(u.tokens_reasoning).toBe(0)
    expect(u.tokens_cache_read).toBe(0)
    expect(u.tokens_cache_write).toBe(0)
  })

  test("returns zero for non-object", () => {
    expect(usage("string").cost).toBe(0)
    expect(usage(42).tokens_input).toBe(0)
    expect(usage(undefined).cost).toBe(0)
  })

  test("returns zero for non-step-finish type", () => {
    const u = usage({ type: "text", cost: 5, tokens: { input: 100 } })
    expect(u.cost).toBe(0)
    expect(u.tokens_input).toBe(0)
  })

  test("extracts cost from step-finish", () => {
    const u = usage({ type: "step-finish", cost: 1.23 })
    expect(u.cost).toBe(1.23)
  })

  test("extracts all token fields from step-finish", () => {
    const u = usage({
      type: "step-finish",
      cost: 0.5,
      tokens: {
        input: 100,
        output: 200,
        reasoning: 50,
        cache: { read: 10, write: 20 },
      },
    })
    expect(u.cost).toBe(0.5)
    expect(u.tokens_input).toBe(100)
    expect(u.tokens_output).toBe(200)
    expect(u.tokens_reasoning).toBe(50)
    expect(u.tokens_cache_read).toBe(10)
    expect(u.tokens_cache_write).toBe(20)
  })

  test("handles missing tokens object", () => {
    const u = usage({ type: "step-finish", cost: 1 })
    expect(u.tokens_input).toBe(0)
    expect(u.tokens_cache_read).toBe(0)
  })

  test("handles missing cache in tokens", () => {
    const u = usage({ type: "step-finish", tokens: { input: 5, output: 10 } })
    expect(u.tokens_input).toBe(5)
    expect(u.tokens_output).toBe(10)
    expect(u.tokens_cache_read).toBe(0)
    expect(u.tokens_cache_write).toBe(0)
  })

  test("handles non-number cost gracefully", () => {
    const u = usage({ type: "step-finish", cost: "not-a-number" })
    expect(u.cost).toBe(0)
  })

  test("handles non-number token fields gracefully", () => {
    const u = usage({ type: "step-finish", tokens: { input: "bad", output: null } })
    expect(u.tokens_input).toBe(0)
    expect(u.tokens_output).toBe(0)
  })
})
