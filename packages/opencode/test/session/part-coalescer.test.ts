import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { create } from "../../src/session/part-coalescer"
import { PartID, MessageID, SessionID } from "../../src/session/schema"
import type { MessageV2 } from "../../src/session/message-v2"

const messageID = MessageID.make("message_test")
const sessionID = SessionID.make("session_test")

function tool(input: {
  id: string
  status: "pending" | "running" | "completed" | "error"
  raw?: string
}): MessageV2.ToolPart {
  const base = {
    id: PartID.make(input.id),
    messageID,
    sessionID,
    type: "tool" as const,
    tool: "bash",
    callID: "call_1",
  }
  if (input.status === "pending") {
    return { ...base, state: { status: "pending", input: {}, raw: input.raw ?? "" } }
  }
  if (input.status === "running") {
    return { ...base, state: { status: "running", input: {}, time: { start: Date.now() } } }
  }
  if (input.status === "completed") {
    return {
      ...base,
      state: {
        status: "completed",
        input: {},
        output: "ok",
        title: "ok",
        metadata: {},
        time: { start: Date.now(), end: Date.now() },
      },
    }
  }
  return {
    ...base,
    state: {
      status: "error",
      input: {},
      error: "fail",
      time: { start: Date.now(), end: Date.now() },
    },
  }
}

function text(input: { id: string; value: string; ended?: boolean }): MessageV2.TextPart {
  return {
    id: PartID.make(input.id),
    messageID,
    sessionID,
    type: "text",
    text: input.value,
    time: input.ended ? { start: Date.now() - 10, end: Date.now() } : { start: Date.now() },
  }
}

function reasoning(input: { id: string; value: string; ended?: boolean }): MessageV2.ReasoningPart {
  return {
    id: PartID.make(input.id),
    messageID,
    sessionID,
    type: "reasoning",
    text: input.value,
    time: input.ended ? { start: Date.now() - 10, end: Date.now() } : { start: Date.now() },
  }
}

function stepStart(id: string): MessageV2.StepStartPart {
  return {
    id: PartID.make(id),
    messageID,
    sessionID,
    type: "step-start",
  }
}

describe("session/part-coalescer", () => {
  test("coalesces rapid non-terminal updates", async () => {
    const flushed: MessageV2.Part[] = []
    const coalescer = create({
      flush: (part) =>
        Effect.sync(() => {
          flushed.push(part)
        }),
    })

    await Effect.runPromise(coalescer.update(tool({ id: "part_1", status: "pending", raw: "a" })))
    await Effect.runPromise(coalescer.update(tool({ id: "part_1", status: "pending", raw: "ab" })))
    await Effect.runPromise(coalescer.update(tool({ id: "part_1", status: "pending", raw: "abc" })))
    await Bun.sleep(350)

    expect(flushed).toHaveLength(1)
    const [part] = flushed
    expect(part.type).toBe("tool")
    if (part.type === "tool" && part.state.status === "pending") {
      expect(part.state.raw).toBe("abc")
    }
  })

  test("flushes terminal part immediately", async () => {
    const flushed: MessageV2.Part[] = []
    const coalescer = create({
      flush: (part) =>
        Effect.sync(() => {
          flushed.push(part)
        }),
    })

    await Effect.runPromise(coalescer.update(tool({ id: "part_1", status: "pending", raw: "a" })))
    await Effect.runPromise(coalescer.update(tool({ id: "part_1", status: "completed" })))

    expect(flushed).toHaveLength(1)
    expect(flushed[0].type).toBe("tool")
    if (flushed[0].type === "tool") {
      expect(flushed[0].state.status).toBe("completed")
    }
  })

  test("dispose flushes remaining buffered parts", async () => {
    const flushed: MessageV2.Part[] = []
    const coalescer = create({
      flush: (part) =>
        Effect.sync(() => {
          flushed.push(part)
        }),
    })

    await Effect.runPromise(coalescer.update(tool({ id: "part_1", status: "pending", raw: "a" })))
    await Effect.runPromise(coalescer.update(tool({ id: "part_2", status: "pending", raw: "b" })))
    await Effect.runPromise(coalescer.dispose())

    expect(flushed).toHaveLength(2)
  })

  test("resets timer on rapid updates", async () => {
    const flushed: MessageV2.Part[] = []
    const coalescer = create({
      flush: (part) =>
        Effect.sync(() => {
          flushed.push(part)
        }),
    })

    await Effect.runPromise(coalescer.update(tool({ id: "part_1", status: "pending", raw: "a" })))
    await Bun.sleep(220)
    await Effect.runPromise(coalescer.update(tool({ id: "part_1", status: "pending", raw: "ab" })))
    await Bun.sleep(160)
    expect(flushed).toHaveLength(0)
    await Bun.sleep(200)
    expect(flushed).toHaveLength(1)
  })

  test("flushes text and reasoning only when ended", async () => {
    const flushed: MessageV2.Part[] = []
    const coalescer = create({
      flush: (part) =>
        Effect.sync(() => {
          flushed.push(part)
        }),
    })

    await Effect.runPromise(coalescer.update(text({ id: "part_text", value: "hel" })))
    await Effect.runPromise(coalescer.update(reasoning({ id: "part_reason", value: "think" })))
    expect(flushed).toHaveLength(0)

    await Effect.runPromise(coalescer.update(text({ id: "part_text", value: "hello", ended: true })))
    await Effect.runPromise(coalescer.update(reasoning({ id: "part_reason", value: "thinking", ended: true })))
    expect(flushed).toHaveLength(2)
  })

  test("flushes always-terminal part types immediately", async () => {
    const flushed: MessageV2.Part[] = []
    const coalescer = create({
      flush: (part) =>
        Effect.sync(() => {
          flushed.push(part)
        }),
    })

    await Effect.runPromise(coalescer.update(stepStart("part_step")))
    expect(flushed).toHaveLength(1)
    expect(flushed[0].type).toBe("step-start")
  })

  test("terminal update flushes only that part", async () => {
    const flushed: MessageV2.Part[] = []
    const coalescer = create({
      flush: (part) =>
        Effect.sync(() => {
          flushed.push(part)
        }),
    })

    await Effect.runPromise(coalescer.update(tool({ id: "part_1", status: "pending", raw: "a" })))
    await Effect.runPromise(coalescer.update(tool({ id: "part_2", status: "pending", raw: "b" })))
    await Effect.runPromise(coalescer.update(tool({ id: "part_1", status: "completed" })))

    expect(flushed).toHaveLength(1)
    expect(flushed[0].id).toBe(PartID.make("part_1"))

    await Effect.runPromise(coalescer.dispose())
    expect(flushed).toHaveLength(2)
    expect(flushed[1].id).toBe(PartID.make("part_2"))
  })

  test("reduces persisted writes for streaming updates", async () => {
    let writes = 0
    const coalescer = create({
      flush: () =>
        Effect.sync(() => {
          writes += 1
        }),
    })

    for (let i = 0; i < 10; i++) {
      await Effect.runPromise(coalescer.update(tool({ id: "part_stream", status: "pending", raw: String(i) })))
      await Bun.sleep(20)
    }

    await Bun.sleep(360)

    expect(writes).toBe(1)
  })
})
