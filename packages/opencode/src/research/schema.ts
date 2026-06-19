import z from "zod"

export type ResearchID = string & { readonly __tag: "ResearchID" }
export const ResearchID = {
  generate: (): ResearchID => `res_${crypto.randomUUID()}` as ResearchID,
  zod: z
    .string()
    .startsWith("res_")
    .transform((s: string) => s as ResearchID),
}

export const SearchPlan = z.object({
  queries: z
    .array(
      z.object({
        query: z.string(),
        angle: z.string(),
      }),
    )
    .min(1)
    .max(6),
})

export const SearchHit = z.object({
  url: z.string().url(),
  title: z.string(),
  snippet: z.string(),
})

export const SourceRead = z.object({
  url: z.string().url(),
  title: z.string(),
  content: z.string(),
  relevance: z.number().min(0).max(1),
})

export const Fact = z.object({
  claim: z.string(),
  source_urls: z.array(z.string().url()),
  confidence: z.enum(["high", "medium", "low"]),
})

export const FactGroup = z.object({
  facts: z.array(Fact),
  topic: z.string(),
})

export const JurorRuling = z.object({
  verdict: z.enum(["support", "reject", "abstain"]),
  reasoning: z.string(),
})

export const Report = z.object({
  title: z.string(),
  summary: z.string(),
  sections: z.array(
    z.object({
      heading: z.string(),
      body: z.string(),
      citations: z.array(z.number()),
    }),
  ),
  sources: z.array(
    z.object({
      index: z.number(),
      url: z.string().url(),
      title: z.string(),
    }),
  ),
  certainty: z.enum(["high", "medium", "low", "inconclusive"]),
})

export type RunStatus = "running" | "completed" | "failed" | "aborted" | "inconclusive"

export const RunStats = z.object({
  queries: z.number(),
  sources_fetched: z.number(),
  facts_extracted: z.number(),
  facts_survived: z.number(),
  facts_rejected: z.number(),
  llm_calls: z.number(),
  duration_ms: z.number(),
})
