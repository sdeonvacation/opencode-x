import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { ToolRegistry } from "../../src/tool/registry"

afterEach(async () => {
  await Instance.disposeAll()
})

describe("tool.registry feature-gated tools", () => {
  test("goal_complete tool registered when goal_system enabled", async () => {
    await using tmp = await tmpdir({
      config: {
        experimental: { goal_system: true },
      } as any,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("goal_complete")
      },
    })
  })

  test("goal_complete tool NOT registered when goal_system disabled", async () => {
    await using tmp = await tmpdir({
      config: {
        experimental: { goal_system: false },
      } as any,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).not.toContain("goal_complete")
      },
    })
  })

  test("memory_persist tool registered when persistent_memory enabled", async () => {
    await using tmp = await tmpdir({
      config: {
        experimental: { persistent_memory: true },
      } as any,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("memory_persist")
      },
    })
  })

  test("memory_persist tool NOT registered when persistent_memory disabled", async () => {
    await using tmp = await tmpdir({
      config: {
        experimental: { persistent_memory: false },
      } as any,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).not.toContain("memory_persist")
      },
    })
  })

  test("both tools registered by default when no experimental config (opt-out semantics)", async () => {
    await using tmp = await tmpdir({
      config: {} as any,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("goal_complete")
        expect(ids).toContain("memory_persist")
      },
    })
  })

  test("both tools NOT registered when both flags explicitly disabled", async () => {
    await using tmp = await tmpdir({
      config: {
        experimental: { goal_system: false, persistent_memory: false },
      } as any,
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).not.toContain("goal_complete")
        expect(ids).not.toContain("memory_persist")
      },
    })
  })
})
