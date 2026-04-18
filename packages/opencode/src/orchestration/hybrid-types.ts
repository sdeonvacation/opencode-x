import type { ModelRef } from "./category-routing"

export type { ModelRef }

export type InvocationType = "chat" | "command" | "tool"

export type OperationType = "read" | "bash_simple" | "bash_complex" | "code_change" | "other"

export type OverrideReason =
  | "code_change"
  | "low_confidence"
  | "policy_bash_complex"
  | "info_gap"
  | "preflight_unavailable"

export type RouteTarget = "local" | "cloud" | "ask"

export type PreflightFallback = "configured" | "first_local" | "base" | "none"

export type PreflightInput = {
  prompt: string
  agent: string
  invocation_type: InvocationType
  command_string?: string
  operation_hint?: OperationType
  parts_summary: string
  base_model: ModelRef
}

export type PreflightResult = {
  confidence: number
  info_gap: "high" | "medium" | "low"
  needs_code_change: boolean
  operation_type: OperationType
  assumptions: string[]
  ask_candidates: string[]
  preflight_fallback?: PreflightFallback
}

export type RouteDecision = {
  target: RouteTarget
  model: ModelRef
  was_overridden: boolean
  override_reason?: OverrideReason
  assumptions: string[]
  ask_text?: string
  preflight?: PreflightResult
}

export type HybridRoutingConfig = {
  enabled: boolean
  threshold: number
  preflight_model?: ModelRef
  local_models: ModelRef[]
  verify_commands: string[]
  verify_cache_ttl_ms: number
}
