import { describe, expect, test, mock, beforeAll } from "bun:test"
import type { Config } from "../../../../src/config/config"

// mock.module must be called before the module under test is loaded.
// Static imports are hoisted in ESM even when written after mock.module(),
// so we use dynamic import() inside beforeAll to guarantee correct order.
mock.module("ai", () => ({
  generateText: async () => ({ text: "test reaction" }),
}))
mock.module("@/provider/provider", () => ({
  Provider: {
    getModel: async () => ({}),
    getLanguage: async () => ({}),
  },
}))

type ReactModule = typeof import("../../../../src/cli/cmd/tui/buddy/react")
let isAddressed: ReactModule["isAddressed"]
let buildTranscript: ReactModule["buildTranscript"]
let triggerCompanionReaction: ReactModule["triggerCompanionReaction"]

beforeAll(async () => {
  const mod = await import("../../../../src/cli/cmd/tui/buddy/react")
  isAddressed = mod.isAddressed
  buildTranscript = mod.buildTranscript
  triggerCompanionReaction = mod.triggerCompanionReaction
})

// ─── Helpers ─────────────────────────────────────────

function makeConfig(overrides: Partial<Config.Info> = {}): Config.Info {
  return overrides as Config.Info
}

function makeMessages(pairs: Array<{ role: "user" | "assistant"; content: string }>) {
  return pairs.map(({ role, content }) => ({ role, content }))
}

// ─── isAddressed ─────────────────────────────────────

describe("isAddressed", () => {
  test("returns true when companion name appears in last user message", () => {
    const msgs = makeMessages([{ role: "user", content: "Hey Pip, what do you think?" }])
    expect(isAddressed(msgs, "Pip")).toBe(true)
  })

  test("is case-insensitive", () => {
    const msgs = makeMessages([{ role: "user", content: "hey pip, help!" }])
    expect(isAddressed(msgs, "Pip")).toBe(true)
  })

  test("returns false when name not present", () => {
    const msgs = makeMessages([{ role: "user", content: "What is the meaning of life?" }])
    expect(isAddressed(msgs, "Pip")).toBe(false)
  })

  test("returns false for assistant messages only", () => {
    const msgs = makeMessages([{ role: "assistant", content: "Pip says hello" }])
    expect(isAddressed(msgs, "Pip")).toBe(false)
  })

  test("only checks last 3 messages", () => {
    const msgs = makeMessages([
      { role: "user", content: "Hey Pip!" },
      { role: "assistant", content: "response 1" },
      { role: "user", content: "message 2" },
      { role: "assistant", content: "response 2" },
      { role: "user", content: "message 3 no name" },
    ])
    expect(isAddressed(msgs, "Pip")).toBe(false)
  })

  test("detects name within last 3 messages", () => {
    const msgs = makeMessages([
      { role: "user", content: "old message" },
      { role: "user", content: "Hey Pip, are you there?" },
      { role: "assistant", content: "response" },
      { role: "user", content: "follow up" },
    ])
    expect(isAddressed(msgs, "Pip")).toBe(true)
  })

  test("handles empty messages array", () => {
    expect(isAddressed([], "Pip")).toBe(false)
  })

  test("handles array content parts", () => {
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "Hey Pip, look at this" },
          { type: "image", url: "http://example.com/img.png" },
        ],
      },
    ]
    expect(isAddressed(msgs, "Pip")).toBe(true)
  })

  test("uses word boundary matching (no partial matches)", () => {
    const msgs = makeMessages([{ role: "user", content: "Pipette is a chemistry tool" }])
    expect(isAddressed(msgs, "Pip")).toBe(false)
  })

  test("supports type-based messages (legacy format)", () => {
    const msgs = [{ type: "user", message: { content: "Hey Pip!" } }]
    expect(isAddressed(msgs, "Pip")).toBe(true)
  })
})

// ─── buildTranscript ─────────────────────────────────

describe("buildTranscript", () => {
  test("returns empty string for empty messages", () => {
    expect(buildTranscript([])).toBe("")
  })

  test("formats user and assistant messages", () => {
    const msgs = makeMessages([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ])
    const transcript = buildTranscript(msgs)
    expect(transcript).toContain("user: Hello")
    expect(transcript).toContain("assistant: Hi there")
  })

  test("only includes last 12 messages", () => {
    const msgs = makeMessages(
      Array.from({ length: 20 }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: `message ${i}`,
      })),
    )
    const transcript = buildTranscript(msgs)
    // Should not contain very early messages
    expect(transcript).not.toContain("message 0")
    expect(transcript).not.toContain("message 7")
  })

  test("truncates long content to 300 chars", () => {
    const longContent = "x".repeat(500)
    const msgs = makeMessages([{ role: "user", content: longContent }])
    const transcript = buildTranscript(msgs)
    // The content portion should be truncated
    expect(transcript.length).toBeLessThan(400)
  })

  test("handles array content parts", () => {
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "Hello" },
          { type: "text", text: "World" },
        ],
      },
    ]
    const transcript = buildTranscript(msgs)
    expect(transcript).toContain("Hello")
    expect(transcript).toContain("World")
  })

  test("total transcript capped at 5000 chars", () => {
    const msgs = makeMessages(
      Array.from({ length: 12 }, () => ({
        role: "user" as const,
        content: "x".repeat(500),
      })),
    )
    const transcript = buildTranscript(msgs)
    expect(transcript.length).toBeLessThanOrEqual(5000)
  })

  test("filters out non-user/assistant messages", () => {
    const msgs = [
      { role: "user", content: "Hello" },
      { role: "system", content: "System message" },
      { role: "assistant", content: "Hi" },
    ]
    const transcript = buildTranscript(msgs)
    expect(transcript).not.toContain("System message")
    expect(transcript).toContain("Hello")
    expect(transcript).toContain("Hi")
  })
})

// ─── triggerCompanionReaction ─────────────────────────

describe("triggerCompanionReaction", () => {
  test("does nothing when no companion in config", () => {
    const config = makeConfig({})
    let called = false
    triggerCompanionReaction(
      makeMessages([{ role: "user", content: "hello" }]),
      () => {
        called = true
      },
      config,
      { providerID: "anthropic", modelID: "claude-3-haiku" },
    )
    expect(called).toBe(false)
  })

  test("does nothing when companion_muted is true", () => {
    const config = makeConfig({
      companion: { name: "Pip", personality: "cheerful", hatchedAt: Date.now() },
      companion_muted: true,
    })
    let called = false
    triggerCompanionReaction(
      makeMessages([{ role: "user", content: "hello" }]),
      () => {
        called = true
      },
      config,
      { providerID: "anthropic", modelID: "claude-3-haiku" },
    )
    expect(called).toBe(false)
  })

  test("does nothing when transcript is empty", () => {
    const config = makeConfig({
      companion: { name: "Pip", personality: "cheerful", hatchedAt: Date.now() },
    })
    let called = false
    triggerCompanionReaction(
      [],
      () => {
        called = true
      },
      config,
      { providerID: "anthropic", modelID: "claude-3-haiku" },
    )
    expect(called).toBe(false)
  })

  test("does not throw when called with valid args (async path not awaited)", () => {
    const config = makeConfig({
      companion: { name: "Pip", personality: "cheerful", hatchedAt: Date.now() },
    })
    // Should not throw synchronously
    expect(() => {
      triggerCompanionReaction(makeMessages([{ role: "user", content: "Hey Pip!" }]), () => {}, config, {
        providerID: "anthropic",
        modelID: "claude-3-haiku",
      })
    }).not.toThrow()
  })
})
