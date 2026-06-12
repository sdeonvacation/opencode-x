import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { resolve } from "path"
import { existsSync, unlinkSync } from "fs"

const root = resolve(import.meta.dirname, "../..")
const pkg = resolve(root, "package.json")
const backup = resolve(root, "package.json.bak")

describe("prepack", () => {
  afterAll(async () => {
    // Ensure we restore if test fails mid-way
    if (existsSync(backup)) {
      const original = await Bun.file(backup).text()
      await Bun.file(pkg).write(original)
      unlinkSync(backup)
    }
  })

  test("creates minimal package.json and backup", async () => {
    const before = await Bun.file(pkg).text()
    const parsed = JSON.parse(before)

    // Verify original has dependencies
    expect(parsed.dependencies).toBeDefined()
    expect(Object.keys(parsed.dependencies).length).toBeGreaterThan(0)

    // Run prepack
    const result = Bun.spawnSync(["bun", "run", "script/prepack.ts"], { cwd: root })
    expect(result.exitCode).toBe(0)

    // Verify backup created
    expect(existsSync(backup)).toBe(true)
    const backed = await Bun.file(backup).text()
    expect(backed).toBe(before)

    // Verify minimal package.json
    const minimal = JSON.parse(await Bun.file(pkg).text())
    expect(minimal.name).toBe(parsed.name)
    expect(minimal.version).toBe(parsed.version)
    expect(minimal.type).toBeUndefined()
    expect(minimal.license).toBe(parsed.license)
    expect(minimal.repository).toEqual(parsed.repository)
    expect(minimal.publishConfig).toEqual(parsed.publishConfig)
    expect(minimal.bin).toEqual(parsed.bin)
    expect(minimal.files).toEqual(parsed.files)
    expect(minimal.scripts).toEqual({ postinstall: parsed.scripts.postinstall })

    // Must NOT have these fields
    expect(minimal.dependencies).toBeUndefined()
    expect(minimal.devDependencies).toBeUndefined()
    expect(minimal.overrides).toBeUndefined()
    expect(minimal.imports).toBeUndefined()
    expect(minimal.exports).toBeUndefined()

    // No workspace:* or catalog: references anywhere
    const text = JSON.stringify(minimal)
    expect(text).not.toContain("workspace:")
    expect(text).not.toContain("catalog:")
  })

  test("postpack restores original", async () => {
    // prepack should have already run from previous test
    // If backup doesn't exist, run prepack first
    if (!existsSync(backup)) {
      Bun.spawnSync(["bun", "run", "script/prepack.ts"], { cwd: root })
    }

    const backed = await Bun.file(backup).text()

    // Run postpack
    const result = Bun.spawnSync(["bun", "run", "script/postpack.ts"], { cwd: root })
    expect(result.exitCode).toBe(0)

    // Verify restored
    const restored = await Bun.file(pkg).text()
    expect(restored).toBe(backed)

    // Backup removed
    expect(existsSync(backup)).toBe(false)
  })

  test("prepack preserves postinstall script exactly", async () => {
    const before = JSON.parse(await Bun.file(pkg).text())
    const result = Bun.spawnSync(["bun", "run", "script/prepack.ts"], { cwd: root })
    expect(result.exitCode).toBe(0)

    const minimal = JSON.parse(await Bun.file(pkg).text())
    expect(minimal.scripts.postinstall).toBe("node bin/postinstall.cjs")
    expect(minimal.scripts.postinstall).toBe(before.scripts.postinstall)

    // Cleanup
    Bun.spawnSync(["bun", "run", "script/postpack.ts"], { cwd: root })
  })

  test("round-trip preserves original package.json byte-for-byte", async () => {
    const before = await Bun.file(pkg).text()

    Bun.spawnSync(["bun", "run", "script/prepack.ts"], { cwd: root })
    Bun.spawnSync(["bun", "run", "script/postpack.ts"], { cwd: root })

    const after = await Bun.file(pkg).text()
    expect(after).toBe(before)
  })
})
