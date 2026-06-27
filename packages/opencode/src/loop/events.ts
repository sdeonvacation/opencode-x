import z from "zod"
import { BusEvent } from "../bus/bus-event"

export namespace LoopEvent {
  export const Created = BusEvent.define(
    "loop.created",
    z.object({
      sessionID: z.string(),
      loopID: z.string(),
      prompt: z.string(),
      intervalMs: z.number(),
    }),
  )

  export const IterationStarted = BusEvent.define(
    "loop.iteration.started",
    z.object({
      sessionID: z.string(),
      loopID: z.string(),
      iterationCount: z.number(),
      subagentSessionID: z.string(),
    }),
  )

  export const IterationComplete = BusEvent.define(
    "loop.iteration.complete",
    z.object({
      sessionID: z.string(),
      loopID: z.string(),
      iterationCount: z.number(),
      tokensUsed: z.number(),
    }),
  )

  export const Paused = BusEvent.define(
    "loop.paused",
    z.object({
      sessionID: z.string(),
      loopID: z.string(),
    }),
  )

  export const Resumed = BusEvent.define(
    "loop.resumed",
    z.object({
      sessionID: z.string(),
      loopID: z.string(),
      nextRunAt: z.number(),
    }),
  )

  export const Cancelled = BusEvent.define(
    "loop.cancelled",
    z.object({
      sessionID: z.string(),
      loopID: z.string(),
    }),
  )

  export const Expired = BusEvent.define(
    "loop.expired",
    z.object({
      sessionID: z.string(),
      loopID: z.string(),
    }),
  )

  export const BudgetExhausted = BusEvent.define(
    "loop.budget_exhausted",
    z.object({
      sessionID: z.string(),
      loopID: z.string(),
      tokensUsed: z.number(),
      tokenBudget: z.number(),
    }),
  )
}
