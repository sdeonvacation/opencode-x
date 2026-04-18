import type {
  PreflightResult,
  RouteDecision,
  RouteTarget,
  OverrideReason,
  HybridRoutingConfig,
  ModelRef,
} from "./hybrid-types"

/**
 * Format the ask message using the fixed template.
 */
export function formatAsk(candidates: string[], missing?: string): string {
  const m = missing ?? "additional information"
  const opts = candidates.length ? candidates.map((c, i) => `  ${i + 1}) ${c}`).join("\n") : `  1) ${m}`
  return `I need more information to proceed:\n\n- Missing: ${m}\n- Options:\n${opts}\n\nPlease clarify.`
}

/**
 * Deterministic 6-branch routing policy.
 * explicit=true means the user explicitly selected base model; override tracking applies.
 */
export function route(
  preflight: PreflightResult | undefined,
  base: ModelRef,
  cfg: HybridRoutingConfig,
  explicit: boolean,
): RouteDecision {
  const local = cfg.local_models[0] ?? base
  const cloud = base

  function decide(target: RouteTarget, model: ModelRef, reason?: OverrideReason): RouteDecision {
    const overridden = explicit && (model.providerID !== base.providerID || model.modelID !== base.modelID)
    return {
      target,
      model,
      was_overridden: overridden,
      override_reason: reason,
      assumptions: preflight?.assumptions ?? [],
      ask_text: target === "ask" ? formatAsk(preflight?.ask_candidates ?? [], undefined) : undefined,
      preflight,
    }
  }

  // Branch 1: preflight unavailable
  if (!preflight) return decide("cloud", cloud, "preflight_unavailable")

  // Branch 2: high info gap → ask
  if (preflight.info_gap === "high") {
    const overridden = explicit
    return {
      target: "ask",
      model: base,
      was_overridden: overridden,
      override_reason: "info_gap",
      assumptions: preflight.assumptions,
      ask_text: formatAsk(preflight.ask_candidates),
      preflight,
    }
  }

  // Branch 3: code change → cloud
  if (preflight.needs_code_change || preflight.operation_type === "code_change")
    return decide("cloud", cloud, "code_change")

  // Branch 4: read or bash_simple → local (confidence ignored)
  if (preflight.operation_type === "read" || preflight.operation_type === "bash_simple") return decide("local", local)

  // Branch 5: bash_complex → cloud
  if (preflight.operation_type === "bash_complex") return decide("cloud", cloud, "policy_bash_complex")

  // Branch 6: low confidence → cloud
  if (preflight.confidence < cfg.threshold) return decide("cloud", cloud, "low_confidence")

  // Branch 7: else → local
  return decide("local", local)
}
