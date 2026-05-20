import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import * as fs from "fs/promises"
import os from "os"
import path from "path"

/**
 * Tests for Claude Code plugin MCP server auto-discovery logic.
 *
 * Since the discovery is embedded in the MCP state init (Effect generator),
 * we replicate the core logic here to verify correctness of:
 * - Reading installed_plugins.json
 * - Parsing plugin.json mcpServers
 * - Resolving ${CLAUDE_PLUGIN_ROOT}
 * - User config priority
 */

// Replicates the discovery logic from src/mcp/index.ts
async function discover(config: Record<string, any>, homedir: string) {
  try {
    const manifest = path.join(homedir, ".claude", "plugins", "installed_plugins.json")
    const text = await Bun.file(manifest).text()
    const installed = JSON.parse(text)
    for (const [, entries] of Object.entries(installed.plugins ?? {})) {
      const entry = (entries as any[])?.[0]
      const dir = entry?.installPath
      if (!dir) continue
      try {
        const ptext = await Bun.file(path.join(dir, ".claude-plugin", "plugin.json")).text()
        const plugin = JSON.parse(ptext)
        for (const [name, server] of Object.entries(plugin.mcpServers ?? {})) {
          if (config[name]) continue
          const srv = server as any
          const args = (srv.args ?? []).map((a: string) => a.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, dir))
          config[name] = {
            type: "local" as const,
            command: [srv.command, ...args],
            environment: { CLAUDE_PLUGIN_ROOT: dir },
          }
        }
      } catch {}
    }
  } catch {}
}

