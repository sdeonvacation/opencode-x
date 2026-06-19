import { AutoDream } from "./auto-dream"
import { DreamSpawn } from "./dream-spawn"
import type { SessionID } from "./schema"
import type { Config } from "../config/config"
import type { Agent } from "../agent/agent"

export namespace DreamTrigger {
  export function check(input: { sessionID: SessionID; cfg: Config.Info; dream?: Agent.Info; distill?: Agent.Info }) {
    if (AutoDream.shouldAutoDream(input.cfg) && input.dream) {
      DreamSpawn.dream(input.sessionID, input.dream, input.cfg)
    }
    if (AutoDream.shouldAutoDistill(input.cfg) && input.distill) {
      DreamSpawn.distill(input.sessionID, input.distill, input.cfg)
    }
  }
}
