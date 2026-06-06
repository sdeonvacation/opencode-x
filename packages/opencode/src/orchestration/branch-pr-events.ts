import z from "zod"
import { BusEvent } from "../bus/bus-event"

export namespace BranchPREvent {
  export const Created = BusEvent.define(
    "branch-pr.created",
    z.object({
      id: z.string(),
      sessionID: z.string(),
      parentSessionID: z.string(),
      branch: z.string(),
      slug: z.string(),
    }),
  )

  export const Ready = BusEvent.define(
    "branch-pr.ready",
    z.object({
      id: z.string(),
      sessionID: z.string(),
      parentSessionID: z.string(),
      branch: z.string(),
      filesChanged: z.number(),
      insertions: z.number(),
      deletions: z.number(),
    }),
  )

  export const Merged = BusEvent.define(
    "branch-pr.merged",
    z.object({
      id: z.string(),
      sessionID: z.string(),
      branch: z.string(),
      strategy: z.string(),
    }),
  )

  export const Rejected = BusEvent.define(
    "branch-pr.rejected",
    z.object({
      id: z.string(),
      sessionID: z.string(),
      branch: z.string(),
      reason: z.string().optional(),
    }),
  )

  export const Conflict = BusEvent.define(
    "branch-pr.conflict",
    z.object({
      id: z.string(),
      sessionID: z.string(),
      branch: z.string(),
      files: z.array(z.string()),
    }),
  )
}
