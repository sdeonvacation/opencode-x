import { beforeEach, describe, expect, mock, test } from "bun:test"
import { Effect } from "effect"
import { Config } from "../../src/config/config"
import type { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

const state = {
  calls: 0,
  err: undefined as unknown,
  text: "summary",
}

mock.module("ai", () => ({
  generateText: async () => {
    state.calls++
    if (state.err) throw state.err
    return { text: state.text }
  },
  wrapLanguageModel: ({ model }: { model: unknown }) => model,
}))

const { SlidingWindow } = await import("../../src/session/sliding-window")

const compact: (input: Parameters<typeof SlidingWindow.compact>[0]) => Promise<MessageV2.WithParts[]> = (input) =>
  Effect.runPromise(SlidingWindow.compact(input))

beforeEach(() => {
  state.calls = 0
  state.err = undefined
  state.text = "summary"
})

function model() {
  return {
    id: ModelID.make("test-model"),
    providerID: ProviderID.make("test"),
    name: "Test Model",
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      interleaved: false,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
    api: { id: "test-model", url: "https://example.com", npm: "@ai-sdk/openai" },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 200_000, output: 10_000 },
    status: "active" as const,
    options: {},
    headers: {},
    release_date: "2025-01-01",
  } satisfies Provider.Model
}

function prov(): Provider.Interface {
  const mdl = model()
  return {
    list: Effect.fn("TestProvider.list")(() => Effect.succeed({})),
    getProvider: Effect.fn("TestProvider.getProvider")(() => Effect.die(new Error("unused"))),
    getModel: Effect.fn("TestProvider.getModel")((providerID, modelID) => {
      if (providerID === mdl.providerID && modelID === mdl.id) return Effect.succeed(mdl)
      return Effect.die(new Error("unknown model"))
    }),
    getLanguage: Effect.fn("TestProvider.getLanguage")(() => Effect.succeed({} as never)),
    closest: Effect.fn("TestProvider.closest")(() => Effect.succeed(undefined)),
    getSmallModel: Effect.fn("TestProvider.getSmallModel")(() => Effect.succeed(undefined)),
    defaultModel: Effect.fn("TestProvider.defaultModel")(() =>
      Effect.succeed({ providerID: mdl.providerID, modelID: mdl.id }),
    ),
  }
}

function cfg(opts?: { cache?: boolean }) {
  return Config.Info.parse({
    provider: {
      test: {
        id: ProviderID.make("test"),
        name: "Test",
        env: [],
      },
    },
    hybrid: {
      enabled: true,
      local_model: {
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("test-model"),
      },
    },
    compaction: {
      sliding_window: {
        enabled: true,
        threshold: 10_000,
        tail_ratio: 0.5,
        primary_only: true,
        timeout_ms: 1_000,
      },
    },
    experimental: opts?.cache ? { cache_sliding_window: true } : undefined,
  })
}

function text(size: number) {
  return "x".repeat(size)
}

function user(sessionID: SessionID, size: number): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "user",
      sessionID,
      time: { created: Date.now() },
      agent: "build",
      model: {
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("test-model"),
      },
    },
    parts: [
      {
        id: PartID.ascending(),
        sessionID,
        messageID: id,
        type: "text",
        text: text(size),
      },
    ],
  }
}

function assistant(sessionID: SessionID, parentID: MessageID, size: number): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      sessionID,
      parentID,
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: ModelID.make("test-model"),
      providerID: ProviderID.make("test"),
      time: { created: Date.now() },
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        sessionID,
        messageID: id,
        type: "text",
        text: text(size),
      },
    ],
  }
}

function history(sessionID: SessionID) {
  const first = user(sessionID, 12_000)
  const second = assistant(sessionID, first.info.id, 12_000)
  const third = user(sessionID, 4_000)
  const fourth = assistant(sessionID, third.info.id, 4_000)
  const fifth = user(sessionID, 32_000)
  const sixth = assistant(sessionID, fifth.info.id, 4_000)
  return { msgs: [first, second, third, fourth, fifth, sixth], last: [fifth, sixth] }
}

