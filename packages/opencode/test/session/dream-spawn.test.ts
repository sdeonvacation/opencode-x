import { beforeEach, describe, expect, mock, test } from "bun:test"
import path from "path"
import type { SessionID } from "../../src/session/schema"
import type { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"

const spawns: Array<{ parentID: string; description: string; maxDepth: number; canTask: boolean }> = []
const projectRoot = path.join(__dirname, "../..")

// Only mock task-spawn — no other mocks to avoid poisoning sibling test files.
// Session.list/MessageV2.page use the in-memory DB (empty = no sessions = empty context).
// SessionPrompt.prompt (dynamic import in kick()) will fail but DreamSpawn catches it.
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
      await Instance.provide({
        directory: projectRoot,
        fn: () => DreamSpawn.dream("sess-1" as SessionID, agent, {} as any),
      })
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
      await Instance.provide({
        directory: projectRoot,
        fn: () => DreamSpawn.distill("sess-3" as SessionID, distillAgent, {} as any),
      })
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
      await Instance.provide({
        directory: projectRoot,
        fn: () => DS.dream("sess-2" as SessionID, agent, {} as any),
      })
    })
  })
})
