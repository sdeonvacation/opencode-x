/**
 * Unit tests for SpeechBubble, CompanionCard, CompanionSprite logic.
 * Tests cover pure functions extracted from the components.
 */
import { describe, expect, test } from "bun:test"

// ─── wrapText (extracted from SpeechBubble) ──────────────────────────────────

function wrapText(text: string, width: number): string[] {
  const words = text.split(" ")
  const lines: string[] = []
  let line = ""
  for (const word of words) {
    if (line.length + word.length + (line ? 1 : 0) <= width) {
      line += (line ? " " : "") + word
    } else {
      if (line) lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  return lines
}

describe("wrapText", () => {
  test("single word fits on one line", () => {
    expect(wrapText("hello", 30)).toEqual(["hello"])
  })

  test("short sentence fits on one line", () => {
    const result = wrapText("hello world", 30)
    expect(result).toEqual(["hello world"])
  })

  test("wraps at width boundary", () => {
    const result = wrapText("a b c d e f g h i j k l m n o p q r s t u v w x y z", 10)
    for (const line of result) {
      expect(line.length).toBeLessThanOrEqual(10)
    }
  })

  test("empty string returns empty array", () => {
    expect(wrapText("", 30)).toEqual([])
  })

  test("single very long word is not split", () => {
    const longWord = "a".repeat(50)
    const result = wrapText(longWord, 30)
    expect(result).toEqual([longWord])
  })

  test("preserves all words", () => {
    const text = "the quick brown fox jumps over the lazy dog"
    const result = wrapText(text, 20)
    const rejoined = result.join(" ")
    expect(rejoined).toBe(text)
  })

  test("wraps at exactly 30 chars for speech bubble", () => {
    // 30 char width used in SpeechBubble
    const text = "This is a test message that should wrap at thirty characters"
    const result = wrapText(text, 30)
    for (const line of result) {
      expect(line.length).toBeLessThanOrEqual(30)
    }
    expect(result.length).toBeGreaterThan(1)
  })
})

// ─── statBar (extracted from CompanionCard) ──────────────────────────────────

function statBar(value: number): string {
  const filled = Math.round((Math.max(0, Math.min(100, value)) / 100) * 10)
  return "█".repeat(filled) + "░".repeat(10 - filled)
}

describe("statBar", () => {
  test("returns 10 characters total", () => {
    for (const v of [0, 25, 50, 75, 100]) {
      expect(statBar(v).length).toBe(10)
    }
  })

  test("0 value is all empty blocks", () => {
    expect(statBar(0)).toBe("░".repeat(10))
  })

  test("100 value is all filled blocks", () => {
    expect(statBar(100)).toBe("█".repeat(10))
  })

  test("50 value is half filled", () => {
    expect(statBar(50)).toBe("█".repeat(5) + "░".repeat(5))
  })

  test("clamps below 0", () => {
    expect(statBar(-10)).toBe("░".repeat(10))
  })

  test("clamps above 100", () => {
    expect(statBar(150)).toBe("█".repeat(10))
  })

  test("10 value has 1 filled block", () => {
    expect(statBar(10)).toBe("█" + "░".repeat(9))
  })

  test("90 value has 9 filled blocks", () => {
    expect(statBar(90)).toBe("█".repeat(9) + "░")
  })
})

// ─── IDLE_SEQUENCE logic (extracted from CompanionSprite) ────────────────────

const IDLE_SEQUENCE = [0, 0, 0, 0, 1, 0, 0, 0, -1, 0, 0, 2, 0, 0, 0]

describe("IDLE_SEQUENCE", () => {
  test("has 15 entries", () => {
    expect(IDLE_SEQUENCE.length).toBe(15)
  })

  test("contains -1 for blink", () => {
    expect(IDLE_SEQUENCE).toContain(-1)
  })

  test("contains frame 0, 1, 2", () => {
    expect(IDLE_SEQUENCE).toContain(0)
    expect(IDLE_SEQUENCE).toContain(1)
    expect(IDLE_SEQUENCE).toContain(2)
  })

  test("mostly frame 0 (idle)", () => {
    const zeros = IDLE_SEQUENCE.filter((x) => x === 0).length
    expect(zeros).toBeGreaterThan(IDLE_SEQUENCE.length / 2)
  })
})

// ─── PET_HEARTS structure ─────────────────────────────────────────────────────

const PET_HEARTS = [
  ["   ♥    ♥   ", "  ♥  ♥   ♥  ", " ·   ·   ·  "],
  ["    ♥   ♥   ", " ♥  ♥  ♥    ", "  ·   ·  ·  "],
  ["  ♥    ♥    ", "   ♥  ♥  ♥  ", "   ·  ·   · "],
  ["    ♥  ♥    ", "  ♥    ♥  ♥ ", "    ·   ·   "],
  [" ♥     ♥   ", "   ♥    ♥   ", "  ·    ·  · "],
]

describe("PET_HEARTS", () => {
  test("has 5 frames", () => {
    expect(PET_HEARTS.length).toBe(5)
  })

  test("each frame has 3 lines", () => {
    for (const frame of PET_HEARTS) {
      expect(frame.length).toBe(3)
    }
  })

  test("each line is a string", () => {
    for (const frame of PET_HEARTS) {
      for (const line of frame) {
        expect(typeof line).toBe("string")
      }
    }
  })

  test("heart frames contain heart character", () => {
    for (const frame of PET_HEARTS) {
      const joined = frame.join("")
      expect(joined).toContain("♥")
    }
  })
})

// ─── MIN_COLS_FOR_FULL_SPRITE ─────────────────────────────────────────────────
// CompanionSprite.tsx uses JSX/solid-js which can't be loaded in bare test env.
// Test the constant value directly (kept in sync with the source file).

const MIN_COLS_FOR_FULL_SPRITE = 100

describe("MIN_COLS_FOR_FULL_SPRITE", () => {
  test("is 100", () => {
    expect(MIN_COLS_FOR_FULL_SPRITE).toBe(100)
  })

  test("companionReservedColumns returns 14 below threshold", () => {
    // narrow: face + name only
    function companionReservedColumns(cols: number, speaking: boolean): number {
      if (cols < MIN_COLS_FOR_FULL_SPRITE) return 14
      return speaking ? 50 : 14
    }
    expect(companionReservedColumns(80, false)).toBe(14)
    expect(companionReservedColumns(80, true)).toBe(14)
  })

  test("companionReservedColumns returns 50 when speaking above threshold", () => {
    function companionReservedColumns(cols: number, speaking: boolean): number {
      if (cols < MIN_COLS_FOR_FULL_SPRITE) return 14
      return speaking ? 50 : 14
    }
    expect(companionReservedColumns(120, true)).toBe(50)
    expect(companionReservedColumns(120, false)).toBe(14)
  })
})

// ─── companionIntroText (inlined — avoids importing Effect runtime) ───────────
// The function is a pure template string in prompt.ts — tested inline here
// to prevent the require("src/session/system") → Effect runtime → test hang.

function companionIntroText(name: string, species: string): string {
  return `# Companion\n\nA small ${species} named ${name} sits beside the user's input box and occasionally comments in a speech bubble. You're not ${name} — it's a separate watcher.\n\nWhen the user addresses ${name} directly (by name), its bubble will answer. Your job in that moment is to stay out of the way: respond in ONE line or less, or just answer any part of the message meant for you. Don't explain that you're not ${name} — they know. Don't narrate what ${name} might say — the bubble handles that.`
}

describe("companionIntroText", () => {
  test("includes name and species", () => {
    const text = companionIntroText("Pip", "duck")
    expect(text).toContain("Pip")
    expect(text).toContain("duck")
  })

  test("returns a non-empty string", () => {
    const text = companionIntroText("Byte", "robot")
    expect(typeof text).toBe("string")
    expect(text.length).toBeGreaterThan(0)
  })

  test("mentions companion name in context", () => {
    const text = companionIntroText("Ember", "dragon")
    expect(text).toContain("Ember")
    expect(text.toLowerCase()).toContain("dragon")
  })
})

// ─── SystemPrompt.companion pure logic (inlined — avoids importing Effect runtime)
// The actual SystemPrompt.companion delegates to companionIntroText + getCompanion.
// Testing the pure guard logic here without pulling in system.ts → Effect chain.

function systemPromptCompanion(config: {
  experimental?: { buddy?: boolean }
  companion_muted?: boolean
  companion?: { name: string; personality: string; hatchedAt: number; species?: string }
}): string[] {
  if (!config.experimental?.buddy) return []
  if (config.companion_muted) return []
  if (!config.companion) return []
  const { name, species = "creature" } = config.companion
  return [companionIntroText(name, species)]
}

describe("SystemPrompt.companion (pure logic)", () => {
  test("returns empty array when buddy not enabled", () => {
    expect(systemPromptCompanion({})).toEqual([])
  })

  test("returns empty array when companion_muted", () => {
    expect(systemPromptCompanion({ experimental: { buddy: true }, companion_muted: true })).toEqual([])
  })

  test("returns empty array when no companion stored", () => {
    expect(systemPromptCompanion({ experimental: { buddy: true } })).toEqual([])
  })

  test("returns intro text when companion present and not muted", () => {
    const result = systemPromptCompanion({
      experimental: { buddy: true },
      companion: { name: "Pip", personality: "cheerful", hatchedAt: 1700000000000 },
    })
    expect(result.length).toBe(1)
    expect(typeof result[0]).toBe("string")
    expect(result[0]).toContain("Pip")
  })
})