describe("plugin MCP discovery", () => {
  let tmp: string

  beforeEach(async () => {
    tmp = path.join(os.tmpdir(), `opencode-test-plugin-${Date.now()}`)
    await fs.mkdir(tmp, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  test("discovers MCP server from plugin", async () => {
    const install = path.join(tmp, "plugins", "cache", "ctx", "1.0.0")
    await fs.mkdir(path.join(install, ".claude-plugin"), { recursive: true })
    await fs.mkdir(path.join(tmp, ".claude", "plugins"), { recursive: true })

    await Bun.write(
      path.join(tmp, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "ctx@ctx": [{ scope: "user", installPath: install }],
        },
      }),
    )

    await Bun.write(
      path.join(install, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        mcpServers: {
          "context-mode": {
            command: "node",
            args: ["${CLAUDE_PLUGIN_ROOT}/start.mjs"],
          },
        },
      }),
    )

    const config: Record<string, any> = {}
    await discover(config, tmp)

    expect(config["context-mode"]).toEqual({
      type: "local",
      command: ["node", path.join(install, "start.mjs")],
      environment: { CLAUDE_PLUGIN_ROOT: install },
    })
  })

  test("user config takes priority over discovered", async () => {
    const install = path.join(tmp, "plugins", "cache", "ctx", "1.0.0")
    await fs.mkdir(path.join(install, ".claude-plugin"), { recursive: true })
    await fs.mkdir(path.join(tmp, ".claude", "plugins"), { recursive: true })

    await Bun.write(
      path.join(tmp, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "ctx@ctx": [{ scope: "user", installPath: install }] },
      }),
    )

    await Bun.write(
      path.join(install, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        mcpServers: { "my-server": { command: "node", args: ["start.mjs"] } },
      }),
    )

    const config: Record<string, any> = {
      "my-server": { type: "local", command: ["custom-bin"] },
    }
    await discover(config, tmp)

    expect(config["my-server"]).toEqual({ type: "local", command: ["custom-bin"] })
  })

  test("handles missing installed_plugins.json gracefully", async () => {
    const config: Record<string, any> = {}
    await discover(config, tmp)
    expect(config).toEqual({})
  })

  test("handles missing plugin.json gracefully", async () => {
    const install = path.join(tmp, "plugins", "cache", "ctx", "1.0.0")
    await fs.mkdir(install, { recursive: true })
    await fs.mkdir(path.join(tmp, ".claude", "plugins"), { recursive: true })

    await Bun.write(
      path.join(tmp, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "ctx@ctx": [{ scope: "user", installPath: install }] },
      }),
    )

    const config: Record<string, any> = {}
    await discover(config, tmp)
    expect(config).toEqual({})
  })

  test("handles plugin with no mcpServers field", async () => {
    const install = path.join(tmp, "plugins", "cache", "ctx", "1.0.0")
    await fs.mkdir(path.join(install, ".claude-plugin"), { recursive: true })
    await fs.mkdir(path.join(tmp, ".claude", "plugins"), { recursive: true })

    await Bun.write(
      path.join(tmp, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "ctx@ctx": [{ scope: "user", installPath: install }] },
      }),
    )

    await Bun.write(
      path.join(install, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "ctx", version: "1.0.0" }),
    )

    const config: Record<string, any> = {}
    await discover(config, tmp)
    expect(config).toEqual({})
  })

  test("resolves multiple CLAUDE_PLUGIN_ROOT occurrences in args", async () => {
    const install = path.join(tmp, "plugins", "cache", "multi", "2.0.0")
    await fs.mkdir(path.join(install, ".claude-plugin"), { recursive: true })
    await fs.mkdir(path.join(tmp, ".claude", "plugins"), { recursive: true })

    await Bun.write(
      path.join(tmp, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "multi@multi": [{ scope: "user", installPath: install }] },
      }),
    )

    await Bun.write(
      path.join(install, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        mcpServers: {
          multi: {
            command: "node",
            args: ["${CLAUDE_PLUGIN_ROOT}/bin/run.js", "--config", "${CLAUDE_PLUGIN_ROOT}/cfg.json"],
          },
        },
      }),
    )

    const config: Record<string, any> = {}
    await discover(config, tmp)

    expect(config["multi"]).toEqual({
      type: "local",
      command: ["node", path.join(install, "bin/run.js"), "--config", path.join(install, "cfg.json")],
      environment: { CLAUDE_PLUGIN_ROOT: install },
    })
  })

  test("discovers multiple plugins", async () => {
    const install1 = path.join(tmp, "plugins", "cache", "p1", "1.0.0")
    const install2 = path.join(tmp, "plugins", "cache", "p2", "1.0.0")
    await fs.mkdir(path.join(install1, ".claude-plugin"), { recursive: true })
    await fs.mkdir(path.join(install2, ".claude-plugin"), { recursive: true })
    await fs.mkdir(path.join(tmp, ".claude", "plugins"), { recursive: true })

    await Bun.write(
      path.join(tmp, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "p1@p1": [{ scope: "user", installPath: install1 }],
          "p2@p2": [{ scope: "user", installPath: install2 }],
        },
      }),
    )

    await Bun.write(
      path.join(install1, ".claude-plugin", "plugin.json"),
      JSON.stringify({ mcpServers: { srv1: { command: "node", args: ["a.js"] } } }),
    )
    await Bun.write(
      path.join(install2, ".claude-plugin", "plugin.json"),
      JSON.stringify({ mcpServers: { srv2: { command: "python", args: ["b.py"] } } }),
    )

    const config: Record<string, any> = {}
    await discover(config, tmp)

    expect(config["srv1"]).toBeDefined()
    expect(config["srv2"]).toBeDefined()
    expect(config["srv1"].command).toEqual(["node", "a.js"])
    expect(config["srv2"].command).toEqual(["python", "b.py"])
  })

  test("skips entry with no installPath", async () => {
    await fs.mkdir(path.join(tmp, ".claude", "plugins"), { recursive: true })

    await Bun.write(
      path.join(tmp, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "bad@bad": [{ scope: "user" }] },
      }),
    )

    const config: Record<string, any> = {}
    await discover(config, tmp)
    expect(config).toEqual({})
  })

  test("handles empty plugins object", async () => {
    await fs.mkdir(path.join(tmp, ".claude", "plugins"), { recursive: true })

    await Bun.write(
      path.join(tmp, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: {} }),
    )

    const config: Record<string, any> = {}
    await discover(config, tmp)
    expect(config).toEqual({})
  })

  test("handles command with no args", async () => {
    const install = path.join(tmp, "plugins", "cache", "noargs", "1.0.0")
    await fs.mkdir(path.join(install, ".claude-plugin"), { recursive: true })
    await fs.mkdir(path.join(tmp, ".claude", "plugins"), { recursive: true })

    await Bun.write(
      path.join(tmp, ".claude", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: { "noargs@noargs": [{ scope: "user", installPath: install }] },
      }),
    )

    await Bun.write(
      path.join(install, ".claude-plugin", "plugin.json"),
      JSON.stringify({ mcpServers: { noargs: { command: "my-binary" } } }),
    )

    const config: Record<string, any> = {}
    await discover(config, tmp)

    expect(config["noargs"]).toEqual({
      type: "local",
      command: ["my-binary"],
      environment: { CLAUDE_PLUGIN_ROOT: install },
    })
  })
})
