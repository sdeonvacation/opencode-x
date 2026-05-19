import { describe, expect, test } from "bun:test"
import { buildContextTransfer } from "../../src/tool/task"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

function msg(parts: MessageV2.Part[]): MessageV2.WithParts {
  const id = MessageID.ascending()
  const sid = SessionID.make("test-session")
  return {
    info: {
      id,
      role: "assistant",
      parentID: MessageID.ascending(),
      sessionID: sid,
      mode: "build",
      agent: "build",
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test-model" as any,
      providerID: "test" as any,
      time: { created: Date.now() },
    },
    parts,
  }
}

function tool(name: string, output: string): MessageV2.ToolPart {
  const sid = SessionID.make("test-session")
  const mid = MessageID.ascending()
  return {
    id: PartID.ascending(),
    sessionID: sid,
    messageID: mid,
    type: "tool",
    callID: "call-1",
    tool: name,
    state: {
      status: "completed",
      input: {},
      output,
      title: name,
      metadata: {},
      time: { start: Date.now(), end: Date.now() },
    },
  }
}

function pending(name: string): MessageV2.ToolPart {
  const sid = SessionID.make("test-session")
  const mid = MessageID.ascending()
  return {
    id: PartID.ascending(),
    sessionID: sid,
    messageID: mid,
    type: "tool",
    callID: "call-2",
    tool: name,
    state: {
      status: "pending",
      input: {},
      raw: "{}",
    },
  }
}

describe("buildContextTransfer", () => {
  test("returns undefined for empty messages", () => {
    expect(buildContextTransfer([], 4000)).toBeUndefined()
  })

  test("returns undefined when no completed tool parts", () => {
    const msgs = [msg([pending("read")])]
    expect(buildContextTransfer(msgs, 4000)).toBeUndefined()
  })

  test("returns undefined when output too short", () => {
    const msgs = [msg([tool("read", "short")])]
    expect(buildContextTransfer(msgs, 4000)).toBeUndefined()
  })

  test("extracts completed tool output", () => {
    const output = "x".repeat(100)
    const msgs = [msg([tool("read", output)])]
    const result = buildContextTransfer(msgs, 4000)
    expect(result).toContain("<parent-context>")
    expect(result).toContain("</parent-context>")
    expect(result).toContain("[read]")
    expect(result).toContain(output)
  })

  test("respects character limit", () => {
    const output = "y".repeat(5000)
    const msgs = [msg([tool("read", output)])]
    const result = buildContextTransfer(msgs, 200)!
    // The snippet itself should be capped at ~200 chars
    const inner = result
      .replace("<parent-context>\nRecent tool outputs from parent session:\n", "")
      .replace("\n</parent-context>", "")
    // [read] prefix + snippet
    expect(inner.length).toBeLessThanOrEqual(200 + "[read] ".length)
  })

  test("collects from multiple messages in chronological order", () => {
    const msgs = [msg([tool("read", "a".repeat(60))]), msg([tool("bash", "b".repeat(60))])]
    const result = buildContextTransfer(msgs, 4000)!
    const readIdx = result.indexOf("[read]")
    const bashIdx = result.indexOf("[bash]")
    // reversed back to chronological: read before bash
    expect(readIdx).toBeLessThan(bashIdx)
  })

  test("skips non-tool parts", () => {
    const sid = SessionID.make("test-session")
    const mid = MessageID.ascending()
    const text: MessageV2.TextPart = {
      id: PartID.ascending(),
      sessionID: sid,
      messageID: mid,
      type: "text",
      text: "x".repeat(200),
    }
    const msgs = [msg([text, tool("grep", "z".repeat(100))])]
    const result = buildContextTransfer(msgs, 4000)!
    expect(result).toContain("[grep]")
    expect(result).not.toContain("[text]")
  })

  test("stops collecting when limit reached across parts", () => {
    const msgs = [msg([tool("read", "a".repeat(2000)), tool("bash", "b".repeat(2000)), tool("grep", "c".repeat(2000))])]
    const result = buildContextTransfer(msgs, 3000)!
    // Should not contain all three full outputs
    const total = result.length
    // Wrapper overhead is ~70 chars, so content should be ~3000
    expect(total).toBeLessThan(3200)
  })
})
