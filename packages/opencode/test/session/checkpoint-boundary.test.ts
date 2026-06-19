import { describe, expect, test } from "bun:test"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import type { MessageV2 } from "../../src/session/message-v2"
import {
  estimateMessageTokens,
  computeBoundary,
  TAIL_MIN_TOKENS,
  TAIL_MAX_TOKENS,
  COMPACTABLE_TOOL_NAMES,
} from "../../src/session/checkpoint-boundary"

const sid = SessionID.make("test-session")

function user(parts: MessageV2.Part[]): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "user",
      sessionID: sid,
      time: { created: Date.now() },
      agent: "build",
      model: {
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("test-model"),
      },
    },
    parts,
  }
}

function assistant(parts?: MessageV2.Part[]): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      sessionID: sid,
      time: { created: Date.now(), completed: Date.now() },
    },
    parts: parts ?? [
      {
        id: PartID.ascending(),
        sessionID: sid,
        messageID: id,
        type: "text",
        text: "response",
      },
    ],
  }
}

function textPart(text = "hello"): MessageV2.Part {
  const id = MessageID.ascending()
  return {
    id: PartID.ascending(),
    sessionID: sid,
    messageID: id,
    type: "text",
    text,
  } as MessageV2.Part
}

function toolPart(output = "done"): MessageV2.Part {
  const id = MessageID.ascending()
  return {
    id: PartID.ascending(),
    sessionID: sid,
    messageID: id,
    type: "tool",
    tool: "bash",
    callID: "call-1",
    state: {
      status: "completed",
      input: {},
      output,
      title: "bash",
      metadata: {},
      time: { start: Date.now(), end: Date.now() },
    },
  } as MessageV2.Part
}

function errorToolPart(error = "failed"): MessageV2.Part {
  const id = MessageID.ascending()
  return {
    id: PartID.ascending(),
    sessionID: sid,
    messageID: id,
    type: "tool",
    tool: "bash",
    callID: "call-2",
    state: {
      status: "error",
      input: {},
      error,
      metadata: {},
      time: { start: Date.now(), end: Date.now() },
    },
  } as MessageV2.Part
}

function reasoningPart(text = "thinking"): MessageV2.Part {
  const id = MessageID.ascending()
  return {
    id: PartID.ascending(),
    sessionID: sid,
    messageID: id,
    type: "reasoning",
    text,
    time: { start: Date.now(), end: Date.now() },
  } as MessageV2.Part
}

describe("estimateMessageTokens", () => {
  test("empty parts returns 0", () => {
    const msg = user([])
    expect(estimateMessageTokens(msg)).toBe(0)
  })

  test("text part estimates chars/4", () => {
    const msg = user([textPart("a".repeat(100))])
    expect(estimateMessageTokens(msg)).toBe(25)
  })

  test("reasoning part counted", () => {
    const msg = assistant([reasoningPart("b".repeat(80))])
    expect(estimateMessageTokens(msg)).toBe(20)
  })

  test("completed tool output counted", () => {
    const msg = assistant([toolPart("c".repeat(200))])
    expect(estimateMessageTokens(msg)).toBe(50)
  })

  test("error tool output counted", () => {
    const msg = assistant([errorToolPart("d".repeat(40))])
    expect(estimateMessageTokens(msg)).toBe(10)
  })

  test("pending tool not counted", () => {
    const id = MessageID.ascending()
    const part = {
      id: PartID.ascending(),
      sessionID: sid,
      messageID: id,
      type: "tool",
      tool: "bash",
      callID: "call-3",
      state: {
        status: "pending",
        input: { cmd: "ls" },
        raw: '{"cmd":"ls"}',
      },
    } as MessageV2.Part
    const msg = assistant([part])
    expect(estimateMessageTokens(msg)).toBe(0)
  })

  test("sums multiple parts", () => {
    const msg = assistant([textPart("a".repeat(40)), toolPart("b".repeat(80)), reasoningPart("c".repeat(20))])
    // 40/4 + 80/4 + 20/4 = 10 + 20 + 5 = 35
    expect(estimateMessageTokens(msg)).toBe(35)
  })
})

