import { afterEach, describe, expect, test } from "bun:test"
import z from "zod"
import { Agent } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { MCP } from "../../src/mcp"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Plugin } from "../../src/plugin"
import { ToolRegistry } from "../../src/tool/registry"
import { Tool } from "../../src/tool/tool"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

async function waitFor(check: () => boolean | Promise<boolean>, timeout = 2000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out waiting for condition")
}

describe("tool.registry cache", () => {
  test("cache hit reuses initialized tool definitions", async () => {
    await using tmp = await tmpdir()
    let initCount = 0
    const model = {
      providerID: ProviderID.openai,
      modelID: ModelID.make("gpt-4.1"),
    }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await ToolRegistry.register(
          Tool.define("cache_hit_tool", async () => {
            initCount++
            return {
              description: "cache hit tool",
              parameters: z.object({}),
              execute: async () => ({ title: "", output: "ok", metadata: {} }),
            }
          }),
        )

        await ToolRegistry.tools(model)
        await ToolRegistry.tools(model)

        expect(initCount).toBe(1)
      },
    })
  })

  test("cache miss when model changes", async () => {
    await using tmp = await tmpdir()
    let initCount = 0

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await ToolRegistry.register(
          Tool.define("cache_model_tool", async () => {
            initCount++
            return {
              description: "cache model tool",
              parameters: z.object({}),
              execute: async () => ({ title: "", output: "ok", metadata: {} }),
            }
          }),
        )

        await ToolRegistry.tools({
          providerID: ProviderID.openai,
          modelID: ModelID.make("gpt-4.1"),
        })
        await ToolRegistry.tools({
          providerID: ProviderID.openai,
          modelID: ModelID.make("gpt-4.1-mini"),
        })

        expect(initCount).toBe(2)
      },
    })
  })

  test("cache miss when agent changes", async () => {
    await using tmp = await tmpdir()
    let initCount = 0
    const model = {
      providerID: ProviderID.openai,
      modelID: ModelID.make("gpt-4.1"),
    }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const build = await Agent.get("build")
        const general = await Agent.get("general")

        await ToolRegistry.register(
          Tool.define("cache_agent_tool", async () => {
            initCount++
            return {
              description: "cache agent tool",
              parameters: z.object({}),
              execute: async () => ({ title: "", output: "ok", metadata: {} }),
            }
          }),
        )

        await ToolRegistry.tools(model, build)
        await ToolRegistry.tools(model, general)

        expect(initCount).toBe(2)
      },
    })
  })

  test("register invalidates cache even when count is unchanged", async () => {
    await using tmp = await tmpdir()
    let initCount = 0
    const model = {
      providerID: ProviderID.openai,
      modelID: ModelID.make("gpt-4.1"),
    }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await ToolRegistry.register(
          Tool.define("cache_invalidation_tool", async () => {
            initCount++
            return {
              description: "v1",
              parameters: z.object({}),
              execute: async () => ({ title: "", output: "ok", metadata: {} }),
            }
          }),
        )

        const first = await ToolRegistry.tools(model)
        expect(first.find((tool) => tool.id === "cache_invalidation_tool")?.description).toBe("v1")

        await ToolRegistry.register(
          Tool.define("cache_invalidation_tool", async () => {
            initCount++
            return {
              description: "v2",
              parameters: z.object({}),
              execute: async () => ({ title: "", output: "ok", metadata: {} }),
            }
          }),
        )

        const second = await ToolRegistry.tools(model)
        expect(second.find((tool) => tool.id === "cache_invalidation_tool")?.description).toBe("v2")
        expect(initCount).toBe(2)
      },
    })
  })

  test("mcp tools changed invalidates cache", async () => {
    await using tmp = await tmpdir()
    let initCount = 0
    const model = {
      providerID: ProviderID.openai,
      modelID: ModelID.make("gpt-4.1"),
    }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await ToolRegistry.register(
          Tool.define("cache_mcp_tool", async () => {
            initCount++
            return {
              description: "mcp cache tool",
              parameters: z.object({}),
              execute: async () => ({ title: "", output: "ok", metadata: {} }),
            }
          }),
        )

        await ToolRegistry.tools(model)
        await Bus.publish(MCP.ToolsChanged, { server: "demo" })
        await waitFor(async () => {
          await ToolRegistry.tools(model)
          return initCount === 2
        })

        expect(initCount).toBe(2)
      },
    })
  })

  test("mcp tools changed publishes tool registry change signal", async () => {
    await using tmp = await tmpdir()
    let changed = 0

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await ToolRegistry.ids()
        const unsub = Bus.subscribe(ToolRegistry.Changed, () => {
          changed++
        })
        try {
          await Bus.publish(MCP.ToolsChanged, { server: "demo" })
          await waitFor(() => changed === 1)
          expect(changed).toBe(1)
        } finally {
          unsub()
        }
      },
    })
  })

  test("plugin tool.definition function change invalidates cache", async () => {
    await using tmp = await tmpdir()
    let initCount = 0
    let pluginVersion = "v1"
    const model = {
      providerID: ProviderID.openai,
      modelID: ModelID.make("gpt-4.1"),
    }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await ToolRegistry.register(
          Tool.define("cache_plugin_tool", async () => {
            initCount++
            return {
              description: "base",
              parameters: z.object({}),
              execute: async () => ({ title: "", output: "ok", metadata: {} }),
            }
          }),
        )

        const hooks = await Plugin.list()
        const hook: any = {
          "tool.definition": async (_input: any, output: any) => {
            output.description = pluginVersion
          },
        }
        hooks.push(hook)

        let pluginChanged = 0
        const unsub = Bus.subscribe(ToolRegistry.Changed, (evt) => {
          if (evt.properties.reason === "plugin") pluginChanged++
        })

        try {
          const first = await ToolRegistry.tools(model)
          expect(first.find((tool) => tool.id === "cache_plugin_tool")?.description).toBe("v1")

          pluginVersion = "v2"
          hook["tool.definition"] = async (_input: any, output: any) => {
            output.description = pluginVersion
          }
          const second = await ToolRegistry.tools(model)
          expect(second.find((tool) => tool.id === "cache_plugin_tool")?.description).toBe("v2")
          expect(initCount).toBe(2)
          await waitFor(() => pluginChanged > 0)
          expect(pluginChanged).toBeGreaterThan(0)
        } finally {
          unsub()
        }
      },
    })
  })

  test("tool registry changed signal invalidates cache", async () => {
    await using tmp = await tmpdir()
    let initCount = 0
    const model = {
      providerID: ProviderID.openai,
      modelID: ModelID.make("gpt-4.1"),
    }

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await ToolRegistry.register(
          Tool.define("cache_registry_changed_tool", async () => {
            initCount++
            return {
              description: "registry changed tool",
              parameters: z.object({}),
              execute: async () => ({ title: "", output: "ok", metadata: {} }),
            }
          }),
        )

        await ToolRegistry.tools(model)
        await Bus.publish(ToolRegistry.Changed, { reason: "mcp" })
        await waitFor(async () => {
          await ToolRegistry.tools(model)
          return initCount === 2
        })

        expect(initCount).toBe(2)
      },
    })
  })
})
