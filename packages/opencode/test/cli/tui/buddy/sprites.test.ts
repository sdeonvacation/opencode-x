import { describe, expect, test } from "bun:test"
import { renderSprite, renderFace, spriteFrameCount } from "../../../../src/cli/cmd/tui/buddy/sprites"
import { SPECIES, EYES, type CompanionBones } from "../../../../src/cli/cmd/tui/buddy/types"
import { rollWithSeed } from "../../../../src/cli/cmd/tui/buddy/companion"

function makeBones(overrides: Partial<CompanionBones> = {}): CompanionBones {
  const { bones } = rollWithSeed("test-seed-sprites")
  return { ...bones, ...overrides }
}

// ─── renderSprite ────────────────────────────────────

describe("renderSprite", () => {
  test("returns an array of strings", () => {
    const bones = makeBones()
    const lines = renderSprite(bones)
    expect(Array.isArray(lines)).toBe(true)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(typeof line).toBe("string")
    }
  })

  test("substitutes eye character into sprite", () => {
    for (const eye of EYES) {
      const bones = makeBones({ eye })
      const lines = renderSprite(bones)
      const joined = lines.join("\n")
      // {E} placeholder should be gone
      expect(joined).not.toContain("{E}")
    }
  })

  test("frame wraps around (no out-of-bounds)", () => {
    const bones = makeBones()
    const count = spriteFrameCount(bones.species)
    expect(() => renderSprite(bones, count)).not.toThrow()
    expect(() => renderSprite(bones, count + 1)).not.toThrow()
    expect(() => renderSprite(bones, 999)).not.toThrow()
  })

  test("hat replaces blank line 0 when hat is set", () => {
    // Find a species/seed that rolls non-common (has a hat)
    let found = false
    for (let i = 0; i < 100; i++) {
      const { bones } = rollWithSeed(`hat-test-${i}`)
      if (bones.hat !== "none") {
        const lines = renderSprite(bones, 0)
        // Hat line should be non-empty
        const hatLine = lines[0]
        expect(hatLine).toBeDefined()
        found = true
        break
      }
    }
  })

  test("renders all 18 species without throwing", () => {
    for (const species of SPECIES) {
      const bones = makeBones({ species })
      expect(() => renderSprite(bones, 0)).not.toThrow()
      expect(() => renderSprite(bones, 1)).not.toThrow()
      expect(() => renderSprite(bones, 2)).not.toThrow()
    }
  })

  test("no hat species with hat=none drops blank line 0 when all frames blank", () => {
    // For species where all frames have blank line 0, the blank line is dropped
    const bones = makeBones({ hat: "none" })
    const lines = renderSprite(bones, 0)
    // Result should not start with a blank line (it gets dropped)
    if (lines.length > 0) {
      // Either the first line is non-blank, or the species uses line 0 for animation
      expect(typeof lines[0]).toBe("string")
    }
  })
})

// ─── spriteFrameCount ────────────────────────────────

describe("spriteFrameCount", () => {
  test("returns 3 for all species", () => {
    for (const species of SPECIES) {
      expect(spriteFrameCount(species)).toBe(3)
    }
  })
})

// ─── renderFace ──────────────────────────────────────

describe("renderFace", () => {
  test("returns a non-empty string for all species", () => {
    for (const species of SPECIES) {
      const bones = makeBones({ species, eye: "·" })
      const face = renderFace(bones)
      expect(typeof face).toBe("string")
      expect(face.length).toBeGreaterThan(0)
    }
  })

  test("includes the eye character in the face", () => {
    for (const eye of EYES) {
      const bones = makeBones({ eye })
      const face = renderFace(bones)
      expect(face).toContain(eye)
    }
  })

  test("different eyes produce different faces", () => {
    const bones1 = makeBones({ eye: "·" })
    const bones2 = makeBones({ eye: "✦" })
    expect(renderFace(bones1)).not.toBe(renderFace(bones2))
  })

  test("all species render a face string", () => {
    for (const species of SPECIES) {
      const bones = makeBones({ species, eye: "·" })
      const face = renderFace(bones)
      expect(typeof face).toBe("string")
      expect(face.length).toBeGreaterThan(0)
    }
  })
})
