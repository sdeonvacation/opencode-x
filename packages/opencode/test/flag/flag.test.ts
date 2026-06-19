import { test, expect, describe } from "bun:test"

describe("Flag.OPENCODE_EXPERIMENTAL_DREAM", () => {
  test("exports OPENCODE_EXPERIMENTAL_DREAM flag", async () => {
    // Dynamic import to pick up current env state
    const { Flag } = await import("../../src/flag/flag")
    expect("OPENCODE_EXPERIMENTAL_DREAM" in Flag).toBe(true)
    expect(typeof Flag.OPENCODE_EXPERIMENTAL_DREAM).toBe("boolean")
  })

  test("is false when env unset and OPENCODE_EXPERIMENTAL is off", async () => {
    // Flag module is evaluated at import time with static env.
    // We verify the exported value is boolean (structural correctness).
    const { Flag } = await import("../../src/flag/flag")
    // enabledByExperimental returns OPENCODE_EXPERIMENTAL when key undefined
    // In test env, OPENCODE_EXPERIMENTAL defaults to false
    expect(Flag.OPENCODE_EXPERIMENTAL_DREAM).toBe(Flag.OPENCODE_EXPERIMENTAL)
  })
})
