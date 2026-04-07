import { describe, expect, spyOn, test } from "bun:test"
import { Effect } from "effect"
import type { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import * as HistoryCache from "../../src/session/history-cache"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

const sessionID = SessionID.make("session_history_cache")

const modelA: Provider.Model = {
  id: ModelID.make("model-a"),
  providerID: ProviderID.make("provider-a"),
  api: {
    id: "model-a-api",
    url: "https://example.com",
    npm: "@ai-sdk/openai",
  },
  name: "Model A",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    interleaved: false,
  },
  cost: {
    input: 0,
    output: 0,
    cache: { read: 0, write: 0 },
  },
  limit: {
    context: 0,
    input: 0,
    output: 0,
  },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

const modelB: Provider.Model = {
  ...modelA,
  id: ModelID.make("model-b"),
  api: {
    ...modelA.api,
    id: "model-b-api",
  },
}

function message(
  id: string,
  input?: {
    role?: MessageV2.Info["role"]
    parentID?: string
    summary?: boolean
    finish?: MessageV2.Assistant["finish"]
    compaction?: boolean
  },
): MessageV2.WithParts {
  const role = input?.role ?? "user"
  return {
    info: {
      id: MessageID.make(id),
      sessionID,
      role,
      time: { created: 0 },
      agent: "general",
      model: { providerID: modelA.providerID, modelID: ModelID.make("model-a") },
      tools: {},
      mode: "",
      ...(role === "assistant"
        ? {
            parentID: MessageID.make(input?.parentID ?? ""),
            summary: input?.summary,
            finish: input?.finish,
          }
        : {}),
    } as unknown as MessageV2.Info,
    parts: input?.compaction
      ? ([
          {
            id: PartID.ascending(),
            sessionID,
            messageID: MessageID.make(id),
            type: "compaction",
            auto: true,
          } as unknown as MessageV2.Part,
        ] satisfies MessageV2.Part[])
      : ([
          {
            id: PartID.ascending(),
            sessionID,
            messageID: MessageID.make(id),
            type: "text",
            text: id,
          } as unknown as MessageV2.Part,
        ] satisfies MessageV2.Part[]),
  }
}

let time = 1

function timedMessage(
  id: string,
  input?: {
    role?: MessageV2.Info["role"]
    parentID?: string
    summary?: boolean
    finish?: MessageV2.Assistant["finish"]
    compaction?: boolean
  },
): MessageV2.WithParts {
  const msg = message(id, input)
  ;(msg.info as any).time = { created: time++ }
  return msg
}

describe("session/history-cache", () => {
  test("cache hit uses delta tail without full refetch", async () => {
    const cache = HistoryCache.create()
    const u1 = timedMessage("msg_u1")
    const a1 = timedMessage("msg_a1")
    const u2 = timedMessage("msg_u2")
    const a2 = timedMessage("msg_a2", { role: "assistant", parentID: "msg_u2", finish: "stop" })

    const filter = spyOn(MessageV2, "filterCompactedEffect")
    filter.mockReturnValueOnce(Effect.succeed([u1, a1]))
    const streamAfter = spyOn(MessageV2, "streamAfterEffect")
    // streamAfter returns newest -> oldest
    streamAfter.mockReturnValueOnce(Effect.succeed([a2, u2]))

    const convertCalls: Array<{ ids: string[]; stripMedia: boolean | undefined }> = []
    const convert = spyOn(MessageV2, "toModelMessagesEffect").mockImplementation((msgs, _model, options) => {
      convertCalls.push({ ids: msgs.map((m) => m.info.id), stripMedia: options?.stripMedia })
      return Effect.succeed(
        msgs.map((m) => ({
          role: "user" as const,
          content: [{ type: "text" as const, text: m.info.id }],
        })),
      )
    })

    const first = await Effect.runPromise(cache.get({ sessionID, model: modelA }))
    const second = await Effect.runPromise(cache.get({ sessionID, model: modelA }))

    expect(first.messages.map((m) => String(m.info.id))).toStrictEqual(["msg_u1", "msg_a1"])
    expect(second.messages.map((m) => String(m.info.id))).toStrictEqual(["msg_u1", "msg_a1", "msg_u2", "msg_a2"])
    expect(second.modelMessages).toHaveLength(4)
    expect(convertCalls).toStrictEqual([
      { ids: ["msg_u1", "msg_a1"], stripMedia: true },
      { ids: ["msg_u2", "msg_a2"], stripMedia: true },
    ])
    expect(filter).toHaveBeenCalledTimes(1)
    expect(streamAfter).toHaveBeenCalledTimes(1)

    filter.mockRestore()
    streamAfter.mockRestore()
    convert.mockRestore()
  })

  test("compaction boundary change triggers safe full rebuild fallback", async () => {
    const cache = HistoryCache.create()
    const u1 = timedMessage("msg_u1")
    const a1 = timedMessage("msg_a1", { role: "assistant", parentID: "msg_u1", finish: "stop" })
    const u2 = timedMessage("msg_u2")
    const a2 = timedMessage("msg_a2", { role: "assistant", parentID: "msg_u2", finish: "stop" })
    const compactionUser = timedMessage("msg_compaction", { compaction: true })
    const summaryAssistant = timedMessage("msg_summary", {
      role: "assistant",
      parentID: "msg_compaction",
      summary: true,
      finish: "stop",
    })

    const filter = spyOn(MessageV2, "filterCompactedEffect")
    filter
      .mockReturnValueOnce(Effect.succeed([u1, a1, u2, a2, compactionUser]))
      .mockReturnValueOnce(Effect.succeed([compactionUser, summaryAssistant]))
    const streamAfter = spyOn(MessageV2, "streamAfterEffect")
    streamAfter.mockReturnValueOnce(Effect.succeed([summaryAssistant]))

    const convertCalls: Array<{ ids: string[]; stripMedia: boolean | undefined }> = []
    const convert = spyOn(MessageV2, "toModelMessagesEffect").mockImplementation((msgs, _model, options) => {
      convertCalls.push({ ids: msgs.map((m) => m.info.id), stripMedia: options?.stripMedia })
      return Effect.succeed(
        msgs.map((m) => ({
          role: "user" as const,
          content: [{ type: "text" as const, text: m.info.id }],
        })),
      )
    })

    await Effect.runPromise(cache.get({ sessionID, model: modelA }))
    await Effect.runPromise(cache.get({ sessionID, model: modelA }))

    expect(convertCalls).toStrictEqual([
      { ids: ["msg_u1", "msg_a1", "msg_u2", "msg_a2", "msg_compaction"], stripMedia: true },
      { ids: ["msg_compaction", "msg_summary"], stripMedia: true },
    ])
    expect(filter).toHaveBeenCalledTimes(2)
    expect(streamAfter).toHaveBeenCalledTimes(1)

    filter.mockRestore()
    streamAfter.mockRestore()
    convert.mockRestore()
  })

  test("manual invalidate forces full rebuild", async () => {
    const cache = HistoryCache.create()
    const m1 = timedMessage("msg_1")
    const m2 = timedMessage("msg_2")

    const filter = spyOn(MessageV2, "filterCompactedEffect")
    filter.mockReturnValueOnce(Effect.succeed([m1, m2])).mockReturnValueOnce(Effect.succeed([m1, m2]))
    const streamAfter = spyOn(MessageV2, "streamAfterEffect")

    const convertCalls: Array<{ ids: string[]; stripMedia: boolean | undefined }> = []
    const convert = spyOn(MessageV2, "toModelMessagesEffect").mockImplementation((msgs, _model, options) => {
      convertCalls.push({ ids: msgs.map((m) => m.info.id), stripMedia: options?.stripMedia })
      return Effect.succeed(
        msgs.map((m) => ({
          role: "user" as const,
          content: [{ type: "text" as const, text: m.info.id }],
        })),
      )
    })

    await Effect.runPromise(cache.get({ sessionID, model: modelA }))
    cache.invalidate()
    await Effect.runPromise(cache.get({ sessionID, model: modelA }))

    expect(convertCalls).toStrictEqual([
      { ids: ["msg_1", "msg_2"], stripMedia: true },
      { ids: ["msg_1", "msg_2"], stripMedia: true },
    ])
    expect(streamAfter).not.toHaveBeenCalled()

    filter.mockRestore()
    streamAfter.mockRestore()
    convert.mockRestore()
  })

  test("model change triggers cache miss", async () => {
    const cache = HistoryCache.create()
    const m1 = timedMessage("msg_1")
    const m2 = timedMessage("msg_2")

    const filter = spyOn(MessageV2, "filterCompactedEffect")
    filter.mockReturnValueOnce(Effect.succeed([m1, m2])).mockReturnValueOnce(Effect.succeed([m1, m2]))
    const streamAfter = spyOn(MessageV2, "streamAfterEffect")

    const convertCalls: Array<{ ids: string[]; stripMedia: boolean | undefined }> = []
    const convert = spyOn(MessageV2, "toModelMessagesEffect").mockImplementation((msgs, _model, options) => {
      convertCalls.push({ ids: msgs.map((m) => m.info.id), stripMedia: options?.stripMedia })
      return Effect.succeed(
        msgs.map((m) => ({
          role: "user" as const,
          content: [{ type: "text" as const, text: m.info.id }],
        })),
      )
    })

    await Effect.runPromise(cache.get({ sessionID, model: modelA }))
    await Effect.runPromise(cache.get({ sessionID, model: modelB }))

    expect(convertCalls).toStrictEqual([
      { ids: ["msg_1", "msg_2"], stripMedia: true },
      { ids: ["msg_1", "msg_2"], stripMedia: true },
    ])
    expect(streamAfter).not.toHaveBeenCalled()

    filter.mockRestore()
    streamAfter.mockRestore()
    convert.mockRestore()
  })

  test("cache hit with no delta avoids full fetch and conversion", async () => {
    const cache = HistoryCache.create()
    const m1 = timedMessage("msg_1")
    const m2 = timedMessage("msg_2")

    const filter = spyOn(MessageV2, "filterCompactedEffect")
    filter.mockReturnValueOnce(Effect.succeed([m1, m2]))
    const streamAfter = spyOn(MessageV2, "streamAfterEffect")
    streamAfter.mockReturnValueOnce(Effect.succeed([]))

    const convertCalls: Array<{ ids: string[]; stripMedia: boolean | undefined }> = []
    const convert = spyOn(MessageV2, "toModelMessagesEffect").mockImplementation((msgs, _model, options) => {
      convertCalls.push({ ids: msgs.map((m) => m.info.id), stripMedia: options?.stripMedia })
      return Effect.succeed(
        msgs.map((m) => ({
          role: "user" as const,
          content: [{ type: "text" as const, text: m.info.id }],
        })),
      )
    })

    await Effect.runPromise(cache.get({ sessionID, model: modelA }))
    await Effect.runPromise(cache.get({ sessionID, model: modelA }))

    expect(filter).toHaveBeenCalledTimes(1)
    expect(streamAfter).toHaveBeenCalledTimes(1)
    expect(convertCalls).toStrictEqual([{ ids: ["msg_1", "msg_2"], stripMedia: true }])

    filter.mockRestore()
    streamAfter.mockRestore()
    convert.mockRestore()
  })

  test("warm cache path keeps avoiding full refetch across repeated hits", async () => {
    const cache = HistoryCache.create()
    const m1 = timedMessage("msg_1")
    const m2 = timedMessage("msg_2")

    const filter = spyOn(MessageV2, "filterCompactedEffect")
    filter.mockReturnValueOnce(Effect.succeed([m1, m2]))
    const streamAfter = spyOn(MessageV2, "streamAfterEffect")
    streamAfter.mockReturnValue(Effect.succeed([]))

    const convertCalls: Array<{ ids: string[]; stripMedia: boolean | undefined }> = []
    const convert = spyOn(MessageV2, "toModelMessagesEffect").mockImplementation((msgs, _model, options) => {
      convertCalls.push({ ids: msgs.map((m) => m.info.id), stripMedia: options?.stripMedia })
      return Effect.succeed(
        msgs.map((m) => ({
          role: "user" as const,
          content: [{ type: "text" as const, text: m.info.id }],
        })),
      )
    })

    await Effect.runPromise(cache.get({ sessionID, model: modelA }))
    await Effect.runPromise(cache.get({ sessionID, model: modelA }))
    await Effect.runPromise(cache.get({ sessionID, model: modelA }))

    expect(filter).toHaveBeenCalledTimes(1)
    expect(streamAfter).toHaveBeenCalledTimes(2)
    expect(convertCalls).toStrictEqual([{ ids: ["msg_1", "msg_2"], stripMedia: true }])

    filter.mockRestore()
    streamAfter.mockRestore()
    convert.mockRestore()
  })
})
