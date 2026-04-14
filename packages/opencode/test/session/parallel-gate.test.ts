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

describe("session.llm.parallelGate", () => {
  test("returns true for subagent when all tools are parallel-safe and allowed", () => {
    expect(
      LLM.parallelGate({
        agent: agent("subagent"),
        permission: [],
        cfg: cfg(),
        toolMeta: meta([
          ["grep", true],
          ["glob", true],
        ]),
      }),
    ).toBe(true)
  })

  test("returns false when any tool is not parallel-safe", () => {
    expect(
      LLM.parallelGate({
        agent: agent("subagent"),
        permission: [],
        cfg: cfg(),
        toolMeta: meta([
          ["grep", true],
          ["bash", false],
        ]),
      }),
    ).toBe(false)
  })

  test("returns false when permission resolves to ask", () => {
    expect(
      LLM.parallelGate({
        agent: agent("subagent", [{ permission: "grep", pattern: "*", action: "ask" }]),
        permission: [],
        cfg: cfg(),
        toolMeta: meta([["grep", true]]),
      }),
    ).toBe(false)
  })

  test("returns true when OPENCODE_PERMISSION allow-all overrides session ask", () => {
    const prev = process.env.OPENCODE_PERMISSION
    process.env.OPENCODE_PERMISSION = '{"*":"allow"}'

    try {
      expect(
        LLM.parallelGate({
          agent: agent("subagent"),
          permission: [{ permission: "grep", pattern: "*", action: "ask" }],
          cfg: cfg(),
          toolMeta: meta([["grep", true]]),
        }),
      ).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_PERMISSION
      else process.env.OPENCODE_PERMISSION = prev
    }
  })

  test("returns false when permission resolves to deny", () => {
    expect(
      LLM.parallelGate({
        agent: agent("subagent", [{ permission: "grep", pattern: "*", action: "deny" }]),
        permission: [],
        cfg: cfg(),
        toolMeta: meta([["grep", true]]),
      }),
    ).toBe(false)
  })

  test("returns false when a path-scoped non-allow rule exists even if wildcard permission allows", () => {
    expect(
      LLM.parallelGate({
        agent: agent("subagent", [
          { permission: "grep", pattern: "*", action: "allow" },
          { permission: "grep", pattern: "src/**", action: "ask" },
        ]),
        permission: [{ permission: "grep", pattern: "*", action: "allow" }],
        cfg: cfg(),
        toolMeta: meta([["grep", true]]),
      }),
    ).toBe(false)
  })

  test("returns false when config disables parallel tool calls", () => {
    expect(
      LLM.parallelGate({
        agent: agent("subagent"),
        permission: [],
        cfg: cfg({ parallel_tool_calls: false }),
        toolMeta: meta([["grep", true]]),
      }),
    ).toBe(false)
  })

  test("returns false for primary agent by default", () => {
    expect(
      LLM.parallelGate({
        agent: agent("primary"),
        permission: [],
        cfg: cfg(),
        toolMeta: meta([["grep", true]]),
      }),
    ).toBe(false)
  })

  test("returns true for primary agent when explicitly enabled", () => {
    expect(
      LLM.parallelGate({
        agent: agent("primary"),
        permission: [],
        cfg: cfg({ parallel_tool_calls: true }),
        toolMeta: meta([["grep", true]]),
      }),
    ).toBe(true)
  })

  test("returns false when there are no active tools", () => {
    expect(
      LLM.parallelGate({
        agent: agent("subagent"),
        permission: [],
        cfg: cfg(),
        toolMeta: new Map(),
      }),
    ).toBe(false)
  })

  test("returns false for read when parallel_read is disabled", () => {
    expect(
      LLM.parallelGate({
        agent: agent("subagent"),
        permission: [],
        cfg: cfg(),
        toolMeta: meta([["read", true]]),
      }),
    ).toBe(false)
  })

  test("returns true for read when parallel_read is enabled", () => {
    expect(
      LLM.parallelGate({
        agent: agent("subagent"),
        permission: [],
        cfg: cfg({ parallel_read: true }),
        toolMeta: meta([["read", true]]),
      }),
    ).toBe(true)
  })
})
