import { expect, test, describe } from "bun:test"

// Unit tests for session-level cost/token aggregation logic
// Tests the pure aggregation logic extracted from aggregateSessionStats

type SessionTokens = {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

type MockSession = {
  id: string
  cost?: number
  tokens: SessionTokens
  time: { created: number; updated: number }
}

// Mirrors the accumulation logic in stats.ts after the change
function accumulate(sessions: MockSession[]) {
  const total = { cost: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  for (const s of sessions) {
    total.cost += s.cost ?? 0
    total.input += s.tokens.input ?? 0
    total.output += s.tokens.output ?? 0
    total.reasoning += s.tokens.reasoning ?? 0
    total.cacheRead += s.tokens.cache?.read ?? 0
    total.cacheWrite += s.tokens.cache?.write ?? 0
  }
  return total
}

describe("session-level cost/token accumulation", () => {
  test("sums cost from session.cost directly", () => {
    const sessions: MockSession[] = [
      { id: "a", cost: 0.05, tokens: { input: 100 }, time: { created: 1, updated: 2 } },
      { id: "b", cost: 0.1, tokens: { input: 200 }, time: { created: 1, updated: 2 } },
    ]
    const result = accumulate(sessions)
    expect(result.cost).toBeCloseTo(0.15)
  })

  test("falls back to 0 when cost is undefined", () => {
    const sessions: MockSession[] = [{ id: "a", cost: undefined, tokens: {}, time: { created: 1, updated: 2 } }]
    const result = accumulate(sessions)
    expect(result.cost).toBe(0)
  })

  test("sums all token fields with optional fallback", () => {
    const sessions: MockSession[] = [
      {
        id: "a",
        cost: 0.01,
        tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 20, write: 5 } },
        time: { created: 1, updated: 2 },
      },
      {
        id: "b",
        cost: 0.02,
        tokens: { input: 200, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 2 },
      },
    ]
    const result = accumulate(sessions)
    expect(result.input).toBe(300)
    expect(result.output).toBe(150)
    expect(result.reasoning).toBe(10)
    expect(result.cacheRead).toBe(20)
    expect(result.cacheWrite).toBe(5)
  })

  test("handles missing token sub-fields gracefully", () => {
    const sessions: MockSession[] = [
      { id: "a", cost: 0, tokens: {}, time: { created: 1, updated: 2 } },
      { id: "b", cost: 0, tokens: { input: 50 }, time: { created: 1, updated: 2 } },
      { id: "c", cost: 0, tokens: { cache: {} }, time: { created: 1, updated: 2 } },
    ]
    const result = accumulate(sessions)
    expect(result.input).toBe(50)
    expect(result.cacheRead).toBe(0)
    expect(result.cacheWrite).toBe(0)
  })

  test("empty sessions returns all zeros", () => {
    const result = accumulate([])
    expect(result.cost).toBe(0)
    expect(result.input).toBe(0)
    expect(result.output).toBe(0)
  })
})
