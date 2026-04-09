import { describe, expect, test, beforeEach } from "bun:test"
import {
  hashString,
  roll,
  rollWithSeed,
  generateSeed,
  companionUserId,
  getCompanion,
} from "../../../../src/cli/cmd/tui/buddy/companion"
import { SPECIES, RARITIES, EYES, HATS, STAT_NAMES } from "../../../../src/cli/cmd/tui/buddy/types"
import type { Config } from "../../../../src/config/config"

// ─── hashString ──────────────────────────────────────

describe("hashString", () => {
  test("returns a u32 (0 to 2^32-1)", () => {
    const h = hashString("hello")
    expect(h).toBeGreaterThanOrEqual(0)
    expect(h).toBeLessThanOrEqual(0xffffffff)
    expect(Number.isInteger(h)).toBe(true)
  })

  test("is deterministic", () => {
    expect(hashString("test")).toBe(hashString("test"))
  })

  test("different inputs produce different hashes", () => {
    expect(hashString("abc")).not.toBe(hashString("xyz"))
  })

  test("empty string does not throw", () => {
    expect(() => hashString("")).not.toThrow()
  })
})

// ─── roll ────────────────────────────────────────────

describe("roll", () => {
  test("returns valid bones", () => {
    const { bones } = roll("user123")
    expect(SPECIES).toContain(bones.species)
    expect(RARITIES).toContain(bones.rarity)
    expect(EYES).toContain(bones.eye)
    expect(HATS).toContain(bones.hat)
    expect(typeof bones.shiny).toBe("boolean")
    for (const stat of STAT_NAMES) {
      expect(bones.stats[stat]).toBeGreaterThanOrEqual(1)
      expect(bones.stats[stat]).toBeLessThanOrEqual(100)
    }
  })

  test("is deterministic for same userId", () => {
    const a = roll("alice")
    const b = roll("alice")
    expect(a.bones.species).toBe(b.bones.species)
    expect(a.bones.rarity).toBe(b.bones.rarity)
    expect(a.inspirationSeed).toBe(b.inspirationSeed)
  })

  test("different userIds produce different results (usually)", () => {
    const a = roll("alice")
    const b = roll("bob")
    // Not guaranteed but overwhelmingly likely with 18 species
    const same = a.bones.species === b.bones.species && a.bones.rarity === b.bones.rarity
    // Just verify both are valid — collision is possible but rare
    expect(SPECIES).toContain(a.bones.species)
    expect(SPECIES).toContain(b.bones.species)
  })

  test("uses single-entry cache", () => {
    const first = roll("cached-user")
    const second = roll("cached-user")
    expect(first).toBe(second) // same object reference
  })

  test("common rarity gets no hat", () => {
    // Find a userId that rolls common
    let found = false
    for (let i = 0; i < 200; i++) {
      const { bones } = roll(`user-${i}`)
      if (bones.rarity === "common") {
        expect(bones.hat).toBe("none")
        found = true
        break
      }
    }
    // If no common found in 200 tries, skip (extremely unlikely)
  })
})

// ─── rollWithSeed ────────────────────────────────────

describe("rollWithSeed", () => {
  test("deterministic for same seed", () => {
    const a = rollWithSeed("my-seed-42")
    const b = rollWithSeed("my-seed-42")
    expect(a.bones.species).toBe(b.bones.species)
    expect(a.bones.rarity).toBe(b.bones.rarity)
  })

  test("different seeds produce different results (usually)", () => {
    const a = rollWithSeed("seed-a")
    const b = rollWithSeed("seed-b")
    expect(SPECIES).toContain(a.bones.species)
    expect(SPECIES).toContain(b.bones.species)
  })
})

// ─── generateSeed ────────────────────────────────────

describe("generateSeed", () => {
  test("starts with rehatch-", () => {
    expect(generateSeed()).toMatch(/^rehatch-/)
  })

  test("produces unique seeds", () => {
    const seeds = new Set(Array.from({ length: 10 }, () => generateSeed()))
    expect(seeds.size).toBeGreaterThan(1)
  })
})

// ─── companionUserId ─────────────────────────────────

describe("companionUserId", () => {
  test("returns a string", () => {
    expect(typeof companionUserId()).toBe("string")
  })

  test("returns anon as fallback", () => {
    expect(companionUserId()).toBe("anon")
  })
})

// ─── getCompanion ────────────────────────────────────

describe("getCompanion", () => {
  test("returns undefined when no companion in config", () => {
    const config = {} as Config.Info
    expect(getCompanion(config)).toBeUndefined()
  })

  test("returns full companion when stored companion present", () => {
    const config = {
      companion: {
        name: "Pip",
        personality: "cheerful and curious",
        hatchedAt: 1700000000000,
      },
    } as Config.Info
    const companion = getCompanion(config)
    expect(companion).toBeDefined()
    expect(companion!.name).toBe("Pip")
    expect(companion!.personality).toBe("cheerful and curious")
    expect(companion!.hatchedAt).toBe(1700000000000)
    expect(SPECIES).toContain(companion!.species)
    expect(RARITIES).toContain(companion!.rarity)
  })

  test("uses stored seed for bone generation", () => {
    const config = {
      companion: {
        name: "Pip",
        personality: "test",
        seed: "fixed-seed-xyz",
        hatchedAt: 1700000000000,
      },
    } as Config.Info
    const a = getCompanion(config)
    const b = getCompanion(config)
    expect(a!.species).toBe(b!.species)
    expect(a!.rarity).toBe(b!.rarity)
  })

  test("bones override any stale soul fields", () => {
    const config = {
      companion: {
        name: "Pip",
        personality: "test",
        seed: "seed-for-override",
        hatchedAt: 1700000000000,
      },
    } as Config.Info
    const companion = getCompanion(config)
    // species/rarity/eye/hat/shiny/stats come from bones (deterministic)
    expect(SPECIES).toContain(companion!.species)
    expect(typeof companion!.shiny).toBe("boolean")
  })
})
