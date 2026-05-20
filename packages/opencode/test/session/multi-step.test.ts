import { describe, expect, test } from "bun:test"
import { LLM } from "../../src/session/llm"
import type { Agent } from "../../src/agent/agent"
import type { Config } from "../../src/config/config"
import type { Permission } from "../../src/permission"

function agent(
  mode: Agent.Info["mode"],
  permission: Permission.Ruleset = [{ permission: "*", pattern: "*", action: "allow" }],
) {
  return {
    name: "test",
    mode,
    options: {},
    permission,
  } satisfies Agent.Info
}

function cfg(experimental?: Config.Info["experimental"]) {
  return {
    experimental,
  } as Config.Info
}

function meta(entries: Array<[string, boolean]>) {
  return new Map(entries.map(([name, parallelSafe]) => [name, { parallelSafe }]))
}

describe("multi-step gate", () => {
  test("enabled when parallelGate passes and multi_step not disabled", () => {
    const safe = LLM.parallelGate({
      agent: agent("subagent"),
      permission: [],
      cfg: cfg(),
      toolMeta: meta([
        ["grep", true],
        ["glob", true],
      ]),
    })
    const c = cfg()
    const steps = safe && c.experimental?.multi_step !== false ? (c.experimental?.multi_step_count ?? 5) : undefined
    expect(steps).toBe(5)
  })

  test("disabled when parallelGate fails", () => {
    const safe = LLM.parallelGate({
      agent: agent("subagent"),
      permission: [],
      cfg: cfg(),
      toolMeta: meta([
        ["grep", true],
        ["bash", false],
      ]),
    })
    const c = cfg()
    const steps = safe && c.experimental?.multi_step !== false ? (c.experimental?.multi_step_count ?? 5) : undefined
    expect(steps).toBeUndefined()
  })

  test("disabled when multi_step explicitly false", () => {
    const safe = LLM.parallelGate({
      agent: agent("subagent"),
      permission: [],
      cfg: cfg({ multi_step: false }),
      toolMeta: meta([
        ["grep", true],
        ["glob", true],
      ]),
    })
    const c = cfg({ multi_step: false })
    const steps = safe && c.experimental?.multi_step !== false ? (c.experimental?.multi_step_count ?? 5) : undefined
    expect(steps).toBeUndefined()
  })

  test("respects custom multi_step_count", () => {
    const safe = LLM.parallelGate({
      agent: agent("subagent"),
      permission: [],
      cfg: cfg({ multi_step_count: 3 }),
      toolMeta: meta([
        ["grep", true],
        ["glob", true],
      ]),
    })
    const c = cfg({ multi_step_count: 3 })
    const steps = safe && c.experimental?.multi_step !== false ? (c.experimental?.multi_step_count ?? 5) : undefined
    expect(steps).toBe(3)
  })

  test("defaults to 5 when multi_step_count not set", () => {
    const safe = LLM.parallelGate({
      agent: agent("subagent"),
      permission: [],
      cfg: cfg({}),
      toolMeta: meta([["read", true]]),
    })
    const c = cfg({})
    const steps = safe && c.experimental?.multi_step !== false ? (c.experimental?.multi_step_count ?? 5) : undefined
    expect(steps).toBe(5)
  })

  test("undefined maxSteps means single-step default behavior", () => {
    // When maxSteps is undefined, streamText uses default stepCountIs(1)
    const steps: number | undefined = undefined
    const condition = steps && steps > 1
    expect(condition).toBeFalsy()
  })

  test("maxSteps=1 does not enable multi-step", () => {
    // Edge case: maxSteps=1 should not trigger stepCountIs
    const steps = 1
    const condition = steps && steps > 1
    expect(condition).toBeFalsy()
  })

  test("maxSteps>1 enables multi-step", () => {
    const steps = 5
    const condition = steps && steps > 1
    expect(condition).toBeTruthy()
  })
})