function input(sessionID: SessionID, msgs: MessageV2.WithParts[], opts?: { cache?: boolean }) {
  return {
    msgs,
    model: model(),
    provider: prov(),
    cfg: cfg({ cache: opts?.cache }),
    sessionID,
    agent: { name: "build", mode: "primary" } as const,
  }
}

describe("sliding-window generation cache", () => {
  test("returns cached result on repeated call with same messages", async () => {
    const sessionID = SessionID.make("session_gen_hit")
    const { msgs } = history(sessionID)
    state.text = "gen-cached"

    const first = await compact(input(sessionID, msgs, { cache: true }))
    expect(state.calls).toBe(1)

    state.text = "should-not-appear"
    const second = await compact(input(sessionID, msgs, { cache: true }))

    // Second call should hit generation cache — no new summarize call
    expect(state.calls).toBe(1)
    expect(second).toEqual(first)
    expect(second[0]?.parts[0]).toMatchObject({
      text: "<context-summary>\ngen-cached\n</context-summary>",
    })
  })

  test("recomputes when messages change", async () => {
    const sessionID = SessionID.make("session_gen_miss")
    const { msgs } = history(sessionID)
    state.text = "first-gen"

    await compact(input(sessionID, msgs, { cache: true }))
    expect(state.calls).toBe(1)

    // Add a new message — generation key changes
    const extra = user(sessionID, 4_000)
    const updated = [...msgs, extra]
    state.text = "second-gen"
    // Clear the summary cache so only generation cache is in play
    SlidingWindow.invalidate(SessionID.make("session_gen_miss"))
    const result = await compact(input(sessionID, updated, { cache: true }))

    expect(state.calls).toBe(2)
    expect(result[0]?.parts[0]).toMatchObject({
      text: "<context-summary>\nsecond-gen\n</context-summary>",
    })
  })

  test("invalidate clears generation cache", async () => {
    const sessionID = SessionID.make("session_gen_invalidate")
    const { msgs } = history(sessionID)
    state.text = "before-invalidate"

    await compact(input(sessionID, msgs, { cache: true }))
    expect(state.calls).toBe(1)

    SlidingWindow.invalidate(sessionID)
    state.text = "after-invalidate"
    const result = await compact(input(sessionID, msgs, { cache: true }))

    // Should recompute after invalidation
    expect(state.calls).toBe(2)
    expect(result[0]?.parts[0]).toMatchObject({
      text: "<context-summary>\nafter-invalidate\n</context-summary>",
    })
  })

  test("does not cache when flag is off", async () => {
    const sessionID = SessionID.make("session_gen_off")
    const { msgs } = history(sessionID)
    state.text = "no-cache"

    await compact(input(sessionID, msgs, { cache: false }))
    expect(state.calls).toBe(1)

    // Same messages, flag off — should still go through full path
    // (hits the existing headEndID cache, but not generation cache)
    const result = await compact(input(sessionID, msgs, { cache: false }))
    // headEndID cache hit means no new summarize call, but estimate still runs
    expect(result[0]?.parts[0]).toMatchObject({
      text: "<context-summary>\nno-cache\n</context-summary>",
    })
  })

  test("caches below-threshold result when flag is on", async () => {
    const sessionID = SessionID.make("session_gen_below")
    const first = user(sessionID, 2_000)
    const second = assistant(sessionID, first.info.id, 2_000)
    const msgs = [first, second]

    // Below threshold — returns input.msgs
    const result = await compact(input(sessionID, msgs, { cache: true }))
    expect(result).toBe(msgs)
    expect(state.calls).toBe(0)

    // Second call with same messages — generation hit returns cached
    const again = await compact(input(sessionID, msgs, { cache: true }))
    expect(again).toEqual(msgs)
    expect(state.calls).toBe(0)
  })
})
