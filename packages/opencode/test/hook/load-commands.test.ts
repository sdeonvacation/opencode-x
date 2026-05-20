import { afterEach, describe, expect, spyOn, test } from "bun:test"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { Hook } from "../../src/hook/hook"

describe("Hook.loadCommands", () => {
  let tmp: string
  let spy: ReturnType<typeof spyOn>

  async function setup() {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-hook-test-"))
    spy = spyOn(os, "homedir").mockReturnValue(tmp)
  }

  afterEach(async () => {
    spy?.mockRestore()
    if (tmp) await fs.rm(tmp, { recursive: true, force: true })
  })

  test("returns empty when no files exist", async () => {
    await setup()
    const result = await Hook.loadCommands()
    expect(result).toEqual([])
  })

  test("reads commands from commands.json", async () => {
    await setup()
    const dir = path.join(tmp, ".claude", "hooks")
    await fs.mkdir(dir, { recursive: true })
    await Bun.write(
      path.join(dir, "commands.json"),
      JSON.stringify([{ name: "foo", description: "do foo" }, { name: "bar" }, { invalid: true }, null]),
    )
    const result = await Hook.loadCommands()
    expect(result).toEqual([
      { name: "foo", description: "do foo" },
      { name: "bar", description: undefined },
    ])
  })

  test("discovers plugin skills from installed_plugins.json", async () => {
    await setup()
    const install = path.join(tmp, "plugins", "caveman")
    const skills = path.join(install, "skills", "caveman")
    await fs.mkdir(skills, { recursive: true })
    await Bun.write(
      path.join(skills, "SKILL.md"),
      `---
name: caveman
description: >
  Ultra-compressed communication mode.
---
Content here.`,
    )

    const manifest = path.join(tmp, ".claude", "plugins")
    await fs.mkdir(manifest, { recursive: true })
    await Bun.write(
      path.join(manifest, "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "caveman@caveman": [{ installPath: install }],
        },
      }),
    )

    const result = await Hook.loadCommands()
    expect(result).toEqual([{ name: "caveman", description: "Ultra-compressed communication mode." }])
  })

  test("extracts trigger-based command name", async () => {
    await setup()
    const install = path.join(tmp, "plugins", "context-mode")
    const skills = path.join(install, "skills", "ctx-stats")
    await fs.mkdir(skills, { recursive: true })
    await Bun.write(
      path.join(skills, "SKILL.md"),
      `---
name: ctx-stats
description: |
  Show context savings.
  Trigger: /context-mode:ctx-stats
---
Body.`,
    )

    const manifest = path.join(tmp, ".claude", "plugins")
    await fs.mkdir(manifest, { recursive: true })
    await Bun.write(
      path.join(manifest, "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "context-mode@context-mode": [{ installPath: install }],
        },
      }),
    )

    const result = await Hook.loadCommands()
    expect(result).toEqual([{ name: "context-mode:ctx-stats", description: "Show context savings." }])
  })

  test("commands.json entries take priority over plugin skills", async () => {
    await setup()
    // commands.json declares "caveman"
    const hooks = path.join(tmp, ".claude", "hooks")
    await fs.mkdir(hooks, { recursive: true })
    await Bun.write(path.join(hooks, "commands.json"), JSON.stringify([{ name: "caveman", description: "override" }]))

    // plugin also declares "caveman"
    const install = path.join(tmp, "plugins", "caveman")
    const skills = path.join(install, "skills", "caveman")
    await fs.mkdir(skills, { recursive: true })
    await Bun.write(
      path.join(skills, "SKILL.md"),
      `---
name: caveman
description: from plugin
---`,
    )

    const plugins = path.join(tmp, ".claude", "plugins")
    await fs.mkdir(plugins, { recursive: true })
    await Bun.write(
      path.join(plugins, "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "caveman@caveman": [{ installPath: install }] } }),
    )

    const result = await Hook.loadCommands()
    expect(result).toEqual([{ name: "caveman", description: "override" }])
  })

  test("multiple skills from same plugin", async () => {
    await setup()
    const install = path.join(tmp, "plugins", "caveman")
    for (const skill of ["caveman", "caveman-help"]) {
      const dir = path.join(install, "skills", skill)
      await fs.mkdir(dir, { recursive: true })
      await Bun.write(
        path.join(dir, "SKILL.md"),
        `---
name: ${skill}
description: ${skill} desc
---`,
      )
    }

    const manifest = path.join(tmp, ".claude", "plugins")
    await fs.mkdir(manifest, { recursive: true })
    await Bun.write(
      path.join(manifest, "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "caveman@caveman": [{ installPath: install }] } }),
    )

    const result = await Hook.loadCommands()
    expect(result.length).toBe(2)
    expect(result.map((r) => r.name).sort()).toEqual(["caveman", "caveman-help"])
  })

  test("skips skills without name in frontmatter", async () => {
    await setup()
    const install = path.join(tmp, "plugins", "broken")
    const skills = path.join(install, "skills", "no-name")
    await fs.mkdir(skills, { recursive: true })
    await Bun.write(path.join(skills, "SKILL.md"), `---\ndescription: no name field\n---`)

    const manifest = path.join(tmp, ".claude", "plugins")
    await fs.mkdir(manifest, { recursive: true })
    await Bun.write(
      path.join(manifest, "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "broken@broken": [{ installPath: install }] } }),
    )

    const result = await Hook.loadCommands()
    expect(result).toEqual([])
  })

  test("handles invalid JSON in commands.json gracefully", async () => {
    await setup()
    const dir = path.join(tmp, ".claude", "hooks")
    await fs.mkdir(dir, { recursive: true })
    await Bun.write(path.join(dir, "commands.json"), "not json{")
    const result = await Hook.loadCommands()
    expect(result).toEqual([])
  })

  test("handles invalid JSON in installed_plugins.json gracefully", async () => {
    await setup()
    const dir = path.join(tmp, ".claude", "plugins")
    await fs.mkdir(dir, { recursive: true })
    await Bun.write(path.join(dir, "installed_plugins.json"), "{corrupt")
    const result = await Hook.loadCommands()
    expect(result).toEqual([])
  })

  test("inline description without multiline syntax", async () => {
    await setup()
    const install = path.join(tmp, "plugins", "test")
    const skills = path.join(install, "skills", "simple")
    await fs.mkdir(skills, { recursive: true })
    await Bun.write(
      path.join(skills, "SKILL.md"),
      `---
name: simple
description: A simple inline description
---`,
    )

    const manifest = path.join(tmp, ".claude", "plugins")
    await fs.mkdir(manifest, { recursive: true })
    await Bun.write(
      path.join(manifest, "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "test@test": [{ installPath: install }] } }),
    )

    const result = await Hook.loadCommands()
    expect(result).toEqual([{ name: "simple", description: "A simple inline description" }])
  })
})
