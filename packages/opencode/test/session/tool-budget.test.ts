import { describe, test, expect } from "bun:test"
import { applyToolBudget } from "../../src/session/tool-budget"
import type { MessageV2 } from "../../src/session/message-v2"

function msg(parts: MessageV2.Part[]): MessageV2.WithParts {
  return {
    info: {
      role: "assistant",
      id: "msg-1",
      sessionID: "sess-1",
      time: { created: Date.now() },
      parentID: "msg-0",
      modelID: "test-model",
      providerID: "test-provider",
      mode: "code",
      agent: "code",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } as MessageV2.Assistant,
    parts,
  }
}

function tool(output: string, idx = 0): MessageV2.ToolPart {
  return {
    id: `part-${idx}` as any,
    sessionID: "sess-1" as any,
    messageID: "msg-1" as any,
    type: "tool",
    callID: `call-${idx}`,
    tool: "bash",
    state: {
      status: "completed",
      input: { command: "echo hi" },
      output,
      title: "bash",
      metadata: {},
      time: { start: 1000, end: 2000 },
    },
  }
}

function text(value: string): MessageV2.TextPart {
  return {
    id: "part-text" as any,
    sessionID: "sess-1" as any,
    messageID: "msg-1" as any,
    type: "text",
    text: value,
  }
}

describe("applyToolBudget", () => {
  test("returns input unchanged when under budget", () => {
    const input = [msg([tool("short", 0)])]
    const result = applyToolBudget(input, 1000)
    expect(result).toBe(input)
  })

  test("returns input unchanged when budget is 0", () => {
    const input = [msg([tool("x".repeat(100), 0)])]
    const result = applyToolBudget(input, 0)
    expect(result).toBe(input)
  })

  test("truncates oldest tool results when over budget", () => {
    const input = [msg([tool("a".repeat(100), 0)]), msg([tool("b".repeat(100), 1)]), msg([tool("c".repeat(100), 2)])]
    // Budget 150 means total 300 is over; need to remove 150 chars worth
    // Oldest first: entry 0 (100 chars) removed, then entry 1 (100 chars) removed
    const result = applyToolBudget(input, 150)
    expect(result[0].parts[0]).toMatchObject({
      type: "tool",
      state: { output: "[tool result truncated to save context]" },
    })
    expect(result[1].parts[0]).toMatchObject({
      type: "tool",
      state: { output: "[tool result truncated to save context]" },
    })
    // Newest preserved
    expect((result[2].parts[0] as MessageV2.ToolPart).state).toMatchObject({
      output: "c".repeat(100),
    })
  })

  test("does not mutate original messages", () => {
    const original = [msg([tool("x".repeat(200), 0)])]
    const copy = (original[0].parts[0] as MessageV2.ToolPart).state
    applyToolBudget(original, 50)
    expect((copy as MessageV2.ToolStateCompleted).output).toBe("x".repeat(200))
  })

  test("preserves non-tool parts", () => {
    const input = [msg([text("hello"), tool("x".repeat(200), 0)])]
    const result = applyToolBudget(input, 50)
    expect((result[0].parts[0] as MessageV2.TextPart).text).toBe("hello")
    expect((result[0].parts[1] as MessageV2.ToolPart).state).toMatchObject({
      output: "[tool result truncated to save context]",
    })
  })

  test("skips pending and running tool states", () => {
    const pending: MessageV2.ToolPart = {
      id: "part-p" as any,
      sessionID: "sess-1" as any,
      messageID: "msg-1" as any,
      type: "tool",
      callID: "call-p",
      tool: "bash",
      state: {
        status: "pending",
        input: { command: "echo" },
        raw: "{}",
      },
    }
    const input = [msg([pending, tool("x".repeat(100), 1)])]
    const result = applyToolBudget(input, 5000)
    expect(result).toBe(input)
  })

  test("handles empty messages array", () => {
    const result = applyToolBudget([], 100)
    expect(result).toEqual([])
  })

  test("handles messages with no tool parts", () => {
    const input = [msg([text("hello")])]
    const result = applyToolBudget(input, 100)
    expect(result).toBe(input)
  })

  test("truncates exactly enough to meet budget", () => {
    // 3 tools: 50, 50, 50 = 150 total. Budget 100 → excess 50 → truncate first only
    const input = [msg([tool("a".repeat(50), 0)]), msg([tool("b".repeat(50), 1)]), msg([tool("c".repeat(50), 2)])]
    const result = applyToolBudget(input, 100)
    expect((result[0].parts[0] as MessageV2.ToolPart).state).toMatchObject({
      output: "[tool result truncated to save context]",
    })
    expect((result[1].parts[0] as MessageV2.ToolPart).state).toMatchObject({
      output: "b".repeat(50),
    })
    expect((result[2].parts[0] as MessageV2.ToolPart).state).toMatchObject({
      output: "c".repeat(50),
    })
  })

  test("preserves tool metadata when truncating", () => {
    const input = [msg([tool("x".repeat(200), 0)])]
    const result = applyToolBudget(input, 50)
    const part = result[0].parts[0] as MessageV2.ToolPart
    expect(part.callID).toBe("call-0")
    expect(part.tool).toBe("bash")
    expect(part.state.status).toBe("completed")
    expect((part.state as MessageV2.ToolStateCompleted).time).toEqual({ start: 1000, end: 2000 })
  })
})
