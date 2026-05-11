import { describe, test, expect } from "bun:test"

// Pure unit tests for the memory injection formatting logic used in prompt.ts:
//   if (agent.mode === "primary") {
//     if (memory.length > 0) system.push("Session Memory:\n" + memory.map(m => `- ${m.content}`).join("\n"))
//   }

function formatMemory(entries: { content: string }[]): string | null {
  if (entries.length === 0) return null
  return "Session Memory:\n" + entries.map((e) => `- ${e.content}`).join("\n")
}

describe("prompt memory injection format", () => {
  test("formats single entry as labeled block", () => {
    expect(formatMemory([{ content: "foo" }])).toBe("Session Memory:\n- foo")
  })

  test("formats multiple entries as labeled block", () => {
    expect(formatMemory([{ content: "foo" }, { content: "bar" }])).toBe("Session Memory:\n- foo\n- bar")
  })

  test("empty entries returns null (no block appended)", () => {
    expect(formatMemory([])).toBeNull()
  })

  test("entries with special characters are preserved", () => {
    const result = formatMemory([{ content: "use `bun` not `npm`" }, { content: "prefer Effect.fn" }])
    expect(result).toBe("Session Memory:\n- use `bun` not `npm`\n- prefer Effect.fn")
  })

  test("single entry formats correctly", () => {
    const result = formatMemory([{ content: "only one" }])
    expect(result).toBe("Session Memory:\n- only one")
    expect(result).not.toContain("\n- only one\n")
  })
})

describe("prompt memory injection condition", () => {
  test("non-primary agent mode skips injection", () => {
    // Mirrors: if (agent.mode === "primary") { ... }
    const modes = ["subagent", "task", "code", ""] as const
    for (const mode of modes) {
      const system: string[] = []
      const memory = [{ content: "secret" }]
      if ((mode as string) === "primary") {
        if (memory.length > 0) system.push("Session Memory:\n" + memory.map((m) => `- ${m.content}`).join("\n"))
      }
      expect(system).toHaveLength(0)
    }
  })

  test("primary agent with memory appends block", () => {
    const system: string[] = []
    const memory = [{ content: "remember this" }]
    const mode = "primary"
    if (mode === "primary") {
      if (memory.length > 0) system.push("Session Memory:\n" + memory.map((m) => `- ${m.content}`).join("\n"))
    }
    expect(system).toHaveLength(1)
    expect(system[0]).toBe("Session Memory:\n- remember this")
  })

  test("primary agent with empty memory appends nothing", () => {
    const system: string[] = []
    const memory: { content: string }[] = []
    const mode = "primary"
    if (mode === "primary") {
      if (memory.length > 0) system.push("Session Memory:\n" + memory.map((m) => `- ${m.content}`).join("\n"))
    }
    expect(system).toHaveLength(0)
  })
})
