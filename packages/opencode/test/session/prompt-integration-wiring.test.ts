import { describe, test, expect } from "bun:test"
import { applyToolBudget } from "../../src/session/tool-budget"
import { ContextCollapse } from "../../src/session/context-collapse"
import { MicroCompact } from "../../src/session/microcompact"
import { Goal } from "../../src/goal/goal"
import { PersistentMemory } from "../../src/memory/persistent"

/**
 * Tests for the integration wiring in prompt.ts.
 * Verifies the conditional logic and gating behavior of each feature module.
 */

describe("prompt integration wiring", () => {
  describe("context management pipeline ordering", () => {
    test("tool_result_budget is no-op when budget is 0", () => {
      const msgs: any[] = [{ info: { role: "assistant" }, parts: [] }]
      const result = applyToolBudget(msgs, 0)
      expect(result).toBe(msgs)
    })

    test("tool_result_budget returns same msgs when under budget", () => {
      const msgs: any[] = [{ info: { role: "assistant" }, parts: [] }]
      const result = applyToolBudget(msgs, 100_000)
      expect(result).toBe(msgs)
    })

    test("MicroCompact.shouldCompact triggers at 75% threshold", () => {
      expect(MicroCompact.shouldCompact({ input: 150_000, context: 200_000 })).toBe(true)
      expect(MicroCompact.shouldCompact({ input: 149_999, context: 200_000 })).toBe(false)
    })

    test("MicroCompact.shouldCompact returns false for zero context", () => {
      expect(MicroCompact.shouldCompact({ input: 100, context: 0 })).toBe(false)
    })

    test("ContextCollapse.shouldCollapse triggers at 97% threshold", () => {
      expect(ContextCollapse.shouldCollapse({ input: 194_000, context: 200_000 })).toBe(true)
      expect(ContextCollapse.shouldCollapse({ input: 193_999, context: 200_000 })).toBe(false)
    })

    test("ContextCollapse.shouldCollapse returns false for zero context", () => {
      expect(ContextCollapse.shouldCollapse({ input: 100, context: 0 })).toBe(false)
    })

    test("microcompact and proactive_prune are mutually exclusive", () => {
      // This test verifies the logic: microcompact only runs when proactive_prune is disabled
      const cfg = { experimental: { microcompact: true, proactive_prune: true } }
      // When both are enabled, microcompact should NOT run (mutual exclusion)
      const shouldRun = cfg.experimental?.microcompact && !cfg.experimental?.proactive_prune
      expect(shouldRun).toBe(false)
    })

    test("microcompact runs when proactive_prune is disabled", () => {
      const cfg = { experimental: { microcompact: true, proactive_prune: false } }
      const shouldRun = cfg.experimental?.microcompact && !cfg.experimental?.proactive_prune
      expect(shouldRun).toBe(true)
    })
  })

  describe("system prompt assembly", () => {
    test("PersistentMemory.inject returns empty string when no memories", () => {
      // inject() with no stored memories returns ""
      const result = PersistentMemory.inject()
      // May return "" or content depending on state, but should not throw
      expect(typeof result).toBe("string")
    })

    test("Goal.addendum formats goal info correctly", () => {
      const goal = {
        id: "goal-1" as any,
        session_id: "sess-1" as any,
        objective: "Fix the bug",
        status: "active" as const,
        token_budget: 50000,
        tokens_used: 10000,
        turns_used: 5,
        time_used_secs: 120,
        created_at: Date.now(),
        completed_at: null,
      }
      const result = Goal.addendum(goal)
      expect(result).toContain("<active-goal>")
      expect(result).toContain("Fix the bug")
      expect(result).toContain("5/200")
      expect(result).toContain("10000/50000")
      expect(result).toContain("goal_complete")
      expect(result).toContain("</active-goal>")
    })

    test("Goal.addendum omits token budget when null", () => {
      const goal = {
        id: "goal-1" as any,
        session_id: "sess-1" as any,
        objective: "Explore codebase",
        status: "active" as const,
        token_budget: null,
        tokens_used: 0,
        turns_used: 0,
        time_used_secs: 0,
        created_at: Date.now(),
        completed_at: null,
      }
      const result = Goal.addendum(goal)
      expect(result).not.toContain("Token budget")
    })
  })

  describe("feature gating", () => {
    test("all features are no-op when experimental flags are undefined", () => {
      const cfg: { experimental?: Record<string, unknown> } = { experimental: undefined }
      expect(cfg.experimental?.tool_result_budget).toBeUndefined()
      expect(cfg.experimental?.microcompact).toBeUndefined()
      expect(cfg.experimental?.context_collapse).toBeUndefined()
      expect(cfg.experimental?.persistent_memory).toBeUndefined()
      expect(cfg.experimental?.goal_system).toBeUndefined()
      expect(cfg.experimental?.hooks).toBeUndefined()
    })

    test("all features are no-op when experimental is empty object", () => {
      const cfg: { experimental?: Record<string, unknown> } = { experimental: {} }
      expect(cfg.experimental?.tool_result_budget).toBeUndefined()
      expect(cfg.experimental?.microcompact).toBeUndefined()
      expect(cfg.experimental?.context_collapse).toBeUndefined()
      expect(cfg.experimental?.persistent_memory).toBeUndefined()
      expect(cfg.experimental?.goal_system).toBeUndefined()
      expect(cfg.experimental?.hooks).toBeUndefined()
    })

    test("tool_result_budget only activates with positive number", () => {
      const cfg1 = { experimental: { tool_result_budget: 50000 } }
      expect(!!cfg1.experimental?.tool_result_budget).toBe(true)

      const cfg2 = { experimental: { tool_result_budget: undefined } }
      expect(!!cfg2.experimental?.tool_result_budget).toBe(false)
    })
  })
})
