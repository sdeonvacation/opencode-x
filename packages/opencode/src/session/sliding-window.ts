import { Config } from "@/config/config"
import { Flag } from "@/flag/flag"
import { Provider } from "@/provider/provider"
import { generateText, wrapLanguageModel } from "ai"
import { Effect } from "effect"
import { SessionCompaction } from "./compaction"
import { MessageV2 } from "./message-v2"
import { resolveLocal } from "./resolve-local"
import { MessageID, PartID, SessionID } from "./schema"
import { Log } from "../util/log"
import { Token } from "../util/token"

export namespace SlidingWindow {
  const log = Log.create({ service: "sliding-window" })
  const MAX = 50
  const MIN = 4_000
  const cache = new Map<SessionID, CacheEntry>()
  const inflight = new Set<SessionID>()

  type Metrics = {
    total: number
    budget: number
    tail: number
    head: number
    sent: number
    msgs: number
    ts: number
  }
  const metrics = new Map<SessionID, Metrics>()

  type CacheEntry = {
    headEndID: MessageID
    summary: string
    ts: number
  }

  export type CompactInput = {
    msgs: MessageV2.WithParts[]
    model: Provider.Model
    provider: Provider.Interface
    cfg: Config.Info
    sessionID: SessionID
    agent: { name: string; mode: "primary" | "subagent" | "all" }
  }

  type Split = {
    head: MessageV2.WithParts[]
    tail: MessageV2.WithParts[]
  }

  export const compact = Effect.fn("SlidingWindow.compact")(function* (input: CompactInput) {
    if (!should(input)) return input.msgs

    const total = yield* estimate(input.msgs, input.model)
    const opts = input.cfg.compaction?.sliding_window
    const threshold = opts?.threshold ?? 50_000
    if (total < threshold) {
      log.info("skip_below_threshold", { sessionID: input.sessionID, total, threshold })
      return input.msgs
    }

    const tail = yield* last(input.msgs, input.model)
    const budget = Math.max(Math.floor(total * (opts?.tail_ratio ?? 0.5)), tail)
    const split = yield* divide(input.msgs, input.model, budget)
    if (!split) {
      log.info("skip_no_split", { sessionID: input.sessionID, total, budget, tail })
      return input.msgs
    }

    const size = yield* estimate(split.head, input.model)
    const sent = yield* estimate(split.tail, input.model)
    if (size < MIN) {
      log.info("skip_small_head", { sessionID: input.sessionID, head: size, min: MIN, total, budget, tail })
      return input.msgs
    }

    const headEndID = split.head.at(-1)?.info.id
    if (!headEndID) return input.msgs

    const hit = cache.get(input.sessionID)
    if (hit && hit.headEndID === headEndID) {
      log.info("cache_hit", { sessionID: input.sessionID, headEndID, total, budget, head: size })
      touch(input.sessionID, hit)
      metrics.set(input.sessionID, {
        total,
        budget,
        tail,
        head: size,
        sent,
        msgs: split.tail.length,
        ts: Date.now(),
      })
      return [synthetic(hit.summary, input), ...split.tail]
    }

    log.info("cache_miss", { sessionID: input.sessionID, headEndID, total, budget, head: size })

    if (inflight.has(input.sessionID)) {
      log.info("skip_inflight", { sessionID: input.sessionID })
      return input.msgs
    }
    inflight.add(input.sessionID)

    const summary = yield* summarize(split.head, input.cfg, input.provider, input.sessionID).pipe(
      Effect.catch((err) => {
        log.warn("summarize_error", { sessionID: input.sessionID, error: String(err) })
        return Effect.succeed<string | undefined>(undefined)
      }),
      Effect.ensuring(Effect.sync(() => inflight.delete(input.sessionID))),
    )
    if (!summary) {
      log.info("skip_no_summary", { sessionID: input.sessionID, headEndID })
      return input.msgs
    }

    store(input.sessionID, { headEndID, summary, ts: Date.now() })
    metrics.set(input.sessionID, {
      total,
      budget,
      tail,
      head: size,
      sent,
      msgs: split.tail.length,
      ts: Date.now(),
    })
    log.info("compacted", {
      sessionID: input.sessionID,
      total,
      budget,
      tail,
      head: size,
      tail_msgs: split.tail.length,
    })
    return [synthetic(summary, input), ...split.tail]
  })

  export function invalidate(sessionID: SessionID) {
    cache.delete(sessionID)
    metrics.delete(sessionID)
    log.info("invalidate", { sessionID })
  }

  function should(input: CompactInput) {
    const opts = input.cfg.compaction?.sliding_window
    const enabled = opts?.enabled ?? Flag.OPENCODE_EXPERIMENTAL_SLIDING_WINDOW
    if (!enabled) {
      log.info("skip_disabled", { sessionID: input.sessionID })
      return false
    }
    if (input.cfg.compaction?.auto === false) {
      log.info("skip_auto_disabled", { sessionID: input.sessionID })
      return false
    }
    if ((opts?.primary_only ?? true) && input.agent.mode !== "primary") {
      log.info("skip_non_primary", { sessionID: input.sessionID, mode: input.agent.mode })
      return false
    }
    const first = input.msgs[0]
    if (first?.info.role === "assistant" && first.info.summary) {
      log.info("skip_compacted", { sessionID: input.sessionID })
      return false
    }
    if (
      first?.info.role === "user" &&
      first.parts.some((part) => part.type === "text" && part.text.includes("<context-summary>"))
    ) {
      log.info("skip_summary_present", { sessionID: input.sessionID })
      return false
    }
    if (inflight.has(input.sessionID)) {
      log.info("skip_inflight", { sessionID: input.sessionID })
      return false
    }
    return true
  }