describe("computeBoundary", () => {
  test("returns undefined for 2 or fewer messages", () => {
    expect(computeBoundary([])).toBeUndefined()
    expect(computeBoundary([user([textPart()])])).toBeUndefined()
    expect(computeBoundary([user([textPart()]), assistant()])).toBeUndefined()
  })

  test("returns undefined when boundary would be at 0", () => {
    // 3 messages but all tokens < min, so candidate=0, aligned=0, index=0
    const msgs = [user([textPart("hi")]), assistant(), user([textPart("bye")])]
    expect(computeBoundary(msgs, { min: 100_000 })).toBeUndefined()
  })

  test("splits with enough tokens in tail", () => {
    const big = "x".repeat(4000) // 1000 tokens each
    const msgs = [
      user([textPart(big)]),
      assistant([textPart(big)]),
      user([textPart(big)]),
      assistant([textPart(big)]),
      user([textPart(big)]),
      assistant([textPart(big)]),
    ]
    // min=2000 tokens total. Walk backward: msg[5]=1000, msg[4]=1000 => 2000 >= 2000
    // candidate=4. alignToNonToolResultUser(msgs, 4) => msgs[4] is user([textPart]) -> aligned=4
    // index = 4 - 1 = 3
    const result = computeBoundary(msgs, { min: 2000 })
    expect(result).toBeDefined()
    expect(result!.index).toBe(3)
    expect(result!.head).toHaveLength(4)
    expect(result!.tail).toHaveLength(2)
    expect(result!.id).toBe(msgs[3].info.id)
  })

  test("head and tail are correct slices", () => {
    const big = "x".repeat(400) // 100 tokens each
    const msgs = [
      user([textPart(big)]),
      assistant([textPart(big)]),
      user([textPart(big)]),
      assistant([textPart(big)]),
      user([textPart(big)]),
    ]
    // min=50: walk backward, msg[4]=100 >= 50, candidate=4
    // alignToNonToolResultUser(msgs, 4) => msgs[4] is user with textPart => aligned=4
    // index = 4 - 1 = 3
    const result = computeBoundary(msgs, { min: 50 })
    expect(result).toBeDefined()
    expect(result!.head).toEqual(msgs.slice(0, 4))
    expect(result!.tail).toEqual(msgs.slice(4))
  })

  test("skips tool-only user messages during alignment", () => {
    const big = "x".repeat(4000) // 1000 tokens
    const msgs = [
      user([textPart(big)]),
      assistant([textPart(big)]),
      user([textPart(big)]),
      assistant([textPart(big)]),
      user([toolPart(big)]), // tool-only user
      assistant([textPart(big)]),
    ]
    // min=2000: walk backward msg[5]=1000, msg[4]=1000 => 2000 >= 2000, candidate=4
    // alignToNonToolResultUser(msgs, 4) => msgs[4] is tool-only user, msgs[3] is assistant, msgs[2] is user with textPart => aligned=2
    // index = 2 - 1 = 1
    const result = computeBoundary(msgs, { min: 2000 })
    expect(result).toBeDefined()
    expect(result!.index).toBe(1)
  })

  test("uses default TAIL_MIN_TOKENS", () => {
    // verify constants exported correctly
    expect(TAIL_MIN_TOKENS).toBe(10_000)
    expect(TAIL_MAX_TOKENS).toBe(20_000)
  })

  test("COMPACTABLE_TOOL_NAMES has expected tools", () => {
    expect(COMPACTABLE_TOOL_NAMES.has("read")).toBe(true)
    expect(COMPACTABLE_TOOL_NAMES.has("glob")).toBe(true)
    expect(COMPACTABLE_TOOL_NAMES.has("grep")).toBe(true)
    expect(COMPACTABLE_TOOL_NAMES.has("bash")).toBe(true)
    expect(COMPACTABLE_TOOL_NAMES.has("webfetch")).toBe(true)
    expect(COMPACTABLE_TOOL_NAMES.has("websearch")).toBe(true)
    expect(COMPACTABLE_TOOL_NAMES.has("edit")).toBe(false)
  })

  test("returns undefined when aligned is 1 (boundary at 0)", () => {
    const big = "x".repeat(4000) // 1000 tokens
    const msgs = [
      user([textPart(big)]), // only valid user msg is at 0
      assistant([textPart(big)]),
      user([toolPart(big)]), // tool-only
    ]
    // min=500: walk backward msg[2]=1000 >= 500, candidate=2
    // alignToNonToolResultUser(msgs, 2): msgs[2] tool-only, msgs[1] assistant, msgs[0] user with text => aligned=0
    // index = 0 => return undefined
    const result = computeBoundary(msgs, { min: 500 })
    expect(result).toBeUndefined()
  })
})
