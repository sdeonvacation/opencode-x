import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import type { SessionID } from "../../src/session/schema"
import type { Agent } from "../../src/agent/agent"
import type { Config } from "../../src/config/config"

const spawns: Array<{ parentID: string; description: string }> = []
const autoDreamResult = { dream: false, distill: false }

mock.module("../../src/session/auto-dream", () => ({
  AutoDream: {
    shouldAutoDream: () => autoDreamResult.dream,
    shouldAutoDistill: () => autoDreamResult.distill,
    AUTO_DREAM_TITLE: "Auto Dream",
    AUTO_DISTILL_TITLE: "Auto Distill",
  },
}))

mock.module("../../src/session/dream-spawn", () => ({
  DreamSpawn: {
    dream: async (parentID: string) => {
      spawns.push({ parentID, description: "Auto Dream" })
    },
    distill: async (parentID: string) => {
      spawns.push({ parentID, description: "Auto Distill" })
    },
  },
}))

const { DreamTrigger } = await import("../../src/session/dream-trigger")

const dream: Agent.Info = { name: "dream", mode: "subagent", permission: [], options: {} }
const distill: Agent.Info = { name: "distill", mode: "subagent", permission: [], options: {} }
const cfg = { experimental: { dream_and_distill: true } } as unknown as Config.Info

beforeEach(() => {
  spawns.length = 0
  autoDreamResult.dream = false
  autoDreamResult.distill = false
})

describe("session/dream-trigger", () => {
  describe("check", () => {
    test("does nothing when both disabled", () => {
      DreamTrigger.check({ sessionID: "s1" as SessionID, cfg, dream, distill })
      expect(spawns).toHaveLength(0)
    })

    test("spawns dream when shouldAutoDream returns true", () => {
      autoDreamResult.dream = true
      DreamTrigger.check({ sessionID: "s1" as SessionID, cfg, dream, distill })
      expect(spawns).toHaveLength(1)
      expect(spawns[0].description).toBe("Auto Dream")
      expect(spawns[0].parentID).toBe("s1")
    })

    test("spawns distill when shouldAutoDistill returns true", () => {
      autoDreamResult.distill = true
      DreamTrigger.check({ sessionID: "s1" as SessionID, cfg, dream, distill })
      expect(spawns).toHaveLength(1)
      expect(spawns[0].description).toBe("Auto Distill")
    })

    test("spawns both when both enabled", () => {
      autoDreamResult.dream = true
      autoDreamResult.distill = true
      DreamTrigger.check({ sessionID: "s1" as SessionID, cfg, dream, distill })
      expect(spawns).toHaveLength(2)
    })

    test("skips dream when agent not provided", () => {
      autoDreamResult.dream = true
      DreamTrigger.check({ sessionID: "s1" as SessionID, cfg, distill })
      expect(spawns).toHaveLength(0)
    })

    test("skips distill when agent not provided", () => {
      autoDreamResult.distill = true
      DreamTrigger.check({ sessionID: "s1" as SessionID, cfg, dream })
      expect(spawns).toHaveLength(0)
    })
  })
})
