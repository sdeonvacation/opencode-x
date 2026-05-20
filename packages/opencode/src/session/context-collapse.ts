import { Effect } from "effect"
import { generateText, wrapLanguageModel } from "ai"
import { MessageV2 } from "./message-v2"
import { MessageID, PartID, SessionID } from "./schema"
import { Provider } from "../provider/provider"
import { Log } from "../util/log"
import { Global } from "../global"
import { SessionCompaction } from "./compaction"
import { resolveLocal } from "./resolve-local"
import { Config } from "../config/config"
import path from "path"
import fs from "fs"

export namespace ContextCollapse {
  const log = Log.create({ service: "context-collapse" })

  export function shouldCollapse(tokens: { input: number; context: number }, threshold = 0.97): boolean {
    if (tokens.context <= 0) return false
    return tokens.input / tokens.context >= threshold
  }

  export const collapse = Effect.fn("ContextCollapse.collapse")(function* (input: {
    sessionID: SessionID
    msgs: MessageV2.WithParts[]
    model: Provider.Model
    provider: Provider.Interface
    cfg: Config.Info
  }) {
    const dir = path.join(Global.Path.log, "collapse")
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${input.sessionID}-${Date.now()}.json`)
    fs.writeFileSync(
      file,
      JSON.stringify(
        input.msgs.map((m) => ({ id: m.info.id, role: m.info.role, parts: m.parts })),
        null,
        2,
      ),
    )
    log.info("backup", { sessionID: input.sessionID, file })

    const last = input.msgs.findLast((m) => m.info.role === "user")

    const resolved = yield* resolveLocal(input.provider, input.cfg, "context-collapse")
    const target = resolved ?? input.model

    const rendered = render(input.msgs)
    const language = yield* input.provider.getLanguage(target)

    const text = yield* Effect.tryPromise({
      try: () =>
        generateText({
          model: wrapLanguageModel({ model: language, middleware: [] }),
          system:
            "You are an emergency context summarizer. Summarize the conversation history using the template below. Focus on: current task, key decisions, files modified, next steps.",
          messages: [{ role: "user", content: [SessionCompaction.SUMMARY_TEMPLATE, rendered].join("\n\n") }],
          temperature: 0,
          maxOutputTokens: 2048,
          abortSignal: AbortSignal.timeout(30_000),
        }).then((r) => r.text.trim()),
      catch: (err) => err,
    }).pipe(
      Effect.catch((_err) => {
        log.error("failed", { sessionID: input.sessionID, error: String(_err) })
        return Effect.succeed<string | undefined>(undefined)
      }),
    )

    if (!text) return input.msgs.slice(-4)

    const id = MessageID.ascending()
    const agent = input.msgs[0]?.info.role === "user" ? (input.msgs[0].info as MessageV2.User).agent : "code"
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
          text: `<emergency-context-collapse>\n${text}\n</emergency-context-collapse>`,
          synthetic: true,
        },
      ],
    }

    const out: MessageV2.WithParts[] = [summary]
    if (last) out.push(last)

    log.info("collapsed", { sessionID: input.sessionID, from: input.msgs.length, to: out.length })
    return out
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
      .slice(0, 50000)
  }
}
