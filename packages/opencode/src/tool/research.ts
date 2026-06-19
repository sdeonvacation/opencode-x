import z from "zod"
import { Effect } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Tool } from "./tool"
import * as McpExa from "./mcp-exa"
import * as Engine from "../research/engine"
import { resolve } from "../research/tunables"
import { Provider } from "../provider/provider"
import { Config } from "../config/config"
import DESCRIPTION from "./research.txt"

const Parameters = z.object({
  question: z.string().describe("The research question to investigate"),
})

export const ResearchTool = Tool.defineEffect(
  "research",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const config = yield* Config.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: async (params: z.infer<typeof Parameters>, ctx: Tool.Context) => {
        await ctx.ask({
          permission: "research",
          patterns: [params.question],
          always: ["*"],
          metadata: { question: params.question },
        })

        const cfg = await Effect.runPromise(config.get())
        const tunables = cfg.experimental?.deep_research_tunables
        const overrides = tunables
          ? resolve({
              JURY_SIZE: tunables.jury_size,
              REJECT_QUORUM: tunables.reject_quorum,
              SOURCE_BUDGET: tunables.source_budget,
              FACT_CAP: tunables.fact_cap,
              PHASE_TIMEOUT_MS: tunables.phase_timeout_ms,
            })
          : undefined

        const model = await Provider.defaultModel()
        const resolved = await Provider.getModel(model.providerID, model.modelID)
        const language = await Provider.getLanguage(resolved)

        const search = async (query: string) => {
          const raw = await Effect.runPromise(
            McpExa.call(
              http,
              "web_search_exa",
              McpExa.SearchArgs,
              {
                query,
                type: "auto",
                numResults: 8,
                livecrawl: "fallback",
              },
              "25 seconds",
            ),
          )
          if (!raw) return []
          try {
            const parsed = JSON.parse(raw)
            if (Array.isArray(parsed))
              return parsed.map((r: any) => ({ url: r.url ?? "", title: r.title ?? "", snippet: r.snippet ?? "" }))
            if (parsed.results)
              return parsed.results.map((r: any) => ({
                url: r.url ?? "",
                title: r.title ?? "",
                snippet: r.snippet ?? "",
              }))
            return [{ url: "", title: "", snippet: raw.slice(0, 500) }]
          } catch {
            return [{ url: "", title: "", snippet: raw.slice(0, 500) }]
          }
        }

        const fetch = async (url: string) => {
          const raw = await Effect.runPromise(
            McpExa.call(
              http,
              "get_contents_exa",
              McpExa.SearchArgs,
              {
                query: url,
                type: "auto",
                numResults: 1,
                livecrawl: "preferred",
              },
              "30 seconds",
            ),
          )
          return { content: raw ?? "", title: url }
        }

        const result = await Engine.run({
          question: params.question,
          sessionID: ctx.sessionID,
          signal: ctx.abort,
          model: language,
          search,
          fetch,
          tunables: overrides ?? undefined,
        })

        const output = formatReport(result)

        return {
          title: `Research: ${result.report.title}`,
          output,
          metadata: {} as Record<string, string>,
        }
      },
    }
  }),
)

function formatReport(result: Engine.RunResult): string {
  const r = result.report
  const lines: string[] = []

  lines.push(`# ${r.title}`)
  lines.push("")
  lines.push(`**Certainty:** ${r.certainty}`)
  lines.push(`**Status:** ${result.status}`)
  lines.push("")
  lines.push("## Summary")
  lines.push(r.summary)

  for (const section of r.sections) {
    lines.push("")
    lines.push(`## ${section.heading}`)
    lines.push(section.body)
    if (section.citations.length > 0) {
      lines.push(`*Sources: ${section.citations.map((c: number) => `[${c}]`).join(", ")}*`)
    }
  }

  if (r.sources.length > 0) {
    lines.push("")
    lines.push("## Sources")
    for (const src of r.sources) {
      lines.push(`${src.index}. [${src.title}](${src.url})`)
    }
  }

  lines.push("")
  lines.push("---")
  lines.push(
    `*Stats: ${result.stats.queries} queries, ${result.stats.sources_fetched} sources, ${result.stats.facts_extracted} facts extracted, ${result.stats.facts_survived} survived, ${result.stats.facts_rejected} rejected, ${result.stats.llm_calls} LLM calls, ${(result.stats.duration_ms / 1000).toFixed(1)}s*`,
  )

  return lines.join("\n")
}
