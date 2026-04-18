import z from "zod"
import { BusEvent } from "../bus/bus-event"

export namespace OrchestrationEvent {
  export const Spawn = BusEvent.define(
    "orchestration.spawn",
    z.object({
      sessionID: z.string(),
      parentSessionID: z.string(),
      agent: z.string(),
      depth: z.number(),
    }),
  )

  export const SpawnRejected = BusEvent.define(
    "orchestration.spawn-rejected",
    z.object({
      sessionID: z.string(),
      agent: z.string(),
      reason: z.enum(["max_depth", "max_descendants"]),
      limit: z.number(),
      current: z.number(),
    }),
  )

  export const Complete = BusEvent.define(
    "orchestration.complete",
    z.object({
      sessionID: z.string(),
      parentSessionID: z.string(),
      agent: z.string(),
      durationMs: z.number(),
    }),
  )

  export const Abort = BusEvent.define(
    "orchestration.abort",
    z.object({
      sessionID: z.string(),
      reason: z.string(),
    }),
  )

  export const LoopDetected = BusEvent.define(
    "orchestration.loop-detected",
    z.object({
      sessionID: z.string(),
      toolName: z.string(),
      count: z.number(),
    }),
  )

  export const ConcurrencyQueued = BusEvent.define(
    "orchestration.concurrency-queued",
    z.object({
      key: z.string(),
      queueLength: z.number(),
    }),
  )

  export const ConcurrencyReleased = BusEvent.define(
    "orchestration.concurrency-released",
    z.object({
      key: z.string(),
      queueLength: z.number(),
    }),
  )

  export const Route = BusEvent.define(
    "orchestration.route",
    z.object({
      sessionID: z.string(),
      route: z.enum(["local", "cloud", "ask"]),
      operation_type: z.enum(["read", "bash_simple", "bash_complex", "code_change", "other"]).optional(),
      confidence: z.number().optional(),
      info_gap: z.enum(["high", "medium", "low"]).optional(),
      needs_code_change: z.boolean().optional(),
      assumptions_count: z.number().int(),
      verification_used: z.boolean(),
      success: z.boolean(),
      was_overridden: z.boolean(),
      override_reason: z
        .enum(["code_change", "low_confidence", "policy_bash_complex", "info_gap", "preflight_unavailable"])
        .optional(),
      preflight_fallback: z.enum(["configured", "first_local", "base", "none"]).optional(),
    }),
  )
}
