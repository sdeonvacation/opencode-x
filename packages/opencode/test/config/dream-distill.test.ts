import { test, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "../../src/util/filesystem"

const managedConfigDir = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR!

beforeEach(async () => {
  await Config.invalidate(true)
})

afterEach(async () => {
  await fs.rm(managedConfigDir, { force: true, recursive: true }).catch(() => {})
  await Config.invalidate(true)
})

async function writeConfig(dir: string, config: object) {
  await Filesystem.write(path.join(dir, "opencode.json"), JSON.stringify(config))
}

test("parses dream config section", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        dream: { auto: true, interval_days: 7 },
      })
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.dream?.auto).toBe(true)
      expect(config.dream?.interval_days).toBe(7)
    },
  })
})

test("parses distill config section", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        distill: { auto: true, interval_days: 30 },
      })
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.distill?.auto).toBe(true)
      expect(config.distill?.interval_days).toBe(30)
    },
  })
})

test("dream and distill default to undefined", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {})
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.dream).toBeUndefined()
      expect(config.distill).toBeUndefined()
    },
  })
})

test("experimental.dream_and_distill flag parses", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        experimental: { dream_and_distill: true },
      })
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const config = await Config.get()
      expect(config.experimental?.dream_and_distill).toBe(true)
    },
  })
})

test("dream rejects invalid interval_days", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        dream: { interval_days: -1 },
      })
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(Config.get()).rejects.toThrow("ConfigInvalidError")
    },
  })
})

test("distill rejects non-integer interval_days", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      await writeConfig(dir, {
        distill: { interval_days: 3.5 },
      })
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await expect(Config.get()).rejects.toThrow("ConfigInvalidError")
    },
  })
})
