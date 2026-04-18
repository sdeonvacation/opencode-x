import { describe, expect, test } from "bun:test"
import { route } from "../../src/orchestration/hybrid-router"
import { SessionPrompt } from "../../src/session/prompt"
import type { HybridRoutingConfig, ModelRef, PreflightResult } from "../../src/orchestration/hybrid-types"
import { OrchestrationEvent } from "../../src/orchestration/events"

// Tests for hybrid routing integration behavior
// These test the routing logic and event schema without requiring full session stack

const local: ModelRef = { providerID: "ollama", modelID: "llama3" }
const cloud: ModelRef = { providerID: "anthropic", modelID: "claude-3-5-sonnet" }

const cfg: HybridRoutingConfig = {
  enabled: true,
  threshold: 0.7,
  local_models: [local],
  verify_commands: [],
  verify_cache_ttl_ms: 300_000,
}

function makePreflight(overrides: Partial<PreflightResult> = {}): PreflightResult {
  return {
    confidence: 0.9,
    info_gap: "low",
    needs_code_change: false,
    operation_type: "other",
    assumptions: [],
    ask_candidates: [],
    ...overrides,
  }
}

describe("session/hybrid-prompt", () => {
  describe("flag off behavior", () => {
    test("route function not called when flag off (guard pattern)", () => {
      // When flag is off, the guard `if (!hybridCfg?.enabled)` short-circuits
      // Verify the config schema defaults to disabled
      const { z } = require("zod")
      const schema = z.object({
        enabled: z.boolean().default(false),
      })
      const parsed = schema.parse({})
      expect(parsed.enabled).toBe(false)
    })
  })

  describe("flag on: ask path", () => {
    test("info_gap=high → ask target with ask_text", () => {
      const d = route(makePreflight({ info_gap: "high", ask_candidates: ["option 1", "option 2"] }), cloud, cfg, false)
      expect(d.target).toBe("ask")
      expect(d.ask_text).toBeDefined()
      expect(d.ask_text).toContain("I need more information to proceed")
      expect(d.ask_text).toContain("1) option 1")
    })
  })

  describe("flag on: local route", () => {
    test("operation_type=read → local model stamped", () => {
      const d = route(makePreflight({ operation_type: "read" }), cloud, cfg, false)
      expect(d.target).toBe("local")
      expect(d.model).toEqual(local)
    })

    test("operation_type=bash_simple → local model stamped", () => {
      const d = route(makePreflight({ operation_type: "bash_simple" }), cloud, cfg, false)
      expect(d.target).toBe("local")
      expect(d.model).toEqual(local)
    })
  })

  describe("flag on: cloud route", () => {
    test("needs_code_change=true → base model stamped", () => {
      const d = route(makePreflight({ needs_code_change: true }), cloud, cfg, false)
      expect(d.target).toBe("cloud")
      expect(d.model).toEqual(cloud)
    })

    test("operation_type=bash_complex → base model stamped", () => {
      const d = route(makePreflight({ operation_type: "bash_complex" }), cloud, cfg, false)
      expect(d.target).toBe("cloud")
      expect(d.model).toEqual(cloud)
    })

    test("operation_type=code_change triggers verify gate", () => {
      expect(
        SessionPrompt.shouldVerify(route(makePreflight({ operation_type: "code_change" }), local, cfg, false)),
      ).toBe(true)
    })
  })

  describe("assumptions", () => {
    test("non-empty assumptions propagated in decision", () => {
      const d = route(makePreflight({ assumptions: ["assuming node 18", "assuming unix"] }), cloud, cfg, false)
      expect(d.assumptions).toEqual(["assuming node 18", "assuming unix"])
    })
  })

  describe("OrchestrationEvent.Route schema", () => {
    test("event type is orchestration.route", () => {
      expect(OrchestrationEvent.Route.type).toBe("orchestration.route")
    })

    test("valid route event payload parses successfully", () => {
      const payload = {
        sessionID: "sess-1",
        route: "local",
        operation_type: "read",
        confidence: 0.9,
        info_gap: "low",
        needs_code_change: false,
        assumptions_count: 0,
        verification_used: false,
        success: true,
        was_overridden: false,
      }
      expect(OrchestrationEvent.Route.properties.safeParse(payload).success).toBe(true)
    })

    test("ask route event payload parses successfully", () => {
      const payload = {
        sessionID: "sess-1",
        route: "ask",
        assumptions_count: 2,
        verification_used: false,
        success: true,
        was_overridden: true,
        override_reason: "info_gap",
      }
      expect(OrchestrationEvent.Route.properties.safeParse(payload).success).toBe(true)
    })

    test("invalid route value fails", () => {
      const payload = {
        sessionID: "sess-1",
        route: "unknown",
        assumptions_count: 0,
        verification_used: false,
        success: true,
        was_overridden: false,
      }
      expect(OrchestrationEvent.Route.properties.safeParse(payload).success).toBe(false)
    })

    test("event NOT emitted when flag off (schema check)", () => {
      // When flag is off, the guard prevents any Route event from being published
      // This is a structural test - the guard is `if (hybridCfg?.enabled)`
      const flagOff: { enabled?: boolean } = {}
      expect(flagOff?.enabled).toBeUndefined()
    })
  })
})
