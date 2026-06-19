import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { SessionID } from "../../src/session/schema"
import type { Agent } from "../../src/agent/agent"

const spawns: Array<{ parentID: string; description: string; maxDepth: number; canTask: boolean }> = []

mock.module("../../src/session/index", () => ({
  Session: {
    list: function* () {},
  },
}))

mock.module("../../src/session/message-v2", () => ({
  MessageV2: {
    page: () => ({ items: [], more: false }),
  },
}))

mock.module("../../src/orchestration/task-spawn", () => ({
  spawnSubagent: async (_existing: unknown, input: any) => {
    spawns.push({
      parentID: input.parentSessionID,
      description: input.description,
      maxDepth: input.maxDepth,
      canTask: input.canTask,
    })
    return { session: { id: "child-1" }, spawnInfo: {}, spawned: true }
  },
}))

mock.module("../../src/session/prompt", () => ({
  SessionPrompt: {
    prompt: async () => ({ parts: [] }),
  },
}))

mock.module("../../src/util/log", () => ({
  Log: {
    create: () => ({
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
    }),
  },
}))

mock.module("../../src/storage/db", () => ({
  Database: { use: () => [], close: () => {} },
  like: () => undefined,
  desc: () => undefined,
  asc: () => undefined,
}))

mock.module("../../src/flag/flag", () => ({
  Flag: { OPENCODE_EXPERIMENTAL_DREAM: true },
}))

mock.module("../../src/session/session.sql", () => ({
  SessionTable: { title: "title", time_created: "time_created" },
}))

const { DreamSpawn } = await import("../../src/session/dream-spawn")

const agent: Agent.Info = {
  name: "dream",
  mode: "subagent",
  permission: [],
  options: {},
}

beforeEach(() => {
  spawns.length = 0
})

describe("session/dream-spawn", () => {
  describe("dream", () => {
    test("spawns subagent with correct input", async () => {
      await DreamSpawn.dream("sess-1" as SessionID, agent)
      expect(spawns).toHaveLength(1)
      expect(spawns[0].parentID).toBe("sess-1")
      expect(spawns[0].description).toBe("Auto Dream")
      expect(spawns[0].maxDepth).toBe(1)
      expect(spawns[0].canTask).toBe(false)
    })
  })

  describe("distill", () => {
    test("spawns subagent with correct input", async () => {
      const distillAgent: Agent.Info = { name: "distill", mode: "subagent", permission: [], options: {} }
      await DreamSpawn.distill("sess-3" as SessionID, distillAgent)
      expect(spawns).toHaveLength(1)
      expect(spawns[0].parentID).toBe("sess-3")
      expect(spawns[0].description).toBe("Auto Distill")
      expect(spawns[0].maxDepth).toBe(1)
    })
  })

  describe("error handling", () => {
    test("does not throw on spawn failure", async () => {
      mock.module("../../src/orchestration/task-spawn", () => ({
        spawnSubagent: async () => {
          throw new Error("spawn limit")
        },
      }))
      const { DreamSpawn: DS } = await import("../../src/session/dream-spawn")
      // Should not throw
      await DS.dream("sess-2" as SessionID, agent)
    })
  })
})
