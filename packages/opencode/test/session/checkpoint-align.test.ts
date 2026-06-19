import { describe, expect, test } from "bun:test"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { alignToNonToolResultUser } from "../../src/session/checkpoint-align"
import type { MessageV2 } from "../../src/session/message-v2"

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

function assistant(): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
      sessionID: sid,
      time: { created: Date.now(), completed: Date.now() },
    },
    parts: [
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

function textPart(): MessageV2.Part {
  const id = MessageID.ascending()
  return {
    id: PartID.ascending(),
    sessionID: sid,
    messageID: id,
    type: "text",
    text: "hello",
  } as MessageV2.Part
}

function toolPart(): MessageV2.Part {
  const id = MessageID.ascending()
  return {
    id: PartID.ascending(),
    sessionID: sid,
    messageID: id,
    type: "tool",
    tool: "bash",
    state: "completed",
    input: {},
    output: "done",
    time: { start: Date.now(), end: Date.now() },
  } as MessageV2.Part
}

describe("alignToNonToolResultUser", () => {
  test("empty messages returns 0", () => {
    expect(alignToNonToolResultUser([], 0)).toBe(0)
  })

  test("returns index of user with text part", () => {
    const msgs = [user([textPart()]), assistant(), user([toolPart()])]
    expect(alignToNonToolResultUser(msgs, 2)).toBe(0)
  })

  test("returns current index when it has non-tool part", () => {
    const msgs = [user([textPart()]), assistant(), user([textPart()])]
    expect(alignToNonToolResultUser(msgs, 2)).toBe(2)
  })

  test("skips tool-result-only user messages", () => {
    const msgs = [user([textPart()]), assistant(), user([toolPart(), toolPart()]), assistant(), user([toolPart()])]
    expect(alignToNonToolResultUser(msgs, 4)).toBe(0)
  })

  test("skips assistant messages", () => {
    const msgs = [user([textPart()]), assistant(), assistant()]
    expect(alignToNonToolResultUser(msgs, 2)).toBe(0)
  })

  test("mixed parts - has text among tools is valid", () => {
    const msgs = [user([toolPart(), textPart()])]
    expect(alignToNonToolResultUser(msgs, 0)).toBe(0)
  })

  test("returns 0 when no valid user message found", () => {
    const msgs = [user([toolPart()]), assistant(), user([toolPart()])]
    expect(alignToNonToolResultUser(msgs, 2)).toBe(0)
  })

  test("skips empty-parts user messages", () => {
    const msgs = [user([textPart()]), user([])]
    expect(alignToNonToolResultUser(msgs, 1)).toBe(0)
  })

  test("index beyond array length clamps to last", () => {
    const msgs = [user([textPart()]), assistant()]
    expect(alignToNonToolResultUser(msgs, 99)).toBe(0)
  })

  test("finds nearest valid user walking backward", () => {
    const msgs = [user([textPart()]), assistant(), user([textPart()]), assistant(), user([toolPart()])]
    expect(alignToNonToolResultUser(msgs, 4)).toBe(2)
  })
})
