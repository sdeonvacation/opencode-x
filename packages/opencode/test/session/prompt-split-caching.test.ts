import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { ProviderTransform } from "../../src/provider/transform"
import type { Provider } from "../../src/provider/provider"

function model(overrides?: Partial<Provider.Model>): Provider.Model {
  return {
    id: "claude-sonnet-4-20250514",
    providerID: "anthropic",
    api: { id: "anthropic", url: "https://api.anthropic.com/v1", npm: "@ai-sdk/anthropic" },
    name: "Claude Sonnet 4",
    family: "claude-sonnet",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
    limit: { context: 200000, output: 16384 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2025-05-14",
    ...overrides,
  } as Provider.Model
}

describe("prompt_split_caching: applyCaching with 2 system messages", () => {
  test("marks only system[0] with cacheControl for Anthropic when 2 system messages present", () => {
    const msgs: ModelMessage[] = [
      { role: "system", content: "stable skills and instructions" },
      { role: "system", content: "dynamic env and memory" },
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]
    const result = ProviderTransform.message(msgs, model(), {})
    const system = result.filter((m) => m.role === "system")

    // system[0] should have cacheControl
    expect(system[0].providerOptions).toBeDefined()
    expect((system[0].providerOptions as any).anthropic?.cacheControl?.type).toBe("ephemeral")

    // system[1] should NOT have cacheControl (dynamic content)
    expect(system[1].providerOptions?.anthropic).toBeUndefined()
  })

  test("marks system[0] only for bedrock provider", () => {
    const msgs: ModelMessage[] = [
      { role: "system", content: "stable prefix" },
      { role: "system", content: "dynamic suffix" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]
    const m = model({
      providerID: "bedrock" as any,
      api: { id: "bedrock", url: "https://bedrock.aws", npm: "@ai-sdk/amazon-bedrock" },
    })
    const result = ProviderTransform.message(msgs, m, {})
    const system = result.filter((msg) => msg.role === "system")

    expect((system[0].providerOptions as any).bedrock?.cachePoint?.type).toBe("default")
    expect(system[1].providerOptions?.bedrock).toBeUndefined()
  })

  test("single system message still gets cacheControl (non-split case)", () => {
    const msgs: ModelMessage[] = [
      { role: "system", content: "all combined prompt" },
      { role: "user", content: [{ type: "text", text: "test" }] },
    ]
    const result = ProviderTransform.message(msgs, model(), {})
    const system = result.filter((m) => m.role === "system")

    expect(system).toHaveLength(1)
    expect((system[0].providerOptions as any).anthropic?.cacheControl?.type).toBe("ephemeral")
  })

  test("non-anthropic provider does not mark system messages for caching", () => {
    const msgs: ModelMessage[] = [
      { role: "system", content: "stable" },
      { role: "system", content: "dynamic" },
      { role: "user", content: [{ type: "text", text: "q" }] },
    ]
    const m = model({
      id: "gpt-4o" as any,
      providerID: "openai" as any,
      api: { id: "openai", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
    })
    const result = ProviderTransform.message(msgs, m, {})
    const system = result.filter((msg) => msg.role === "system")

    // OpenAI doesn't go through applyCaching
    for (const msg of system) {
      expect(msg.providerOptions?.anthropic).toBeUndefined()
    }
  })

  test("user message still gets cacheControl as final target", () => {
    const msgs: ModelMessage[] = [
      { role: "system", content: "stable" },
      { role: "system", content: "dynamic" },
      { role: "user", content: [{ type: "text", text: "question" }] },
    ]
    const result = ProviderTransform.message(msgs, model(), {})
    const user = result.find((m) => m.role === "user")

    // user is both first non-system and last message → gets cacheControl
    expect((user?.providerOptions as any)?.anthropic?.cacheControl?.type).toBe("ephemeral")
  })
})

describe("prompt_split_caching: system array construction", () => {
  // These test the logic that would be in llm.ts for building system messages
  // from the split prompt. We test the logic directly without needing Effect runtime.

  function build(opts: { split: boolean; agent?: string; system: string[]; user?: string }): string[] {
    const result: string[] = []
    if (opts.split && opts.system.length >= 2) {
      const stable = [...(opts.agent ? [opts.agent] : []), opts.system[0]].filter((x) => x).join("\n")
      const dynamic = [...opts.system.slice(1), ...(opts.user ? [opts.user] : [])].filter((x) => x).join("\n")
      result.push(stable, dynamic)
    } else {
      result.push(
        [...(opts.agent ? [opts.agent] : []), ...opts.system, ...(opts.user ? [opts.user] : [])]
          .filter((x) => x)
          .join("\n"),
      )
    }
    return result
  }

  test("split enabled: produces 2 entries with stable prefix and dynamic suffix", () => {
    const result = build({
      split: true,
      agent: "You are an assistant",
      system: ["skills\ninstructions", "env\nmemory"],
      user: "extra",
    })
    expect(result).toHaveLength(2)
    expect(result[0]).toBe("You are an assistant\nskills\ninstructions")
    expect(result[1]).toBe("env\nmemory\nextra")
  })

  test("split enabled: agent prompt prepended to stable part", () => {
    const result = build({
      split: true,
      agent: "Agent prompt",
      system: ["stable content", "dynamic content"],
    })
    expect(result[0]).toContain("Agent prompt")
    expect(result[0]).toContain("stable content")
    expect(result[1]).toBe("dynamic content")
  })

  test("split enabled: user system appended to dynamic part", () => {
    const result = build({
      split: true,
      system: ["stable", "dynamic"],
      user: "user system",
    })
    expect(result[1]).toBe("dynamic\nuser system")
  })

  test("split enabled: multiple dynamic entries joined into system[1]", () => {
    const result = build({
      split: true,
      system: ["stable", "env", "memory", "hooks"],
    })
    expect(result).toHaveLength(2)
    expect(result[0]).toBe("stable")
    expect(result[1]).toBe("env\nmemory\nhooks")
  })

  test("split disabled: everything collapsed into single string", () => {
    const result = build({
      split: false,
      agent: "Agent",
      system: ["stable", "dynamic"],
      user: "user",
    })
    expect(result).toHaveLength(1)
    expect(result[0]).toBe("Agent\nstable\ndynamic\nuser")
  })

  test("split enabled with single system entry: falls back to non-split", () => {
    const result = build({
      split: true,
      agent: "Agent",
      system: ["only one"],
      user: "user",
    })
    // length < 2 → falls through to else branch
    expect(result).toHaveLength(1)
    expect(result[0]).toBe("Agent\nonly one\nuser")
  })

  test("split enabled: empty agent prompt filtered out", () => {
    const result = build({
      split: true,
      system: ["stable", "dynamic"],
    })
    expect(result[0]).toBe("stable")
    expect(result[1]).toBe("dynamic")
  })
})
