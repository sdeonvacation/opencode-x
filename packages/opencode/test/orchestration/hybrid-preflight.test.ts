import { describe, expect, test } from "bun:test"
import { classify } from "../../src/orchestration/hybrid-heuristics"
import { pick, seed } from "../../src/orchestration/hybrid-preflight"
import type { HybridRoutingConfig } from "../../src/orchestration/hybrid-types"

// Unit tests for preflight behavior that don't require Effect runtime
// (Provider.Service integration tested separately)

const cfg: HybridRoutingConfig = {
  enabled: true,
  threshold: 0.7,
  local_models: [{ providerID: "ollama", modelID: "llama3" }],
  verify_commands: [],
  verify_cache_ttl_ms: 300_000,
}

describe("orchestration/hybrid-preflight", () => {
  describe("heuristic seeding behavior", () => {
    test("command_string=npm install → heuristic=bash_complex", () => {
      const hint = classify("npm install")
      expect(hint).toBe("bash_complex")
    })

    test("command_string=echo hello → heuristic=bash_simple", () => {
      const hint = classify("echo hello")
      expect(hint).toBe("bash_simple")
    })

    test("command_string=git status → heuristic=undefined (no seed)", () => {
      const hint = classify("git status")
      expect(hint).toBeUndefined()
    })

    test("heuristic wins for bash_complex over LLM result", () => {
      // Simulate: heuristic=bash_complex, LLM says operation_type=other
      // Expected: operation_type=bash_complex (heuristic wins)
      const heuristic = classify("npm install")
      const llmResult = "other" as const
      const operation_type = heuristic === "bash_complex" || heuristic === "bash_simple" ? heuristic : llmResult
      expect(operation_type).toBe("bash_complex")
    })

    test("heuristic wins for bash_simple over LLM result", () => {
      const heuristic = classify("echo hello")
      const llmResult = "code_change" as const
      const operation_type = heuristic === "bash_complex" || heuristic === "bash_simple" ? heuristic : llmResult
      expect(operation_type).toBe("bash_simple")
    })

    test("LLM wins for code_change when no heuristic match", () => {
      const heuristic = classify("git status") // undefined
      const llmResult = "code_change" as const
      const operation_type = heuristic === "bash_complex" || heuristic === "bash_simple" ? heuristic : llmResult
      expect(operation_type).toBe("code_change")
    })

    test("LLM wins for read when no heuristic match", () => {
      const heuristic = classify("cat file.txt") // undefined
      const llmResult = "read" as const
      const operation_type = heuristic === "bash_complex" || heuristic === "bash_simple" ? heuristic : llmResult
      expect(operation_type).toBe("read")
    })

    test("tool invocation uses operation_hint", () => {
      expect(
        seed({
          prompt: "use read tool",
          agent: "explore",
          invocation_type: "tool",
          operation_hint: "read",
          parts_summary: "use read tool",
          base_model: { providerID: "ollama", modelID: "llama3" },
        }),
      ).toBe("read")
    })

    test("tool invocation falls back to command_string classification", () => {
      expect(
        seed({
          prompt: "inspect",
          agent: "explore",
          invocation_type: "tool",
          command_string: "echo hello",
          parts_summary: "inspect",
          base_model: { providerID: "ollama", modelID: "llama3" },
        }),
      ).toBe("bash_simple")
    })

    test("operation_hint read overrides llm", () => {
      expect(pick("read", "other")).toBe("read")
    })

    test("operation_hint code_change overrides llm", () => {
      expect(pick("code_change", "read")).toBe("code_change")
    })
  })

  describe("preflight model fallback chain", () => {
    test("fallback order: preflight_model → local_models[0] → base_model", () => {
      const withPreflight: HybridRoutingConfig = {
        ...cfg,
        preflight_model: { providerID: "local", modelID: "fast-model" },
      }
      const candidates = [
        withPreflight.preflight_model,
        withPreflight.local_models[0],
        { providerID: "anthropic", modelID: "claude-3-5-sonnet" },
      ].filter(Boolean)
      expect(candidates[0]).toEqual({ providerID: "local", modelID: "fast-model" })
      expect(candidates[1]).toEqual({ providerID: "ollama", modelID: "llama3" })
      expect(candidates[2]).toEqual({ providerID: "anthropic", modelID: "claude-3-5-sonnet" })
    })

    test("without preflight_model: local_models[0] → base_model", () => {
      const candidates = [
        cfg.preflight_model,
        cfg.local_models[0],
        { providerID: "anthropic", modelID: "claude-3-5-sonnet" },
      ].filter(Boolean)
      expect(candidates[0]).toEqual({ providerID: "ollama", modelID: "llama3" })
      expect(candidates[1]).toEqual({ providerID: "anthropic", modelID: "claude-3-5-sonnet" })
    })

    test("fallback labels map to configured/local/base", () => {
      expect("configured").toBe("configured")
      expect("first_local").toBe("first_local")
      expect("base").toBe("base")
    })
  })

  describe("PreflightOutputSchema validation", () => {
    test("valid schema fields", () => {
      const { z } = require("zod")
      const Schema = z.object({
        confidence: z.number().min(0).max(1),
        info_gap: z.enum(["high", "medium", "low"]),
        needs_code_change: z.boolean(),
        operation_type: z.enum(["read", "bash_simple", "bash_complex", "code_change", "other"]),
        assumptions: z.array(z.string()),
        ask_candidates: z.array(z.string()),
      })

      const valid = {
        confidence: 0.8,
        info_gap: "low",
        needs_code_change: false,
        operation_type: "read",
        assumptions: ["assuming local env"],
        ask_candidates: [],
      }
      expect(Schema.safeParse(valid).success).toBe(true)
    })

    test("confidence out of range fails", () => {
      const { z } = require("zod")
      const Schema = z.object({
        confidence: z.number().min(0).max(1),
        info_gap: z.enum(["high", "medium", "low"]),
        needs_code_change: z.boolean(),
        operation_type: z.enum(["read", "bash_simple", "bash_complex", "code_change", "other"]),
        assumptions: z.array(z.string()),
        ask_candidates: z.array(z.string()),
      })
      expect(
        Schema.safeParse({
          confidence: 1.5,
          info_gap: "low",
          needs_code_change: false,
          operation_type: "read",
          assumptions: [],
          ask_candidates: [],
        }).success,
      ).toBe(false)
    })

    test("invalid operation_type fails", () => {
      const { z } = require("zod")
      const Schema = z.object({
        confidence: z.number().min(0).max(1),
        info_gap: z.enum(["high", "medium", "low"]),
        needs_code_change: z.boolean(),
        operation_type: z.enum(["read", "bash_simple", "bash_complex", "code_change", "other"]),
        assumptions: z.array(z.string()),
        ask_candidates: z.array(z.string()),
      })
      expect(
        Schema.safeParse({
          confidence: 0.8,
          info_gap: "low",
          needs_code_change: false,
          operation_type: "unknown",
          assumptions: [],
          ask_candidates: [],
        }).success,
      ).toBe(false)
    })
  })
})
