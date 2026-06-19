import { BusEvent } from "@/bus/bus-event"
import z from "zod"

export namespace WorkflowEvent {
  export const Started = BusEvent.define(
    "workflow.started",
    z.object({
      runID: z.string(),
      name: z.string(),
      sessionID: z.string(),
    }),
  )

  export const Finished = BusEvent.define(
    "workflow.finished",
    z.object({
      runID: z.string(),
      name: z.string(),
      status: z.enum(["completed", "failed", "cancelled"]),
      error: z.string().optional(),
    }),
  )

  export const Phase = BusEvent.define(
    "workflow.phase",
    z.object({
      runID: z.string(),
      phase: z.string(),
    }),
  )

  export const Log = BusEvent.define(
    "workflow.log",
    z.object({
      runID: z.string(),
      level: z.enum(["info", "warn", "error"]),
      message: z.string(),
    }),
  )

  export const AgentFailed = BusEvent.define(
    "workflow.agent-failed",
    z.object({
      runID: z.string(),
      agent: z.string(),
      error: z.string(),
    }),
  )

  export const ChildFailed = BusEvent.define(
    "workflow.child-failed",
    z.object({
      runID: z.string(),
      child: z.string(),
      error: z.string(),
    }),
  )
}
