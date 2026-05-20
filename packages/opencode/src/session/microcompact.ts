import { Effect } from "effect"
import { generateText, wrapLanguageModel } from "ai"
import { MessageV2 } from "./message-v2"
import { MessageID, PartID, SessionID } from "./schema"
import { Provider } from "../provider/provider"
import { Config } from "../config/config"
import { Log } from "../util/log"
import { SessionCompaction } from "./compaction"
import { resolveLocal } from "./resolve-local"

export namespace MicroCompact {
  const log = Log.create({ service: "microcompact" })

  const RECENT = 10
  const MAX_TOKENS = 2048

  export function shouldCompact(tokens: { input: number; context: number }, threshold = 0.75): boolean {
    if (tokens.context <= 0) return false
    return tokens.input / tokens.context >= threshold
  }

  export const compact = Effect.fn("MicroCompact.compact")(function* (input: {
    sessionID: SessionID
    msgs: MessageV2.WithParts[]
    model: Provider.Model
    provider: Provider.Interface
    cfg: Config.Info
  }) {
    const total = input.msgs.length
    if (total <= RECENT) return input.msgs

    const old = input.msgs.slice(0, total - RECENT)
    const recent = input.msgs.slice(total - RECENT)

    const resolved = yield* resolveLocal(input.provider, input.cfg, "microcompact")
    const target = resolved ?? input.model

    const rendered = render(old)
    const language = yield* input.provider.getLanguage(target)

    const text = yield* Effect.tryPromise({
      try: () =>
        generateText({
          model: wrapLanguageModel({ model: language, middleware: [] }),
          system:
            "You compress old session context into a precise structured summary. Preserve key facts, file paths, decisions, and technical details.",
          messages: [{ role: "user", content: [SessionCompaction.SUMMARY_TEMPLATE, rendered].join("\n\n") }],
          temperature: 0,
          maxOutputTokens: MAX_TOKENS,
          abortSignal: AbortSignal.timeout(30_000),
        }).then((r) => r.text.trim()),
      catch: (err) => err,
    }).pipe(
      Effect.catch((_err) => {
        log.error("failed", { sessionID: input.sessionID, error: String(_err) })
        return Effect.succeed<string | undefined>(undefined)
      }),
    )

    if (!text) return input.msgs

    const id = MessageID.ascending()
    const first = old[0]
    const agent = first?.info.role === "user" ? (first.info as MessageV2.User).agent : "code"

    const summary: MessageV2.WithParts = {
      info: {
        id,
        role: "user",
        sessionID: input.sessionID,
        time: { created: Date.now() },
        agent,
        model: {
          providerID: target.providerID,
          modelID: target.id,
        },
      },
      parts: [
        {
          id: PartID.ascending(),
          sessionID: input.sessionID,
          messageID: id,
          type: "text",
          text: `<context-summary>\n${text}\n</context-summary>`,
          synthetic: true,
        },
      ],
    }

    log.info("compacted", { sessionID: input.sessionID, removed: old.length, kept: recent.length })
    return [summary, ...recent]
  })

  function render(msgs: MessageV2.WithParts[]): string {
    return msgs
      .map((msg) => {
        const body = msg.parts
          .flatMap((part) => {
            if (part.type === "text") return part.text.trim() ? [part.text.trim()] : []
            if (part.type === "reasoning") return part.text.trim() ? [`[reasoning]\n${part.text.trim()}`] : []
            if (part.type === "tool" && part.state.status === "completed") {
              const out =
                typeof part.state.output === "string" ? part.state.output : (JSON.stringify(part.state.output) ?? "")
              return out ? [`[tool:${part.tool}]\n${out.slice(0, 2000)}`] : []
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
      .slice(0, 30000)
  }
}
