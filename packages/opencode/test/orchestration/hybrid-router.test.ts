import { describe, expect, test } from "bun:test"
import { route, formatAsk } from "../../src/orchestration/hybrid-router"
import type { PreflightResult, HybridRoutingConfig, ModelRef } from "../../src/orchestration/hybrid-types"

const local: ModelRef = { providerID: "ollama", modelID: "llama3" }
const cloud: ModelRef = { providerID: "anthropic", modelID: "claude-3-5-sonnet" }
const base: ModelRef = { providerID: "anthropic", modelID: "claude-3-5-sonnet" }

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

describe("orchestration/hybrid-router", () => {
  describe("route", () => {
    test("branch 1: preflight undefined → cloud, override_reason=preflight_unavailable", () => {
      const d = route(undefined, base, cfg, false)
      expect(d.target).toBe("cloud")
      expect(d.model).toEqual(cloud)
      expect(d.override_reason).toBe("preflight_unavailable")
    })

    test("branch 2: info_gap=high → ask, ask_text present", () => {
      const d = route(makePreflight({ info_gap: "high", ask_candidates: ["option A", "option B"] }), base, cfg, false)
      expect(d.target).toBe("ask")
      expect(d.ask_text).toBeDefined()
      expect(d.ask_text).toContain("I need more information to proceed")
    })

    test("branch 3: needs_code_change=true → cloud, override_reason=code_change", () => {
      const d = route(makePreflight({ needs_code_change: true }), base, cfg, false)
      expect(d.target).toBe("cloud")
      expect(d.model).toEqual(cloud)
      expect(d.override_reason).toBe("code_change")
    })

    test("branch 3: operation_type=code_change → cloud, override_reason=code_change", () => {
      const d = route(makePreflight({ operation_type: "code_change" }), base, cfg, false)
      expect(d.target).toBe("cloud")
      expect(d.model).toEqual(cloud)
      expect(d.override_reason).toBe("code_change")
    })

    test("branch 4: operation_type=read → local (confidence ignored)", () => {
      const d = route(makePreflight({ operation_type: "read", confidence: 0.1 }), base, cfg, false)
      expect(d.target).toBe("local")
      expect(d.model).toEqual(local)
    })

    test("branch 4: operation_type=bash_simple → local (confidence ignored)", () => {
      const d = route(makePreflight({ operation_type: "bash_simple", confidence: 0.1 }), base, cfg, false)
      expect(d.target).toBe("local")
      expect(d.model).toEqual(local)
    })

    test("branch 5: operation_type=bash_complex → cloud, override_reason=policy_bash_complex", () => {
      const d = route(makePreflight({ operation_type: "bash_complex" }), base, cfg, false)
      expect(d.target).toBe("cloud")
      expect(d.model).toEqual(cloud)
      expect(d.override_reason).toBe("policy_bash_complex")
    })

    test("branch 6: confidence=0.5 < threshold=0.7 → cloud, override_reason=low_confidence", () => {
      const d = route(makePreflight({ confidence: 0.5 }), base, cfg, false)
      expect(d.target).toBe("cloud")
      expect(d.model).toEqual(cloud)
      expect(d.override_reason).toBe("low_confidence")
    })

    test("branch 7: confidence=0.9, operation_type=other → local", () => {
      const d = route(makePreflight({ confidence: 0.9, operation_type: "other" }), base, cfg, false)
      expect(d.target).toBe("local")
      expect(d.model).toEqual(local)
    })

    test("explicit=true, routed model differs from base → was_overridden=true", () => {
      const differentBase: ModelRef = { providerID: "openai", modelID: "gpt-4o" }
      const d = route(makePreflight({ operation_type: "read" }), differentBase, cfg, true)
      expect(d.was_overridden).toBe(true)
    })

    test("explicit=false → was_overridden=false regardless", () => {
      const d = route(makePreflight({ operation_type: "read" }), base, cfg, false)
      expect(d.was_overridden).toBe(false)
    })

    test("explicit=true, routed model same as base → was_overridden=false", () => {
      // base === cloud, route to cloud
      const d = route(makePreflight({ needs_code_change: true }), cloud, cfg, true)
      expect(d.was_overridden).toBe(false)
    })

    test("assumptions propagated from preflight", () => {
      const d = route(makePreflight({ assumptions: ["a", "b"] }), base, cfg, false)
      expect(d.assumptions).toEqual(["a", "b"])
    })

    test("preflight attached to decision", () => {
      const p = makePreflight({ preflight_fallback: "configured" })
      const d = route(p, base, cfg, false)
      expect(d.preflight).toBe(p)
    })

    test("policy order: info_gap=high takes priority over needs_code_change", () => {
      const d = route(makePreflight({ info_gap: "high", needs_code_change: true }), base, cfg, false)
      expect(d.target).toBe("ask")
    })

    test("policy order: needs_code_change takes priority over operation_type=read", () => {
      const d = route(makePreflight({ needs_code_change: true, operation_type: "read" }), base, cfg, false)
      expect(d.target).toBe("cloud")
      expect(d.override_reason).toBe("code_change")
    })
  })

  describe("formatAsk", () => {
    test("with candidates → numbered list in fixed template", () => {
      const text = formatAsk(["option A", "option B"])
      expect(text).toContain("I need more information to proceed:")
      expect(text).toContain("1) option A")
      expect(text).toContain("2) option B")
      expect(text).toContain("Please clarify.")
    })

    test("with no candidates → missing placeholder in template", () => {
      const text = formatAsk([])
      expect(text).toContain("I need more information to proceed:")
      expect(text).toContain("Please clarify.")
    })

    test("with missing param → uses missing in template", () => {
      const text = formatAsk([], "the target environment")
      expect(text).toContain("Missing: the target environment")
    })

    test("template structure exact", () => {
      const text = formatAsk(["a", "b"], "x")
      expect(text).toMatch(/^I need more information to proceed:\n\n- Missing: x\n- Options:\n/)
      expect(text).toMatch(/Please clarify\.$/)
    })
  })
})
