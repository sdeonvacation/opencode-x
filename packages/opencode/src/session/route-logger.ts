import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import type { Config } from "@/config/config"
import { Log } from "@/util/log"
import z from "zod"

export const CompressionEligible = BusEvent.define(
  "hybrid.compression.eligible",
  z.object({
    sessionID: z.string(),
    step: z.number(),
    tool: z.string().optional(),
    modelID: z.string(),
    providerID: z.string(),
    eligible: z.boolean(),
    reason: z.string(),
    lineCount: z.number().optional(),
  }),
)

export type RouteLogEntry = z.infer<typeof CompressionEligible.properties>

const logger = Log.create({ service: "hybrid" })

export async function log(entry: RouteLogEntry, cfg: Config.Info) {
  await Bus.publish(CompressionEligible, entry)
  if (!cfg.hybrid?.log_routing) return
  logger.info("compression", entry)
}
