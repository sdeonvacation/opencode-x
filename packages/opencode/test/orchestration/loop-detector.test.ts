import { describe, expect, test } from "bun:test"
import { create } from "../../src/orchestration/loop-detector"

describe("orchestration/loop-detector", () => {
  test("detects after threshold identical records", () => {
    const detector = create({ threshold: 3 })
    detector.record({ toolName: "bash", input: { command: "ls" } })
    detector.record({ toolName: "bash", input: { command: "ls" } })

    expect(detector.detect({ toolName: "bash", input: { command: "ls" } })).toBe(false)

    detector.record({ toolName: "bash", input: { command: "ls" } })
    expect(detector.detect({ toolName: "bash", input: { command: "ls" } })).toBe(true)
  })

  test("does not false positive on mixed calls", () => {
    const detector = create({ threshold: 3 })
    detector.record({ toolName: "bash", input: { command: "ls" } })
    detector.record({ toolName: "read", input: { filePath: "/tmp/a" } })
    detector.record({ toolName: "bash", input: { command: "ls" } })

    expect(detector.detect({ toolName: "bash", input: { command: "ls" } })).toBe(false)
  })

  test("reset clears prior history", () => {
    const detector = create({ threshold: 2 })
    detector.record({ toolName: "bash", input: null })
    detector.record({ toolName: "bash", input: null })
    expect(detector.detect({ toolName: "bash", input: null })).toBe(true)

    detector.reset()

    expect(detector.detect({ toolName: "bash", input: null })).toBe(false)
  })

  test("supports custom thresholds and ring wrap", () => {
    const detector = create({ threshold: 5 })
    detector.record({ toolName: "bash", input: { command: "a" } })
    detector.record({ toolName: "bash", input: { command: "b" } })
    detector.record({ toolName: "bash", input: { command: "same", payload: { nested: true } } })
    detector.record({ toolName: "bash", input: { command: "same", payload: { nested: true } } })
    detector.record({ toolName: "bash", input: { command: "same", payload: { nested: true } } })
    detector.record({ toolName: "bash", input: { command: "same", payload: { nested: true } } })

    expect(detector.detect({ toolName: "bash", input: { command: "same", payload: { nested: true } } })).toBe(false)

    detector.record({ toolName: "bash", input: { command: "same", payload: { nested: true } } })
    expect(detector.detect({ toolName: "bash", input: { command: "same", payload: { nested: true } } })).toBe(true)
  })

  test("threshold of one detects immediately", () => {
    const detector = create({ threshold: 1 })
    detector.record({ toolName: "read", input: { filePath: "/tmp/x", extra: [] } })

    expect(detector.detect({ toolName: "read", input: { filePath: "/tmp/x", extra: [] } })).toBe(true)
  })
})
