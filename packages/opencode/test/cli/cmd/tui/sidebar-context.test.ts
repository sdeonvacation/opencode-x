import { describe, expect, test } from "bun:test"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { getUsedTokens } from "../../../../src/cli/cmd/tui/feature-plugins/sidebar/context"

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: "msg_1",
    sessionID: "ses_1",
    role: "assistant",
    providerID: "opencode",
    modelID: "big-pickle",
    path: { cwd: "/tmp" },
    time: { created: Date.now() },
    system: [],
    cost: 0,
    tokens: {
      input: 1200,
      output: 140,
      reasoning: 25,
      cache: {
        read: 80,
        write: 0,
      },
    },
    ...overrides,
  }
}

describe("sidebar context", () => {
  test("uses summary output tokens after clear-compact", () => {
    const msg = assistant({
      summary: {
        additions: 0,
        deletions: 0,
        files: 0,
      },
      finish: "stop",
      error: undefined,
      tokens: {
        input: 20_000,
        output: 220,
        reasoning: 0,
        cache: {
          read: 400,
          write: 0,
        },
      },
    })

    expect(getUsedTokens(msg)).toBe(220)
  })

  test("uses input plus cache read for normal assistant messages", () => {
    const msg = assistant({
      finish: "stop",
      tokens: {
        input: 1500,
        output: 250,
        reasoning: 0,
        cache: {
          read: 125,
          write: 0,
        },
      },
    })

    expect(getUsedTokens(msg)).toBe(1625)
  })

  test("handles missing cache tokens", () => {
    const msg = assistant({
      tokens: {
        input: 900,
        output: 75,
        reasoning: 0,
      },
    })

    expect(getUsedTokens(msg)).toBe(900)
  })
})