  const estimate = Effect.fn("SlidingWindow.estimate")(function* (msgs: MessageV2.WithParts[], model: Provider.Model) {
    const out = yield* MessageV2.toModelMessagesEffect(msgs, model, { stripMedia: true })
    return Token.estimate(JSON.stringify(out))
  })

  const last = Effect.fn("SlidingWindow.last")(function* (msgs: MessageV2.WithParts[], model: Provider.Model) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.info.role !== "user") continue
      return yield* estimate(msgs.slice(i), model)
    }
    return 0
  })

  const divide = Effect.fn("SlidingWindow.divide")(function* (
    msgs: MessageV2.WithParts[],
    model: Provider.Model,
    budget: number,
  ) {
    let acc = 0
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i]
      if (!msg) continue
      acc += yield* estimate([msg], model)
      if (acc < budget) continue
      let cut = i
      while (cut > 0 && msgs[cut]?.info.role !== "user") cut--
      if (cut === 0) return undefined
      const head = msgs.slice(0, cut)
      const tail = msgs.slice(cut)
      if (head.length === 0 || tail.length === 0) return undefined
      return { head, tail }
    }
    return undefined
  })

  const summarize = Effect.fn("SlidingWindow.summarize")(function* (
    head: MessageV2.WithParts[],
    cfg: Config.Info,
    provider: Provider.Interface,
    _sessionID: SessionID,
  ) {
    const model = yield* resolveLocal(provider, cfg, "sliding-window")
    if (!model) {
      log.info("skip_no_model", { sessionID: _sessionID })
      return undefined
    }

    const language = yield* provider.getLanguage(model)
    const timeout = cfg.compaction?.sliding_window?.timeout_ms ?? 30_000
    const input = render(head)
    log.info("summarize_start", {
      sessionID: _sessionID,
      model: model.id,
      input_tokens: Token.estimate(input),
      timeout,
    })
    const text = yield* Effect.tryPromise({
      try: () =>
        generateText({
          model: wrapLanguageModel({ model: language, middleware: [] }),
          system: "You compress old session context into a precise structured summary.",
          messages: [{ role: "user", content: [SessionCompaction.SUMMARY_TEMPLATE, input].join("\n\n") }],
          temperature: 0,
          maxOutputTokens: 2048,
          abortSignal: AbortSignal.timeout(timeout),
        }).then((result) => result.text.trim()),
      catch: (err) => err,
    })
    if (!text) {
      log.info("skip_empty_summary", { sessionID: _sessionID, model: model.id })
      return undefined
    }

    log.info("summarized", {
      model: model.id,
      input_tokens: Token.estimate(input),
      output_tokens: Token.estimate(text),
    })
    return text
  })

  function render(msgs: MessageV2.WithParts[]) {
    return msgs
      .map((msg) => {
        const body = msg.parts
          .flatMap((part) => {
            if (part.type === "text") return part.text.trim() ? [part.text.trim()] : []
            if (part.type === "reasoning") return part.text.trim() ? [`[reasoning]\n${part.text.trim()}`] : []
            if (part.type === "tool" && part.state.status === "completed") {
              const out =
                typeof part.state.output === "string" ? part.state.output : (JSON.stringify(part.state.output) ?? "")
              return out ? [`[tool:${part.tool}]\n${out}`] : []
            }
            if (part.type === "tool" && part.state.status === "error") {
              return part.state.error ? [`[tool:${part.tool}:error]\n${part.state.error}`] : []
            }
            return []
          })
          .join("\n\n")
        return [`<message role="${msg.info.role}" id="${msg.info.id}">`, body || "(empty)", "</message>"].join("\n")
      })
      .join("\n\n")
  }

  function synthetic(summary: string, input: CompactInput): MessageV2.WithParts {
    const id = MessageID.ascending()
    return {
      info: {
        id,
        role: "user",
        sessionID: input.sessionID,
        time: { created: Date.now() },
        agent: input.agent.name,
        model: {
          providerID: input.model.providerID,
          modelID: input.model.id,
        },
      },
      parts: [
        {
          id: PartID.ascending(),
          sessionID: input.sessionID,
          messageID: id,
          type: "text",
          text: `<context-summary>\n${summary}\n</context-summary>`,
          synthetic: true,
        },
      ],
    }
  }

  function touch(sessionID: SessionID, entry: CacheEntry) {
    cache.delete(sessionID)
    cache.set(sessionID, { ...entry, ts: Date.now() })
  }

  function store(sessionID: SessionID, entry: CacheEntry) {
    cache.delete(sessionID)
    cache.set(sessionID, entry)
    while (cache.size > MAX) {
      const key = cache.keys().next().value as SessionID | undefined
      if (!key) break
      cache.delete(key)
    }
    while (metrics.size > MAX) {
      const key = metrics.keys().next().value as SessionID | undefined
      if (!key) break
      metrics.delete(key)
    }
  }

  export function getMetrics(sessionID: SessionID) {
    return metrics.get(sessionID)
  }
}
