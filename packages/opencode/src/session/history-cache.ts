import type { ModelMessage } from "ai"
import { Effect } from "effect"
import type { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import type { MessageID, SessionID } from "./schema"

type HistoryCacheEntry = {
  lastMessageID?: MessageID
  lastMessageTime?: number
  compactionBoundaryID?: MessageID
  filteredMessages: MessageV2.WithParts[]
  modelMessages: ModelMessage[]
  modelKey: string
}

export type HistoryCache = {
  readonly get: (input: {
    sessionID: SessionID
    model: Provider.Model
  }) => Effect.Effect<{ messages: MessageV2.WithParts[]; modelMessages: ModelMessage[] }>
  readonly invalidate: () => void
}

function modelKey(model: Provider.Model) {
  return [model.providerID, model.id, model.api.id, model.api.npm ?? ""].join("|")
}

function samePrefix(next: MessageV2.WithParts[], prev: MessageV2.WithParts[]) {
  if (next.length < prev.length) return false
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i]
    const b = next[i]
    if (!b || a.info.id !== b.info.id) return false
    if (a.parts.length !== b.parts.length) return false
    if (a.parts.at(-1)?.id !== b.parts.at(-1)?.id) return false
  }
  return true
}

export const create = (): HistoryCache => {
  let cache: HistoryCacheEntry | undefined

  const rebuild = Effect.fn("HistoryCache.rebuild")(function* (
    messages: MessageV2.WithParts[],
    model: Provider.Model,
    key: string,
  ) {
    // Strip full output text from compacted tool parts so historical DB data
    // (pruned before output-clearing was introduced) doesn't bloat filteredMessages.
    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.type === "tool" && part.state.status === "completed" && part.state.time.compacted) {
          part.state.output = ""
        }
      }
    }
    const modelMessages = yield* MessageV2.toModelMessagesEffect(messages, model, { stripMedia: true })
    cache = {
      lastMessageID: messages.at(-1)?.info.id,
      lastMessageTime: messages.at(-1)?.info.time.created,
      compactionBoundaryID: messages[0]?.info.id,
      filteredMessages: messages,
      modelMessages,
      modelKey: key,
    }
    return {
      messages,
      modelMessages,
    }
  })

  const get = Effect.fn("HistoryCache.get")(function* (input: { sessionID: SessionID; model: Provider.Model }) {
    const key = modelKey(input.model)
    if (!cache || cache.modelKey !== key) {
      const filteredMessages = yield* MessageV2.filterCompactedEffect(input.sessionID)
      return yield* rebuild(filteredMessages, input.model, key)
    }

    if (!cache.lastMessageID || cache.lastMessageTime === undefined) {
      const filteredMessages = yield* MessageV2.filterCompactedEffect(input.sessionID)
      return yield* rebuild(filteredMessages, input.model, key)
    }

    const delta = yield* MessageV2.streamAfterEffect({
      sessionID: input.sessionID,
      after: {
        id: cache.lastMessageID,
        time: cache.lastMessageTime,
      },
    })

    if (delta.length === 0) {
      return {
        messages: cache.filteredMessages,
        modelMessages: cache.modelMessages,
      }
    }

    const filteredMessages = MessageV2.filterCompacted([...delta, ...cache.filteredMessages.toReversed()])

    if (!samePrefix(filteredMessages, cache.filteredMessages)) {
      const fullFiltered = yield* MessageV2.filterCompactedEffect(input.sessionID)
      return yield* rebuild(fullFiltered, input.model, key)
    }

    const boundary = filteredMessages[0]?.info.id
    if (boundary !== cache.compactionBoundaryID) {
      const fullFiltered = yield* MessageV2.filterCompactedEffect(input.sessionID)
      return yield* rebuild(fullFiltered, input.model, key)
    }

    const tail = filteredMessages.slice(cache.filteredMessages.length)
    if (tail.length === 0) {
      cache = {
        ...cache,
        filteredMessages,
        lastMessageID: filteredMessages.at(-1)?.info.id,
        lastMessageTime: filteredMessages.at(-1)?.info.time.created,
      }
      return {
        messages: filteredMessages,
        modelMessages: cache.modelMessages,
      }
    }

    const tailModelMessages = yield* MessageV2.toModelMessagesEffect(tail, input.model, { stripMedia: true })
    cache = {
      ...cache,
      lastMessageID: filteredMessages.at(-1)?.info.id,
      lastMessageTime: filteredMessages.at(-1)?.info.time.created,
      filteredMessages,
      modelMessages: [...cache.modelMessages, ...tailModelMessages],
    }

    return {
      messages: filteredMessages,
      modelMessages: cache.modelMessages,
    }
  })

  return {
    get,
    invalidate() {
      cache = undefined
    },
  }
}
