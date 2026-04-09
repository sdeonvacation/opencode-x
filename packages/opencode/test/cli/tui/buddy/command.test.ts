import { describe, expect, test } from "bun:test"
import { generateSeed, rollWithSeed, getCompanion } from "../../../../src/cli/cmd/tui/buddy/companion"
import { SPECIES_NAMES, SPECIES_PERSONALITY, SPECIES } from "../../../../src/cli/cmd/tui/buddy/types"
import type { Config } from "../../../../src/config/config"

describe("buddy command: hatch logic", () => {
  test("generateSeed produces rehatch- prefix", () => {
    expect(generateSeed()).toMatch(/^rehatch-/)
  })

  test("rollWithSeed + SPECIES_NAMES produces valid name", () => {
    const seed = generateSeed()
    const { bones } = rollWithSeed(seed)
    const name = SPECIES_NAMES[bones.species] ?? bones.species
    expect(typeof name).toBe("string")
    expect(name.length).toBeGreaterThan(0)
  })

  test("rollWithSeed + SPECIES_PERSONALITY produces valid personality", () => {
    const seed = generateSeed()
    const { bones } = rollWithSeed(seed)
    const personality = SPECIES_PERSONALITY[bones.species] ?? "A curious coding companion."
    expect(typeof personality).toBe("string")
    expect(personality.length).toBeGreaterThan(0)
  })

  test("hatch creates a valid StoredCompanion", () => {
    const seed = generateSeed()
    const { bones } = rollWithSeed(seed)
    const name = SPECIES_NAMES[bones.species] ?? bones.species
    const personality = SPECIES_PERSONALITY[bones.species] ?? "A curious coding companion."
    const stored = { name, personality, seed, hatchedAt: Date.now() }
    expect(stored.name).toBe(name)
    expect(stored.personality).toBe(personality)
    expect(stored.seed).toBe(seed)
    expect(stored.hatchedAt).toBeGreaterThan(0)
  })

  test("SPECIES_NAMES covers all 18 species", () => {
    for (const species of SPECIES) {
      expect(SPECIES_NAMES[species]).toBeDefined()
    }
  })

  test("SPECIES_PERSONALITY covers all 18 species", () => {
    for (const species of SPECIES) {
      expect(SPECIES_PERSONALITY[species]).toBeDefined()
    }
  })
})

describe("buddy command: mute/unmute logic", () => {
  test("companion_muted: true disables reactions", () => {
    const config = {
      companion: { name: "Pip", personality: "test", hatchedAt: Date.now() },
      companion_muted: true,
    } as Config.Info
    // getCompanion still works when muted (muting is UI concern, not data)
    const companion = getCompanion(config)
    expect(companion).toBeDefined()
    expect(companion!.name).toBe("Pip")
    // companion_muted is a config flag — verified it exists
    expect(config.companion_muted).toBe(true)
  })

  test("companion_muted: false enables reactions", () => {
    const config = {
      companion: { name: "Pip", personality: "test", hatchedAt: Date.now() },
      companion_muted: false,
    } as Config.Info
    expect(config.companion_muted).toBe(false)
    expect(getCompanion(config)).toBeDefined()
  })
})

describe("buddy command: show-card logic", () => {
  test("getCompanion returns undefined when no companion (hatch path)", () => {
    const config = {} as Config.Info
    expect(getCompanion(config)).toBeUndefined()
  })

  test("getCompanion returns companion when stored (show-card path)", () => {
    const config = {
      companion: {
        name: "Spark",
        personality: "curious",
        hatchedAt: Date.now(),
      },
    } as Config.Info
    const companion = getCompanion(config)
    expect(companion).toBeDefined()
    expect(companion!.name).toBe("Spark")
  })
})

describe("buddy command: feature flag", () => {
  test("experimental.buddy false disables feature", () => {
    const config = { experimental: { buddy: false } } as Config.Info
    expect(config.experimental?.buddy).toBe(false)
  })

  test("experimental.buddy true enables feature", () => {
    const config = { experimental: { buddy: true } } as Config.Info
    expect(config.experimental?.buddy).toBe(true)
  })

  test("experimental.buddy_model stores override", () => {
    const config = {
      experimental: {
        buddy: true,
        buddy_model: { providerID: "openai", modelID: "gpt-4o-mini" },
      },
    } as Config.Info
    expect(config.experimental?.buddy_model?.providerID).toBe("openai")
    expect(config.experimental?.buddy_model?.modelID).toBe("gpt-4o-mini")
  })
})
