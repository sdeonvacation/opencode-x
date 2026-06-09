import { describe, expect, test } from "bun:test"
import { Swarm, SwarmEvent } from "../../src/swarm"

describe("swarm/index", () => {
  describe("template renderer", () => {
    test("replaces single placeholder", () => {
      const result = Swarm.render("Fix {{file}}", { file: "a.ts" })
      expect(result).toBe("Fix a.ts")
    })

    test("replaces multiple placeholders", () => {
      const result = Swarm.render("Fix {{file}} in {{dir}}", { file: "a.ts", dir: "src" })
      expect(result).toBe("Fix a.ts in src")
    })

    test("replaces repeated placeholder", () => {
      const result = Swarm.render("{{x}} and {{x}}", { x: "1" })
      expect(result).toBe("1 and 1")
    })

    test("throws on missing key", () => {
      expect(() => Swarm.render("{{missing}}", {})).toThrow("Missing placeholder key: {{missing}}")
    })

    test("leaves non-placeholder text intact", () => {
      const result = Swarm.render("no placeholders here", {})
      expect(result).toBe("no placeholders here")
    })
  })

  describe("placeholders", () => {
    test("extracts unique keys", () => {
      expect(Swarm.placeholders("{{a}} and {{b}} and {{a}}")).toEqual(["a", "b"])
    })

    test("returns empty for no placeholders", () => {
      expect(Swarm.placeholders("no placeholders")).toEqual([])
    })
  })

  describe("validate", () => {
    test("returns error for template without placeholders", () => {
      const errors = Swarm.validate("no placeholders", [{ id: "1", input: {} }])
      expect(errors).toEqual(["Template contains no {{placeholders}}"])
    })

    test("returns empty for valid items", () => {
      const errors = Swarm.validate("Fix {{file}}", [
        { id: "1", input: { file: "a.ts" } },
        { id: "2", input: { file: "b.ts" } },
      ])
      expect(errors).toEqual([])
    })

    test("detects missing keys across items", () => {
      const errors = Swarm.validate("{{file}} in {{dir}}", [
        { id: "1", input: { file: "a.ts" } },
        { id: "2", input: { file: "b.ts", dir: "src" } },
      ])
      expect(errors).toEqual(['Item "1" missing key "dir"'])
    })

    test("detects multiple missing keys", () => {
      const errors = Swarm.validate("{{a}} {{b}}", [{ id: "x", input: {} }])
      expect(errors).toEqual(['Item "x" missing key "a"', 'Item "x" missing key "b"'])
    })
  })

  describe("state machine", () => {
    const config: Swarm.Config = {
      template: "Fix {{file}}",
      items: [
        { id: "1", input: { file: "a.ts" } },
        { id: "2", input: { file: "b.ts" } },
        { id: "3", input: { file: "c.ts" } },
      ],
      agent: "general",
      concurrency: 5,
      background: false,
    }

    test("start creates active state", () => {
      const state = Swarm.start(config)
      expect(state.status).toBe("active")
      expect(state.results).toEqual([])
      expect(state.config).toBe(config)
      expect(state.started).toBeGreaterThan(0)
    })

    test("itemDone with partial stays active", () => {
      const state = Swarm.start(config)
      const next = Swarm.itemDone(state, {
        id: "1",
        status: "done",
        output: "ok",
        duration: 100,
      })
      expect(next.status).toBe("active")
      expect(next.results).toHaveLength(1)
      expect(Swarm.isComplete(next)).toBe(false)
    })

    test("itemDone with last item transitions to completing", () => {
      let state = Swarm.start(config)
      state = Swarm.itemDone(state, { id: "1", status: "done", output: "ok", duration: 100 })
      state = Swarm.itemDone(state, { id: "2", status: "done", output: "ok", duration: 100 })
      state = Swarm.itemDone(state, { id: "3", status: "done", output: "ok", duration: 100 })
      expect(state.status).toBe("completing")
      expect(Swarm.isComplete(state)).toBe(true)
    })

    test("error result doesnt break state transition", () => {
      let state = Swarm.start(config)
      state = Swarm.itemDone(state, { id: "1", status: "error", output: "fail", duration: 50 })
      state = Swarm.itemDone(state, { id: "2", status: "done", output: "ok", duration: 100 })
      state = Swarm.itemDone(state, { id: "3", status: "done", output: "ok", duration: 100 })
      expect(state.status).toBe("completing")
      expect(Swarm.isComplete(state)).toBe(true)
      expect(state.results.filter((r) => r.status === "error")).toHaveLength(1)
    })
  })

  describe("events", () => {
    test("SwarmEvent.Started is defined", () => {
      expect(SwarmEvent.Started.type).toBe("swarm.started")
    })

    test("SwarmEvent.ItemComplete is defined", () => {
      expect(SwarmEvent.ItemComplete.type).toBe("swarm.item-complete")
    })

    test("SwarmEvent.Done is defined", () => {
      expect(SwarmEvent.Done.type).toBe("swarm.done")
    })
  })
})
