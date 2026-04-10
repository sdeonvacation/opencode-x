import { describe, expect, test } from "bun:test"
import { create } from "../../src/session/doom-loop"

describe("session/doom-loop", () => {
  test("detect returns false on fresh detector", () => {
    const detector = create()
    expect(detector.detect({ toolName: "bash", input: { command: "ls" } })).toBe(false)
  })

  test("detect returns true after threshold identical records", () => {
    const detector = create({ threshold: 3 })
    detector.record({ toolName: "bash", input: { command: "ls" } })
    detector.record({ toolName: "bash", input: { command: "ls" } })
    detector.record({ toolName: "bash", input: { command: "ls" } })

    expect(detector.detect({ toolName: "bash", input: { command: "ls" } })).toBe(true)
  })

  test("detect uses only the last threshold records", () => {
    const detector = create({ threshold: 3 })
    detector.record({ toolName: "bash", input: { command: "a" } })
    detector.record({ toolName: "bash", input: { command: "b" } })
    detector.record({ toolName: "bash", input: { command: "c" } })
    detector.record({ toolName: "bash", input: { command: "same" } })
    detector.record({ toolName: "bash", input: { command: "same" } })
    detector.record({ toolName: "bash", input: { command: "same" } })

    expect(detector.detect({ toolName: "bash", input: { command: "same" } })).toBe(true)
    expect(detector.detect({ toolName: "bash", input: { command: "c" } })).toBe(false)
  })

  test("detect differentiates tool name and input", () => {
    const detector = create({ threshold: 3 })
    detector.record({ toolName: "bash", input: { command: "ls" } })
    detector.record({ toolName: "bash", input: { command: "ls" } })
    detector.record({ toolName: "bash", input: { command: "ls" } })

    expect(detector.detect({ toolName: "grep", input: { command: "ls" } })).toBe(false)
    expect(detector.detect({ toolName: "bash", input: { command: "pwd" } })).toBe(false)
  })

  test("detect returns false for different calls", () => {
    const detector = create({ threshold: 3 })
    detector.record({ toolName: "bash", input: { command: "ls" } })
    detector.record({ toolName: "grep", input: { command: "ls" } })
    detector.record({ toolName: "bash", input: { command: "pwd" } })

    expect(detector.detect({ toolName: "bash", input: { command: "ls" } })).toBe(false)
  })

  test("detect honors custom threshold", () => {
    const detector = create({ threshold: 5 })
    for (let i = 0; i < 4; i++) {
      detector.record({ toolName: "bash", input: { command: "ls" } })
    }
    expect(detector.detect({ toolName: "bash", input: { command: "ls" } })).toBe(false)

    detector.record({ toolName: "bash", input: { command: "ls" } })
    expect(detector.detect({ toolName: "bash", input: { command: "ls" } })).toBe(true)
  })
})
