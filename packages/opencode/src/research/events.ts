import z from "zod"
import { BusEvent } from "../bus/bus-event"

export const ResearchEvent = {
  PhaseChanged: BusEvent.define(
    "research.phase-changed",
    z.object({
      sessionID: z.string(),
      runID: z.string(),
      phase: z.enum(["plan", "search", "read", "extract", "group", "crosscheck", "report"]),
      progress: z.string().optional(),
    }),
  ),
  Completed: BusEvent.define(
    "research.completed",
    z.object({
      sessionID: z.string(),
      runID: z.string(),
      status: z.enum(["completed", "failed", "aborted", "inconclusive"]),
    }),
  ),
}
