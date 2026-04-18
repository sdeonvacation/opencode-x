import z from "zod"
import { Effect } from "effect"
import { generateObject } from "ai"
import { Provider } from "../provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { classify } from "./hybrid-heuristics"
import type { PreflightInput, PreflightResult, HybridRoutingConfig } from "./hybrid-types"

export class PreflightUnavailableError extends Error {
  constructor(msg = "All preflight models unavailable") {
    super(msg)
    this.name = "PreflightUnavailableError"
  }
}

const Schema = z.object({
  confidence: z.number().min(0).max(1),
  info_gap: z.enum(["high", "medium", "low"]),
  needs_code_change: z.boolean(),
  operation_type: z.enum(["read", "bash_simple", "bash_complex", "code_change", "other"]),
  assumptions: z.array(z.string()),
  ask_candidates: z.array(z.string()),
})

function buildPrompt(input: PreflightInput, hint?: string): string {
  return [
    "Classify the following user request for routing purposes.",
    hint ? `Heuristic hint: operation_type=${hint}` : "",
    "",
    `Agent: ${input.agent}`,
    `Invocation type: ${input.invocation_type}`,
    input.command_string ? `Command: ${input.command_string}` : "",
    "",
    "Request:",
    input.parts_summary || input.prompt,
    "",
    "Return JSON with: confidence (0-1), info_gap (high/medium/low), needs_code_change (bool),",
    "operation_type (read|bash_simple|bash_complex|code_change|other), assumptions (string[]), ask_candidates (string[]).",
  ]
    .filter(Boolean)
    .join("\n")
}

export function seed(input: PreflightInput): PreflightInput["operation_hint"] {
  if (input.operation_hint) return input.operation_hint
  if (!input.command_string) return undefined
  return classify(input.command_string)
}

export function pick(hint: PreflightInput["operation_hint"], llm: PreflightResult["operation_type"]) {
  if (hint === "read" || hint === "code_change") return hint
  if (hint === "bash_complex" || hint === "bash_simple") return hint
  return llm
}

/**
 * Run preflight classification.
 * Fallback chain: cfg.preflight_model → cfg.local_models[0] → input.base_model
 */
export const run = Effect.fn("HybridPreflight.run")(function* (input: PreflightInput, cfg: HybridRoutingConfig) {
  const provider = yield* Provider.Service

  const heuristic = seed(input)

  const candidates = [
    cfg.preflight_model
      ? {
          ref: cfg.preflight_model,
          source: "configured" as const,
        }
      : undefined,
    cfg.local_models[0]
      ? {
          ref: cfg.local_models[0],
          source: "first_local" as const,
        }
      : undefined,
    input.base_model
      ? {
          ref: input.base_model,
          source: "base" as const,
        }
      : undefined,
  ].filter(Boolean) as {
    ref: { providerID: string; modelID: string }
    source: "configured" | "first_local" | "base"
  }[]

  for (const item of candidates) {
    const resolved = yield* provider
      .getModel(ProviderID.make(item.ref.providerID), ModelID.make(item.ref.modelID))
      .pipe(Effect.option)
    if (resolved._tag === "None") continue

    const model = resolved.value
    const language = yield* provider.getLanguage(model).pipe(Effect.option)
    if (language._tag === "None") continue

    const prompt = buildPrompt(input, heuristic)
    const result = yield* Effect.promise(() =>
      generateObject({
        model: language.value,
        schema: Schema,
        messages: [{ role: "user", content: prompt }],
      })
        .then((r) => r.object)
        .catch(() => null),
    )

    if (result === null) continue

    const llm = result

    const operation_type = pick(heuristic, llm.operation_type)

    return {
      confidence: llm.confidence,
      info_gap: llm.info_gap,
      needs_code_change: llm.needs_code_change,
      operation_type,
      assumptions: llm.assumptions,
      ask_candidates: llm.ask_candidates,
      preflight_fallback: item.source,
    }
  }

  return yield* Effect.fail(new PreflightUnavailableError())
})
