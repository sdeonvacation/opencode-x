import { expect, test, describe } from "bun:test"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import type { Session } from "@opencode-ai/sdk/v2"

function makeSession(id: string, cost: number): Session {
  return {
    id,
    slug: id,
    projectID: "proj",
    directory: "/tmp",
    title: "test",
    version: "1",
    time: { created: 1, updated: 2 },
    cost,
    tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

describe("plugin api session.get", () => {
  test("returns session by id", () => {
    const s = makeSession("sess-1", 0.05)
    const api = createTuiPluginApi({
      state: {
        session: {
          get: (id) => (id === "sess-1" ? s : undefined),
        },
      },
    })
    expect(api.state.session.get("sess-1")).toBe(s)
  })

  test("returns undefined for unknown id", () => {
    const api = createTuiPluginApi()
    expect(api.state.session.get("unknown")).toBeUndefined()
  })

  test("cost accessed via optional chaining returns 0 for missing session", () => {
    const api = createTuiPluginApi()
    const cost = api.state.session.get("missing")?.cost ?? 0
    expect(cost).toBe(0)
  })

  test("cost accessed via optional chaining returns session cost", () => {
    const s = makeSession("sess-2", 0.42)
    const api = createTuiPluginApi({
      state: {
        session: {
          get: (id) => (id === "sess-2" ? s : undefined),
        },
      },
    })
    const cost = api.state.session.get("sess-2")?.cost ?? 0
    expect(cost).toBeCloseTo(0.42)
  })
})

describe("sidebar context cost logic", () => {
  test("cost = session.cost + clearedCost", () => {
    const s = makeSession("sess-3", 0.1)
    const kv: Record<string, unknown> = { "cleared_cost_sess-3": 0.05 }
    const api = createTuiPluginApi({
      state: {
        session: {
          get: (id) => (id === "sess-3" ? s : undefined),
        },
      },
    })
    // Simulate the sidebar cost formula
    const sessionCost = api.state.session.get("sess-3")?.cost ?? 0
    const clearedCost = (kv["cleared_cost_sess-3"] as number) ?? 0
    expect(sessionCost + clearedCost).toBeCloseTo(0.15)
  })

  test("cost = session.cost when no cleared cost", () => {
    const s = makeSession("sess-4", 0.25)
    const api = createTuiPluginApi({
      state: {
        session: {
          get: (id) => (id === "sess-4" ? s : undefined),
        },
      },
    })
    const sessionCost = api.state.session.get("sess-4")?.cost ?? 0
    const clearedCost = 0 // no cleared cost in kv
    expect(sessionCost + clearedCost).toBeCloseTo(0.25)
  })
})
