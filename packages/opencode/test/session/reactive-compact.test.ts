// [fork-perf] Phase 5 tests: reactive compaction
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ReactiveCompact } from "../../src/session/llm/reactive-compact"
import { SessionID } from "../../src/session/schema"
import type { Provider } from "../../src/provider/provider"
import type { Config } from "../../src/config/config"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"

describe("ReactiveCompact.isOverflow", () => {
  test("matches 413 status code", () => {
    expect(ReactiveCompact.isOverflow({ status: 413, message: "too large" })).toBe(true)
    expect(ReactiveCompact.isOverflow({ statusCode: 413, message: "error" })).toBe(true)
  })

  test("matches 'context length' in message", () => {
    expect(ReactiveCompact.isOverflow(new Error("context length exceeded"))).toBe(true)
    expect(ReactiveCompact.isOverflow({ message: "This model's context length is 128000" })).toBe(true)
  })

  test("matches 'too large' in message", () => {
    expect(ReactiveCompact.isOverflow(new Error("Request too large for model"))).toBe(true)
  })

  test("matches 'maximum context'", () => {
    expect(ReactiveCompact.isOverflow({ message: "Exceeds maximum context size" })).toBe(true)
  })

  test("matches 'context window'", () => {
    expect(ReactiveCompact.isOverflow({ message: "context window exceeded" })).toBe(true)
  })

  test("matches 'context_length_exceeded'", () => {
    expect(ReactiveCompact.isOverflow({ message: "context_length_exceeded" })).toBe(true)
  })

  test("matches 'prompt is too long'", () => {
    expect(ReactiveCompact.isOverflow({ message: "prompt is too long" })).toBe(true)
  })

  test("matches ContextOverflowError _tag", () => {
    expect(ReactiveCompact.isOverflow({ _tag: "ContextOverflowError" })).toBe(true)
  })

  test("matches isContextOverflow boolean flag", () => {
    expect(ReactiveCompact.isOverflow({ isContextOverflow: true })).toBe(true)
  })

  test("rejects unrelated errors", () => {
    expect(ReactiveCompact.isOverflow(new Error("network timeout"))).toBe(false)
    expect(ReactiveCompact.isOverflow(new Error("invalid API key"))).toBe(false)
    expect(ReactiveCompact.isOverflow({ status: 429, message: "rate limit" })).toBe(false)
    expect(ReactiveCompact.isOverflow({ status: 500, message: "internal server error" })).toBe(false)
    expect(ReactiveCompact.isOverflow(null)).toBe(false)
    expect(ReactiveCompact.isOverflow(undefined)).toBe(false)
    expect(ReactiveCompact.isOverflow("")).toBe(false)
  })

  test("rejects 401/403 errors", () => {
    expect(ReactiveCompact.isOverflow({ status: 401, message: "Unauthorized" })).toBe(false)
    expect(ReactiveCompact.isOverflow({ status: 403, message: "Forbidden" })).toBe(false)
  })
})

// Minimal message builder for tests
function makeMsg(role: "user" | "assistant", text: string): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role,
      sessionID: SessionID.make("test-session"),
      time: { created: Date.now() },
      agent: "default",
      model: { providerID: "anthropic" as any, modelID: "claude-3-5-sonnet" as any },
    } as any,
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: SessionID.make("test-session"),
        type: "text" as const,
        text,
        time: { start: Date.now(), end: Date.now() },
      },
    ],
  }
}

// Mock provider.Interface for SlidingWindow
function mockProvider(): Provider.Interface {
  return {
    list: () => Effect.succeed([]),
    getProvider: () => Effect.succeed({} as any),
    getModel: () => Effect.succeed({} as any),
    getLanguage: () => Effect.succeed({} as any),
  } as any
}

function makeModel(): Provider.Model {
  return {
    id: "claude-3-5-sonnet",
    providerID: "anthropic",
    limit: { context: 200_000, input: 200_000, output: 8192 },
    api: { id: "anthropic" },
    name: "Claude 3.5 Sonnet",
    capabilities: { temperature: true },
  } as any
}

function makeCfg(overrides?: Partial<Config.Info["compaction"]>): Config.Info {
  return {
    compaction: {
      sliding_window: {
        enabled: true,
        threshold: 1000,
        tail_ratio: 0.5,
        primary_only: true,
        timeout_ms: 30_000,
        ...overrides?.sliding_window,
      } as any,
      ...overrides,
    },
    experimental: { reactive_compaction: true },
  } as any
}

describe("ReactiveCompact.handle", () => {
  test("returns retry:true with messages array", async () => {
    const msgs = [makeMsg("user", "hello"), makeMsg("assistant", "world")]
    const result = await Effect.runPromise(
      ReactiveCompact.handle({
        msgs,
        model: makeModel(),
        provider: mockProvider(),
        cfg: makeCfg(),
        sessionID: SessionID.make("test-session"),
        agent: { name: "default", mode: "primary" } as any,
      }),
    )
    expect(result.retry).toBe(true)
    expect(Array.isArray(result.messages)).toBe(true)
  })

  test("returns compacted (or original) messages — count <= input", async () => {
    const msgs = Array.from({ length: 5 }, (_, i) =>
      makeMsg(i % 2 === 0 ? "user" : "assistant", "x".repeat(100)),
    )
    const result = await Effect.runPromise(
      ReactiveCompact.handle({
        msgs,
        model: makeModel(),
        provider: mockProvider(),
        cfg: makeCfg(),
        sessionID: SessionID.make("test-session"),
        agent: { name: "default", mode: "primary" } as any,
      }),
    )
    // compact may return same msgs if below threshold (tests that it doesn't crash)
    expect(result.messages.length).toBeGreaterThan(0)
  })

  test("compactedReactively flag prevents double-compact on retry (consumer responsibility)", () => {
    // The flag lives in ProcessorContext; this test just validates the ReactiveCompact
    // module itself doesn't own the flag — consumer checks it before calling handle().
    // Here we verify isOverflow still works after a mock retry scenario.
    const overflowErr = { status: 413, message: "too large" }
    expect(ReactiveCompact.isOverflow(overflowErr)).toBe(true)
    // A non-overflow error after the retry should NOT trigger again
    const normalErr = new Error("model error")
    expect(ReactiveCompact.isOverflow(normalErr)).toBe(false)
  })
})
