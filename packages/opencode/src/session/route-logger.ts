import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import type { Config } from "@/config/config"
import { Log } from "@/util/log"
import z from "zod"

export const RouteDecided = BusEvent.define(
  "hybrid.route.decided",
  z.object({
    sessionID: z.string(),
    step: z.number(),
    route: z.enum(["cloud", "local"]),
    reason: z.string(),
    tool: z.string().optional(),
    modelID: z.string(),
    providerID: z.string(),
    complexity: z.enum(["simple", "complex", "unknown"]).optional(),
    lineCount: z.number().optional(),
    trigger: z.string().optional(),
  }),
)

export type RouteLogEntry = z.infer<typeof RouteDecided.properties>

const logger = Log.create({ service: "hybrid" })

export async function log(entry: RouteLogEntry, cfg: Config.Info) {
  await Bus.publish(RouteDecided, entry)
  if (!cfg.hybrid?.log_routing) return
  logger.info("route", entry)
}
