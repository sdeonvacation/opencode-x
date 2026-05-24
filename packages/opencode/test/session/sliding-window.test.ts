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
  lastPrompt: undefined as string | undefined,
}

mock.module("ai", () => ({
  generateText: async (opts: { messages?: Array<{ content: string }> }) => {
    state.calls++
    state.lastPrompt = opts?.messages?.[0]?.content
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
  state.lastPrompt = undefined
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

function provider(opts?: { missing?: boolean }): Provider.Interface {
  const mdl = model()
  return {
    list: Effect.fn("TestProvider.list")(() => Effect.succeed({})),
    getProvider: Effect.fn("TestProvider.getProvider")(() => Effect.die(new Error("unused"))),
    getModel: Effect.fn("TestProvider.getModel")((providerID, modelID) => {
      if (opts?.missing) return Effect.die(new Error("missing model"))
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

function cfg(compaction?: Config.Info["compaction"]) {
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
      cheap_model: {
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("test-model"),
      },
    },
    compaction,
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

function input(
  sessionID: SessionID,
  msgs: MessageV2.WithParts[],
  mode: "primary" | "subagent" | "all" = "primary",
  opts?: { provider?: Provider.Interface; threshold?: number; hint?: number },
) {
  const svc = opts?.provider ?? provider()
  return {
    msgs,
    model: model(),
    provider: svc,
    cfg: cfg({
      sliding_window: {
        enabled: true,
        threshold: opts?.threshold ?? 10_000,
        tail_ratio: 0.5,
        primary_only: true,
        timeout_ms: 1_000,
      },
    }),
    sessionID,
    agent: { name: mode === "primary" ? "build" : "general", mode } as const,
    hint: opts?.hint,
  }
}

describe("sliding-window", () => {
  test("returns msgs unchanged when disabled", async () => {
    const sessionID = SessionID.make("session_sw_disabled")
    const { msgs } = history(sessionID)
    const svc = provider()
    const result = await compact({
      msgs,
      model: model(),
      provider: svc,
      cfg: cfg({
        sliding_window: {
          enabled: false,
          threshold: 10_000,
          tail_ratio: 0.5,
          primary_only: true,
          timeout_ms: 1_000,
        },
      }),
      sessionID,
      agent: { name: "build", mode: "primary" },
    })

    expect(result).toBe(msgs)
    expect(state.calls).toBe(0)
  })

  test("skips subagents when primary_only is enabled", async () => {
    const sessionID = SessionID.make("session_sw_subagent")
    const { msgs } = history(sessionID)
    const result = await compact(input(sessionID, msgs, "subagent"))

    expect(result).toBe(msgs)
    expect(state.calls).toBe(0)
  })

  test('skips non-primary mode "all" when primary_only is enabled', async () => {
    const sessionID = SessionID.make("session_sw_all")
    const { msgs } = history(sessionID)
    const result = await compact(input(sessionID, msgs, "all"))

    expect(result).toBe(msgs)
    expect(state.calls).toBe(0)
  })

  test("returns msgs unchanged below threshold", async () => {
    const sessionID = SessionID.make("session_sw_threshold")
    const { msgs } = history(sessionID)
    const result = await compact(input(sessionID, msgs, "primary", { threshold: 1_000_000 }))

    expect(result).toBe(msgs)
    expect(state.calls).toBe(0)
  })

  test("returns msgs unchanged when summarized head is too small", async () => {
    const sessionID = SessionID.make("session_sw_small_head")
    const first = user(sessionID, 2_000)
    const second = assistant(sessionID, first.info.id, 2_000)
    const third = user(sessionID, 20_000)
    const fourth = assistant(sessionID, third.info.id, 2_000)
    const msgs = [first, second, third, fourth]

    const result = await compact(input(sessionID, msgs))

    expect(result).toBe(msgs)
    expect(state.calls).toBe(0)
  })

  test("prepends summary and preserves full last turn", async () => {
    const sessionID = SessionID.make("session_sw_compact")
    const { msgs, last } = history(sessionID)
    state.text = "rolled up"

    const result = await compact(input(sessionID, msgs))

    expect(state.calls).toBe(1)
    expect(result).toHaveLength(3)
    expect(result[0]?.info.role).toBe("user")
    expect(result[0]?.parts[0]).toMatchObject({
      type: "text",
      synthetic: true,
      text: "<context-summary>\nrolled up\n</context-summary>",
    })
    expect(result[1]?.info.id).toBe(last[0]?.info.id)
    expect(result[2]?.info.id).toBe(last[1]?.info.id)
  })

  test("reuses cache until invalidated", async () => {
    const sessionID = SessionID.make("session_sw_cache")
    const { msgs } = history(sessionID)
    const args = input(sessionID, msgs)

    state.text = "first"
    const first = await compact(args)
    state.text = "second"
    const second = await compact(args)
    SlidingWindow.invalidate(sessionID)
    const third = await compact(args)

    expect(state.calls).toBe(2)
    expect(first[0]?.parts[0]).toMatchObject({ text: "<context-summary>\nfirst\n</context-summary>" })
    expect(second[0]?.parts[0]).toMatchObject({ text: "<context-summary>\nfirst\n</context-summary>" })
    expect(third[0]?.parts[0]).toMatchObject({ text: "<context-summary>\nsecond\n</context-summary>" })
  })

  test("falls back to full context when summary fails", async () => {
    const sessionID = SessionID.make("session_sw_error")
    const { msgs } = history(sessionID)
    state.err = new Error("boom")

    const result = await compact(input(sessionID, msgs))

    expect(result).toBe(msgs)
    expect(state.calls).toBe(1)
  })

  test("falls back to full context when local model is unavailable", async () => {
    const sessionID = SessionID.make("session_sw_missing_model")
    const { msgs } = history(sessionID)

    const result = await compact(input(sessionID, msgs, "primary", { provider: provider({ missing: true }) }))

    expect(result).toBe(msgs)
    expect(state.calls).toBe(0)
  })

  test("falls back to full context when summary is empty", async () => {
    const sessionID = SessionID.make("session_sw_empty")
    const { msgs } = history(sessionID)
    state.text = ""

    const result = await compact(input(sessionID, msgs))

    expect(result).toBe(msgs)
    expect(state.calls).toBe(1)
  })

  test("getMetrics returns undefined before compaction", () => {
    const sessionID = SessionID.make("session_sw_metrics_none")
    expect(SlidingWindow.getMetrics(sessionID)).toBeUndefined()
  })

  test("getMetrics returns metrics after successful compaction", async () => {
    const sessionID = SessionID.make("session_sw_metrics_ok")
    const { msgs } = history(sessionID)
    state.text = "summary"

    await compact(input(sessionID, msgs))

    const m = SlidingWindow.getMetrics(sessionID)
    expect(m).toBeDefined()
    expect(m!.total).toBeGreaterThan(0)
    expect(m!.budget).toBeGreaterThan(0)
    expect(m!.head).toBeGreaterThan(0)
    expect(m!.msgs).toBeGreaterThan(0)
    expect(m!.ts).toBeGreaterThan(0)
    expect(m!.budget).toBeLessThanOrEqual(m!.total)
  })

  test("getMetrics cleared after invalidate", async () => {
    const sessionID = SessionID.make("session_sw_metrics_inv")
    const { msgs } = history(sessionID)
    state.text = "summary"

    await compact(input(sessionID, msgs))
    expect(SlidingWindow.getMetrics(sessionID)).toBeDefined()

    SlidingWindow.invalidate(sessionID)
    expect(SlidingWindow.getMetrics(sessionID)).toBeUndefined()
  })

  test("getMetrics not set when compaction skipped", async () => {
    const sessionID = SessionID.make("session_sw_metrics_skip")
    const { msgs } = history(sessionID)

    await compact(input(sessionID, msgs, "primary", { threshold: 1_000_000 }))

    expect(SlidingWindow.getMetrics(sessionID)).toBeUndefined()
  })

  test("hint overrides estimate when hint exceeds threshold", async () => {
    // msgs are small (below threshold), but hint reports large real token count
    const sessionID = SessionID.make("session_sw_hint_triggers")
    const first = user(sessionID, 4_000)
    const second = assistant(sessionID, first.info.id, 4_000)
    const third = user(sessionID, 4_000)
    const fourth = assistant(sessionID, third.info.id, 4_000)
    const fifth = user(sessionID, 20_000)
    const sixth = assistant(sessionID, fifth.info.id, 4_000)
    const msgs = [first, second, third, fourth, fifth, sixth]
    state.text = "hint-triggered"

    // threshold=50_000, estimated chars/4 ~10k (below threshold), but hint=60_000 forces compaction
    const result = await compact(input(sessionID, msgs, "primary", { threshold: 50_000, hint: 60_000 }))

    expect(state.calls).toBe(1)
    expect(result[0]?.parts[0]).toMatchObject({
      type: "text",
      synthetic: true,
      text: "<context-summary>\nhint-triggered\n</context-summary>",
    })
  })

  test("hint below threshold still skips when both hint and estimate are below", async () => {
    const sessionID = SessionID.make("session_sw_hint_skip")
    const { msgs } = history(sessionID)

    // threshold=1_000_000, hint=100 — both below threshold
    const result = await compact(input(sessionID, msgs, "primary", { threshold: 1_000_000, hint: 100 }))

    expect(result).toBe(msgs)
    expect(state.calls).toBe(0)
  })

  test("hint undefined falls back to estimate", async () => {
    const sessionID = SessionID.make("session_sw_hint_undefined")
    const { msgs } = history(sessionID)
    state.text = "no-hint"

    // no hint — behaves same as before (estimate drives threshold)
    const result = await compact(input(sessionID, msgs, "primary", { threshold: 10_000 }))

    expect(state.calls).toBe(1)
    expect(result[0]?.parts[0]).toMatchObject({
      type: "text",
      synthetic: true,
      text: "<context-summary>\nno-hint\n</context-summary>",
    })
  })

  test("hint smaller than estimate uses estimate (Math.max)", async () => {
    const sessionID = SessionID.make("session_sw_hint_smaller")
    const { msgs } = history(sessionID)
    state.text = "estimate-wins"

    // hint=1 is tiny, estimate from large msgs should still exceed threshold=10_000
    const result = await compact(input(sessionID, msgs, "primary", { threshold: 10_000, hint: 1 }))

    expect(state.calls).toBe(1)
    expect(result[0]?.parts[0]).toMatchObject({
      type: "text",
      synthetic: true,
      text: "<context-summary>\nestimate-wins\n</context-summary>",
    })
  })

  describe("render: strip <thinking> tags from summarizer input", () => {
    function msgWithText(sessionID: SessionID, textContent: string): MessageV2.WithParts {
      const id = MessageID.ascending()
      return {
        info: {
          id,
          role: "user" as const,
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
            type: "text" as const,
            text: textContent,
          },
        ],
      }
    }

    function msgWithReasoning(sessionID: SessionID, textContent: string): MessageV2.WithParts {
      const id = MessageID.ascending()
      return {
        info: {
          id,
          role: "assistant" as const,
          sessionID,
          parentID: MessageID.ascending(),
          mode: "build",
          agent: "build",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
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
            type: "reasoning" as const,
            text: textContent,
            time: { start: Date.now() },
          },
        ],
      }
    }

    async function renderPromptFor(msgs: MessageV2.WithParts[], sessionID: SessionID): Promise<string> {
      // Force compaction by using minimum allowed threshold so summarize() is always called.
      // We inspect the prompt passed to generateText via state.lastPrompt.
      await compact(input(sessionID, msgs, "primary", { threshold: 10000 }))
      return state.lastPrompt ?? ""
    }

    test("strips inline thinking tag from text part", async () => {
      const sessionID = SessionID.make("session_sw_strip_inline")
      // Put target FIRST so it lands in head (head gets summarized; tail does not).
      const target = msgWithText(sessionID, "before<thinking>foo</thinking>after")
      const big = user(sessionID, 20_000)
      const bigAssist = assistant(sessionID, big.info.id, 20_000)
      const tailUser = user(sessionID, 500)
      const tailAssist = assistant(sessionID, tailUser.info.id, 500)
      const msgs = [target, big, bigAssist, tailUser, tailAssist]

      const prompt = await renderPromptFor(msgs, sessionID)

      expect(prompt).toContain("beforeafter")
      expect(prompt).not.toContain("<thinking>")
      expect(prompt).not.toContain("foo")
    })

    test("strips multiple thinking tags from text part", async () => {
      const sessionID = SessionID.make("session_sw_strip_multi")
      const target = msgWithText(sessionID, "alpha<thinking>SECRET1</thinking>beta<thinking>SECRET2</thinking>gamma")
      const big = user(sessionID, 20_000)
      const bigAssist = assistant(sessionID, big.info.id, 20_000)
      const tailUser = user(sessionID, 500)
      const tailAssist = assistant(sessionID, tailUser.info.id, 500)
      const msgs = [target, big, bigAssist, tailUser, tailAssist]

      const prompt = await renderPromptFor(msgs, sessionID)

      expect(prompt).toContain("alphabetagamma")
      expect(prompt).not.toContain("<thinking>")
      expect(prompt).not.toContain("SECRET1")
      expect(prompt).not.toContain("SECRET2")
    })

    test("strips unclosed thinking tag to end of text", async () => {
      const sessionID = SessionID.make("session_sw_strip_unclosed")
      const target = msgWithText(sessionID, "start<thinking>partial")
      const big = user(sessionID, 20_000)
      const bigAssist = assistant(sessionID, big.info.id, 20_000)
      const tailUser = user(sessionID, 500)
      const tailAssist = assistant(sessionID, tailUser.info.id, 500)
      const msgs = [target, big, bigAssist, tailUser, tailAssist]

      const prompt = await renderPromptFor(msgs, sessionID)

      expect(prompt).toContain("start")
      expect(prompt).not.toContain("<thinking>")
      expect(prompt).not.toContain("partial")
    })

    test("reasoning part with <thinking> text is NOT stripped", async () => {
      const sessionID = SessionID.make("session_sw_strip_reasoning_safe")
      const target = msgWithReasoning(sessionID, "<thinking>this is reasoning</thinking>")
      const big = user(sessionID, 20_000)
      const bigAssist = assistant(sessionID, big.info.id, 20_000)
      const tailUser = user(sessionID, 500)
      const tailAssist = assistant(sessionID, tailUser.info.id, 500)
      const msgs = [target, big, bigAssist, tailUser, tailAssist]

      const prompt = await renderPromptFor(msgs, sessionID)

      // reasoning branch wraps with [reasoning]\n prefix; the text inside should be intact
      expect(prompt).toContain("[reasoning]")
      expect(prompt).toContain("<thinking>this is reasoning</thinking>")
    })
  })

  describe("hysteresis", () => {
    function cheapOf(msgs: MessageV2.WithParts[]) {
      return msgs.reduce(
        (acc, m) =>
          acc +
          Math.round(
            m.parts.reduce((s, p) => {
              if (p.type === "text" || p.type === "reasoning") return s + (p.text?.length ?? 0)
              return s
            }, 0) / 4,
          ),
        0,
      )
    }

    test("suppresses second compact when tail growth is below hysteresis_min_tokens", async () => {
      const sessionID = SessionID.make("session_sw_hysteresis_suppress")
      const { msgs } = history(sessionID)
      state.text = "first-compact"

      // First compact succeeds — this sets lastCompactTailEstimate internally
      const first = await compact(input(sessionID, msgs, "primary", { threshold: 10_000 }))
      expect(state.calls).toBe(1)
      expect(first[0]?.parts[0]).toMatchObject({ synthetic: true })

      // Override baseline: set it so cheap - baseline < 30_000 (default hysteresis_min_tokens)
      // This simulates tiny post-compact growth
      const currentCheap = cheapOf(msgs)
      SlidingWindow._setLastCompactTailEstimate(sessionID, currentCheap - 500) // only 500 tokens of growth

      // Add a new tail msg so generation key differs and we hit the hysteresis branch
      // (without this, lastGen cache short-circuits and returns the prior compacted output).
      const extraTail = user(sessionID, 200)
      const msgs2 = [...msgs, extraTail]

      const callsBefore = state.calls
      const second = await compact(input(sessionID, msgs2, "primary", { threshold: 10_000 }))

      // No new summarize call — hysteresis suppressed it
      expect(state.calls).toBe(callsBefore)
      // Returns msgs2 unchanged (stash path — not the compacted result)
      expect(second).toBe(msgs2)
    })

    test("allows compact when tail growth meets hysteresis_min_tokens", async () => {
      const sessionID = SessionID.make("session_sw_hysteresis_allow")
      const { msgs } = history(sessionID)
      state.text = "allow-compact"

      // First compact
      await compact(input(sessionID, msgs, "primary", { threshold: 10_000 }))
      expect(state.calls).toBe(1)

      // Set baseline very low so cheap - baseline >> 30_000: growth exceeds threshold
      SlidingWindow._setLastCompactTailEstimate(sessionID, 0)
      SlidingWindow.invalidate(sessionID) // clear summary cache so summarize runs again

      state.text = "second-compact"
      const second = await compact(input(sessionID, msgs, "primary", { threshold: 10_000 }))

      expect(state.calls).toBe(2)
      expect(second[0]?.parts[0]).toMatchObject({
        type: "text",
        synthetic: true,
        text: "<context-summary>\nsecond-compact\n</context-summary>",
      })
    })

    test("hysteresis_min_tokens=0 disables hysteresis suppression", async () => {
      const sessionID = SessionID.make("session_sw_hysteresis_zero")
      const { msgs } = history(sessionID)
      state.text = "no-hysteresis"

      const noHysteresisCfg = Config.Info.parse({
        provider: { test: { id: ProviderID.make("test"), name: "Test", env: [] } },
        hybrid: {
          enabled: true,
          cheap_model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
        },
        compaction: {
          sliding_window: {
            enabled: true,
            threshold: 10_000,
            tail_ratio: 0.5,
            primary_only: true,
            timeout_ms: 1_000,
            hysteresis_min_tokens: 0,
          },
        },
      })

      const run = (txt: string) => {
        state.text = txt
        return Effect.runPromise(
          SlidingWindow.compact({
            msgs,
            model: model(),
            provider: provider(),
            cfg: noHysteresisCfg,
            sessionID,
            agent: { name: "build", mode: "primary" },
          }),
        )
      }

      await run("first")
      expect(state.calls).toBe(1)

      // Set baseline that would suppress if hysteresis were active
      const cheap = cheapOf(msgs)
      SlidingWindow._setLastCompactTailEstimate(sessionID, cheap - 100)
      SlidingWindow.invalidate(sessionID)

      // With hysteresis_min_tokens=0, compact should proceed
      const second = await run("second")
      expect(state.calls).toBe(2)
      expect(second[0]?.parts[0]).toMatchObject({ synthetic: true })
    })

    test("hysteresis baseline cleared on invalidate, allowing compact to run", async () => {
      const sessionID = SessionID.make("session_sw_hysteresis_inv_clears")
      const { msgs } = history(sessionID)
      state.text = "after-invalidate"

      // First compact sets baseline
      await compact(input(sessionID, msgs, "primary", { threshold: 10_000 }))
      expect(state.calls).toBe(1)

      // Set baseline close to current cheap — triggers suppression
      const cheap = cheapOf(msgs)
      SlidingWindow._setLastCompactTailEstimate(sessionID, cheap - 100)

      const beforeInvalidate = state.calls
      await compact(input(sessionID, msgs, "primary", { threshold: 10_000 }))
      expect(state.calls).toBe(beforeInvalidate) // suppressed

      // Invalidate clears hysteresis baseline along with summary cache
      SlidingWindow.invalidate(sessionID)

      state.text = "post-invalidate"
      const result = await compact(input(sessionID, msgs, "primary", { threshold: 10_000 }))

      expect(state.calls).toBe(beforeInvalidate + 1) // compact ran
      expect(result[0]?.parts[0]).toMatchObject({
        type: "text",
        synthetic: true,
        text: "<context-summary>\npost-invalidate\n</context-summary>",
      })
    })
  })
})
