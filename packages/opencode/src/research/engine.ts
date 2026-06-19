import z from "zod"
import { generateObject } from "ai"
import { ResearchID, SearchPlan, Fact, FactGroup, Report, RunStats } from "./schema"
import type { RunStatus } from "./schema"
import { resolve, type Resolved } from "./tunables"
import { DedupMap, allocate } from "./url"
import * as Prompts from "./prompts"
import * as Jury from "./jury"
import { ResearchEvent } from "./events"
import { Bus } from "../bus"
import type { SessionID } from "../session/schema"
import type { LanguageModel } from "ai"

export type RunResult = {
  id: ResearchID
  report: z.infer<typeof Report>
  stats: z.infer<typeof RunStats>
  status: RunStatus
}

type SearchFn = (query: string) => Promise<Array<{ url: string; title: string; snippet: string }>>
type FetchFn = (url: string) => Promise<{ content: string; title: string }>

export async function run(input: {
  question: string
  sessionID: SessionID
  signal: AbortSignal
  model: LanguageModel
  search: SearchFn
  fetch: FetchFn
  tunables?: Partial<Resolved>
}): Promise<RunResult> {
  const id = ResearchID.generate()
  const t = resolve(input.tunables)
  const start = Date.now()
  let calls = 0

  async function gen<T>(prompt: string, schema: z.ZodType<T>): Promise<T> {
    calls++
    const result = await generateObject({
      model: input.model,
      messages: [{ role: "user", content: prompt }],
      schema,
      temperature: 0.2,
    })
    return result.object
  }

  function publish(phase: z.infer<typeof ResearchEvent.PhaseChanged.properties>["phase"], progress?: string) {
    Bus.publish(ResearchEvent.PhaseChanged, { sessionID: input.sessionID, runID: id, phase, progress })
  }

  try {
    // Phase 1: Plan
    publish("plan")
    if (input.signal.aborted) throw new Error("aborted")

    const plan = (await gen(Prompts.plan(input.question), SearchPlan)) as {
      queries: Array<{ query: string; angle: string }>
    }
    const queries = plan.queries.slice(0, t.MAX_QUERIES)

    // Phase 2: Search
    publish("search", `${queries.length} queries`)
    if (input.signal.aborted) throw new Error("aborted")

    const searchResults = await Promise.allSettled(
      queries.map((q: { query: string; angle: string }) => input.search(q.query)),
    )
    const hits: Array<{ url: string; title: string; snippet: string; relevance?: number }> = []
    for (const r of searchResults) {
      if (r.status === "fulfilled") {
        for (const hit of r.value) hits.push(hit)
      }
    }

    if (hits.length === 0) {
      const empty: RunResult = {
        id,
        report: {
          title: "No Sources Found",
          summary: "No search results were returned for the research question.",
          sections: [],
          sources: [],
          certainty: "inconclusive",
        },
        stats: {
          queries: queries.length,
          sources_fetched: 0,
          facts_extracted: 0,
          facts_survived: 0,
          facts_rejected: 0,
          llm_calls: calls,
          duration_ms: Date.now() - start,
        },
        status: "inconclusive",
      }
      Bus.publish(ResearchEvent.Completed, { sessionID: input.sessionID, runID: id, status: "inconclusive" })
      return empty
    }

    // Phase 3: Read
    publish("read", `${hits.length} hits`)
    const urls = allocate({ hits, budget: t.SOURCE_BUDGET })
    if (input.signal.aborted) throw new Error("aborted")

    const fetched = await Promise.allSettled(urls.map((url) => input.fetch(url).then((r) => ({ url, ...r }))))
    const sources: Array<{ url: string; title: string; content: string }> = []
    for (const r of fetched) {
      if (r.status === "fulfilled") sources.push(r.value)
    }

    // Phase 4: Extract
    publish("extract", `${sources.length} sources`)
    if (input.signal.aborted) throw new Error("aborted")

    const ExtractResult = z.object({ facts: z.array(Fact) })
    const extracted = await Promise.allSettled(
      sources.map((src) => gen(Prompts.extract({ question: input.question, source: src }), ExtractResult)),
    )
    const allFacts: Array<{ claim: string; source_urls: string[]; confidence: "high" | "medium" | "low" }> = []
    for (const r of extracted) {
      if (r.status === "fulfilled") {
        const val = r.value as {
          facts: Array<{ claim: string; source_urls: string[]; confidence: "high" | "medium" | "low" }>
        }
        for (const f of val.facts) allFacts.push(f)
      }
    }

    if (allFacts.length === 0) {
      const empty: RunResult = {
        id,
        report: {
          title: "No Facts Extracted",
          summary: "Could not extract verifiable facts from sources.",
          sections: [],
          sources: [],
          certainty: "inconclusive",
        },
        stats: {
          queries: queries.length,
          sources_fetched: sources.length,
          facts_extracted: 0,
          facts_survived: 0,
          facts_rejected: 0,
          llm_calls: calls,
          duration_ms: Date.now() - start,
        },
        status: "inconclusive",
      }
      Bus.publish(ResearchEvent.Completed, { sessionID: input.sessionID, runID: id, status: "inconclusive" })
      return empty
    }

    // Phase 5: Group
    publish("group", `${allFacts.length} facts`)
    if (input.signal.aborted) throw new Error("aborted")

    const GroupResult = z.object({ groups: z.array(FactGroup) })
    const grouped = (await gen(
      Prompts.group({
        question: input.question,
        facts: allFacts.map((f) => ({ claim: f.claim, source_urls: f.source_urls })),
      }),
      GroupResult,
    )) as {
      groups: Array<{
        topic: string
        facts: Array<{ claim: string; source_urls: string[]; confidence: "high" | "medium" | "low" }>
      }>
    }
    const merged: Array<{ claim: string; source_urls: string[]; confidence: "high" | "medium" | "low" }> = []
    for (const g of grouped.groups) {
      for (const f of g.facts) {
        merged.push(f)
        if (merged.length >= t.FACT_CAP) break
      }
      if (merged.length >= t.FACT_CAP) break
    }

    // Phase 6: Crosscheck
    publish("crosscheck", `${merged.length} facts × ${t.JURY_SIZE} jurors`)
    if (input.signal.aborted) throw new Error("aborted")

    const sourceMap = new Map<string, string>()
    for (const src of sources) sourceMap.set(src.url, src.content)

    const jury = await Jury.evaluate({
      facts: merged.map((f) => ({ claim: f.claim, source_urls: f.source_urls })),
      sources: sourceMap,
      generate: (prompt, schema) => gen(prompt, schema),
      tunables: t,
      signal: input.signal,
    })

    const survived = jury.filter((r) => r.verdict === "kept")
    const rejected = jury.filter((r) => r.verdict === "rejected")

    // Phase 7: Report
    publish("report")
    if (input.signal.aborted) throw new Error("aborted")

    if (survived.length === 0) {
      const empty: RunResult = {
        id,
        report: {
          title: "Inconclusive Research",
          summary: `All ${rejected.length} facts were rejected by the jury. The research question could not be answered with confidence.`,
          sections: [
            { heading: "Rejected Claims", body: rejected.map((r) => `- ${r.claim}`).join("\n"), citations: [] },
          ],
          sources: sources.map((s, i) => ({ index: i + 1, url: s.url, title: s.title })),
          certainty: "inconclusive",
        },
        stats: {
          queries: queries.length,
          sources_fetched: sources.length,
          facts_extracted: allFacts.length,
          facts_survived: 0,
          facts_rejected: rejected.length,
          llm_calls: calls,
          duration_ms: Date.now() - start,
        },
        status: "inconclusive",
      }
      Bus.publish(ResearchEvent.Completed, { sessionID: input.sessionID, runID: id, status: "inconclusive" })
      return empty
    }

    const survivedFacts = survived.map((r) => {
      const orig = merged.find((f) => f.claim === r.claim)
      return { claim: r.claim, confidence: orig?.confidence ?? "medium", source_urls: orig?.source_urls ?? [] }
    })

    const report = await gen(Prompts.report({ question: input.question, facts: survivedFacts }), Report)

    const stats: z.infer<typeof RunStats> = {
      queries: queries.length,
      sources_fetched: sources.length,
      facts_extracted: allFacts.length,
      facts_survived: survived.length,
      facts_rejected: rejected.length,
      llm_calls: calls,
      duration_ms: Date.now() - start,
    }

    Bus.publish(ResearchEvent.Completed, { sessionID: input.sessionID, runID: id, status: "completed" })

    return { id, report, stats, status: "completed" }
  } catch (err: any) {
    const status: RunStatus = input.signal.aborted ? "aborted" : "failed"
    Bus.publish(ResearchEvent.Completed, { sessionID: input.sessionID, runID: id, status })
    return {
      id,
      report: {
        title: "Research Failed",
        summary: err?.message ?? "Unknown error",
        sections: [],
        sources: [],
        certainty: "inconclusive",
      },
      stats: {
        queries: 0,
        sources_fetched: 0,
        facts_extracted: 0,
        facts_survived: 0,
        facts_rejected: 0,
        llm_calls: calls,
        duration_ms: Date.now() - start,
      },
      status,
    }
  }
}
