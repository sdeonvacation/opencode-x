import { test, expect, describe } from "bun:test"

describe("Flag.OPENCODE_EXPERIMENTAL_DREAM", () => {
  test("exports OPENCODE_EXPERIMENTAL_DREAM flag", async () => {
    // Dynamic import to pick up current env state
    const { Flag } = await import("../../src/flag/flag")
    expect("OPENCODE_EXPERIMENTAL_DREAM" in Flag).toBe(true)
    expect(typeof Flag.OPENCODE_EXPERIMENTAL_DREAM).toBe("boolean")
  })

  test("is true by default (enabled unless explicitly disabled)", async () => {
    const { Flag } = await import("../../src/flag/flag")
    // !falsy() pattern means true unless OPENCODE_EXPERIMENTAL_DREAM="false"/"0"
    expect(Flag.OPENCODE_EXPERIMENTAL_DREAM).toBe(true)
  })
})
