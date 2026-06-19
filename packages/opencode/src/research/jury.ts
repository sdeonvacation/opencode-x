import z from "zod"
import { JurorRuling } from "./schema"
import * as Prompts from "./prompts"
import type { Resolved } from "./tunables"

export type Verdict = "kept" | "rejected" | "unproven"

export type JuryResult = {
  claim: string
  verdict: Verdict
  rulings: Array<{ verdict: string; reasoning: string }>
  support: number
  reject: number
  abstain: number
}

type GenerateFn = (prompt: string, schema: z.ZodType) => Promise<unknown>

function tally(rulings: z.infer<typeof JurorRuling>[], quorum: number): Verdict {
  let support = 0
  let reject = 0
  for (const r of rulings) {
    if (r.verdict === "support") support++
    if (r.verdict === "reject") reject++
  }
  if (reject >= quorum) return "rejected"
  if (support >= quorum) return "kept"
  return "unproven"
}

export async function evaluate(input: {
  facts: Array<{ claim: string; source_urls: string[] }>
  sources: Map<string, string>
  generate: GenerateFn
  tunables: Resolved
  signal?: AbortSignal
}): Promise<JuryResult[]> {
  const results: JuryResult[] = []

  for (const fact of input.facts) {
    if (input.signal?.aborted) break

    const context = fact.source_urls.map((url) => input.sources.get(url)).filter(Boolean) as string[]

    const rulings: z.infer<typeof JurorRuling>[] = []
    const jurors = Array.from({ length: input.tunables.JURY_SIZE }, (_, i) => i)

    const settled = await Promise.allSettled(
      jurors.map(async () => {
        const prompt = Prompts.crosscheck({ claim: fact.claim, sources: context })
        const raw = await input.generate(prompt, JurorRuling)
        return JurorRuling.parse(raw)
      }),
    )

    for (const r of settled) {
      if (r.status === "fulfilled") rulings.push(r.value)
    }

    const verdict = tally(rulings, input.tunables.REJECT_QUORUM)
    results.push({
      claim: fact.claim,
      verdict,
      rulings: rulings.map((r) => ({ verdict: r.verdict, reasoning: r.reasoning })),
      support: rulings.filter((r) => r.verdict === "support").length,
      reject: rulings.filter((r) => r.verdict === "reject").length,
      abstain: rulings.filter((r) => r.verdict === "abstain").length,
    })
  }

  return results
}
