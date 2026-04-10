/**
 * Curated present-continuous activity verbs for spinner labels.
 * Pure data/logic module — no dependencies.
 */

/** Tool-specific and fallback labels used by forTool() and global(). */
export const VERBS: readonly string[] = [
  "Thinking…",
  "Reasoning…",
  "Working…",
  "Reading…",
  "Writing…",
  "Editing…",
  "Searching…",
  "Listing…",
  "Fetching…",
  "Delegating…",
  "Patching…",
  "Asking…",
  "Loading…",
  "Writing command…",
]

/**
 * Creative verb pool for the global spinner label rotation.
 * Title-cased with ellipsis, sampled randomly while the session is busy.
 */
export const GLOBAL_VERBS: readonly string[] = [
  "Sherlocking…",
  "Conjuring…",
  "Brewing…",
  "Manifesting…",
  "Cooking…",
  "Simmering…",
  "Spinning…",
  "Assembling…",
  "Unleashing…",
  "Hulking…",
  "Webbing…",
  "Batmanning…",
  "Gandalfing…",
  "Spellcasting…",
  "Enchanting…",
  "Forging…",
  "Decrypting…",
  "Matrixing…",
  "Johnwicking…",
  "Marvelling…",
  "Spawning…",
  "Strategizing…",
  "Doomscrolling…",
  "Brainrotting…",
  "Vibecoding…",
  "Skynetting…",
  "Jarvising…",
  "Starking…",
  "Deadpooling…",
  "Thanosing…",
  "Dumbledoring…",
  "Feynmaning…",
  "Moriartying…",
  "Turing…",
  "Spocking…",
  "Glitching…",
  "Cyphering…",
  "Spielberging…",
  "Scorseseing…",
  "Overthinking…",
  "Calibrating…",
  "Nolaning…",
  // User-requested additions
  "Parkering…",
  "Grooting…",
  "Sauroning…",
  "Dwarving…",
  "Spellbinding…",
  "Warping…",
  "Terraforming…",
  "Timewarping…",
  "Overcooking…",
  "Riddling…",
  "Voldemorting…",
  "Lumosing…",
  "Vadering…",
  "Lightsabering…",
  "Mandalorianing…",
  "Skywalking…",
  "Morpheusing…",
  "Gladiatoring…",
  "Godfathering…",
  "Simpsoning…",
  "Scotting…",
  "Schruting…",
  "Witchering…",
  "Chandlering…",
  "Calling Saul…",
  "Heisenberging…",
  "Hobbiting…",
  "Peterparking…",
  "Joeying…",
  "Sheldoning…",
  "Walowitzing…",
  "Pinkmanning…",
  "Lannistering…",
  "Oppenheiming…",
  "Maricing…",
  "Hold on folks!…",
  "Ruko zara sabar karo…",
  "Kamehamehaaa!…",
  "Ruk bhai kar rha…",
  "Ao kabhi haveli par…",
  "Calling batman…",
  "Assembling avengers…",
  "Deploying jarvis…",
  "Summoning mjolnir…",
  "Brewing potions…",
  "Invoking spirits…",
  "Using the force…",
  "Consulting yoda…",
  "Waking the matrix…",
  "Thoda wait karo…",
  "Jugaad kar rha…",
  "Ho jaega ruk…",
  "Contacting women…",
  "Chill kar…",
  "Tension mat le…",
  "Trust me bro…",
  "I understand nothing!…",
  "No god please no!…",
  "I declare bankruptcy!…",
  "Coldplaying…",
  "Say my name…",
  "Tread lightly…",
  "How you doin?…",
  "Pivot!…",
  "Unagi!…",
  "I got this…",
  "Going all in…",
  "Going deep…",
]

/**
 * Ordered palette of theme-key names used to rotate the global spinner color.
 * Kept as string literals so Prompt can index into the live theme object.
 * The palette intentionally omits error/info to keep the spinner upbeat.
 */
export const SPINNER_COLOR_KEYS = ["accent", "primary", "secondary", "warning", "success"] as const

export type SpinnerColorKey = (typeof SPINNER_COLOR_KEYS)[number]

/**
 * Mood categories for spinner phrases.
 * Each mood maps to a distinct color family + tint step so that even themes
 * where primary/accent collapse to the same hue still show visible variation.
 */
export type SpinnerMood = "magic" | "heroic" | "chaos" | "science" | "meme" | "dramatic" | "chill" | "mystery"

/**
 * Color descriptor returned by colorSpecFor().
 * `key`      — which theme color to use as the base.
 * `tintStep` — 0 = base color, 1 = lighter blend, 2 = darker blend.
 *              Prompt applies tint() to derive the actual RGBA.
 */
export type SpinnerColorSpec = {
  key: SpinnerColorKey
  tintStep: 0 | 1 | 2
}

/** Mood → color spec mapping. Each entry is visually distinct. */
const MOOD_COLOR_SPEC: Record<SpinnerMood, SpinnerColorSpec> = {
  magic: { key: "accent", tintStep: 0 },
  heroic: { key: "primary", tintStep: 1 },
  chaos: { key: "warning", tintStep: 2 },
  science: { key: "secondary", tintStep: 0 },
  meme: { key: "success", tintStep: 1 },
  dramatic: { key: "warning", tintStep: 0 },
  chill: { key: "secondary", tintStep: 2 },
  mystery: { key: "accent", tintStep: 2 },
}

/**
 * Keyword sets for deterministic mood classification.
 * Checked in order; first match wins. Falls back to "magic".
 */
const MOOD_KEYWORDS: Array<{ mood: SpinnerMood; words: readonly string[] }> = [
  {
    mood: "heroic",
    words: [
      "hulk",
      "batman",
      "avenger",
      "mjolnir",
      "jarvis",
      "stark",
      "parker",
      "peterpark",
      "spider",
      "web",
      "marvel",
      "deadpool",
      "thanos",
      "mandalorian",
      "skywalker",
      "skywalking",
      "lightsaber",
      "vader",
      "force",
      "yoda",
      "gladiator",
      "johnwick",
      "calling batman",
      "assembling avengers",
      "deploying jarvis",
      "summoning mjolnir",
    ],
  },
  {
    mood: "magic",
    words: [
      "conjur",
      "enchant",
      "spellcast",
      "spellbind",
      "manifest",
      "invoking",
      "spirit",
      "gandalf",
      "dumbledore",
      "voldemort",
      "lumos",
      "witcher",
      "potion",
      "brew",
      "lannister",
      "hobbit",
      "sauron",
      "dwarf",
      "riddle",
    ],
  },
  {
    mood: "science",
    words: [
      "feynman",
      "turing",
      "spock",
      "calibrat",
      "strategi",
      "decrypt",
      "cipher",
      "cypher",
      "matrix",
      "waking the matrix",
      "oppenheim",
      "moriarty",
      "sherlock",
    ],
  },
  {
    mood: "chaos",
    words: [
      "glitch",
      "skynet",
      "doomscroll",
      "brainrot",
      "vibecod",
      "overcook",
      "no god please",
      "i understand nothing",
      "i declare bankruptcy",
      "pivot",
      "unagi",
      "groot",
    ],
  },
  {
    mood: "meme",
    words: [
      "simpsoning",
      "schruting",
      "chandler",
      "joey",
      "sheldon",
      "walowitz",
      "pinkman",
      "heisenberg",
      "say my name",
      "tread lightly",
      "calling saul",
      "how you doin",
      "trust me bro",
      "hold on folks",
      "ruko",
      "ruk bhai",
      "ao kabhi",
      "thoda wait",
      "jugaad",
      "ho jaega",
      "chill kar",
      "tension mat",
      "contacting women",
      "kamehameha",
      "i got this",
    ],
  },
  {
    mood: "dramatic",
    words: [
      "nolan",
      "spielberg",
      "scorsese",
      "godfather",
      "scorses",
      "morpheus",
      "going all in",
      "going deep",
      "unleash",
      "spawn",
    ],
  },
  {
    mood: "chill",
    words: [
      "simmer",
      "cook",
      "brew",
      "coldplay",
      "scott",
      "overthink",
      "assembl",
      "loading",
      "spinning",
      "warping",
      "terraform",
      "timewarp",
    ],
  },
  {
    mood: "mystery",
    // Only phrases not already matched by earlier moods reach here.
    // "Forging…" and "Maricing…" are the primary mystery verbs from GLOBAL_VERBS.
    words: ["forging", "forge", "maricing"],
  },
]

/** Maps tool names to their best present-continuous label. */
const TOOL_VERB_MAP: Record<string, string> = {
  bash: "Writing command…",
  read: "Reading…",
  write: "Writing…",
  edit: "Editing…",
  glob: "Searching…",
  grep: "Searching…",
  list: "Listing…",
  webfetch: "Fetching…",
  websearch: "Searching…",
  codesearch: "Searching…",
  task: "Delegating…",
  apply_patch: "Patching…",
  question: "Asking…",
  skill: "Loading…",
}

export namespace SpinnerVerbs {
  /**
   * Returns a random verb sampled from the creative GLOBAL_VERBS pool.
   * Used for timer-based rotation of the global spinner label while busy.
   */
  export function random(): string {
    return GLOBAL_VERBS[Math.floor(Math.random() * GLOBAL_VERBS.length)]
  }

  /**
   * Returns a random verb from GLOBAL_VERBS that is different from `current`
   * when the pool has more than one entry, preventing back-to-back repetition.
   * Falls back to `random()` when the pool has only one entry.
   */
  export function next(current?: string): string {
    if (GLOBAL_VERBS.length <= 1) return random()
    let candidate: string
    do {
      candidate = GLOBAL_VERBS[Math.floor(Math.random() * GLOBAL_VERBS.length)]
    } while (candidate === current)
    return candidate
  }

  /**
   * Returns a color key from SPINNER_COLOR_KEYS that is different from
   * `current` when the palette has more than one entry, preventing
   * back-to-back same-color repetition.
   * Falls back to the first palette entry when the palette has only one entry.
   */
  export function nextColor(current?: SpinnerColorKey): SpinnerColorKey {
    if (SPINNER_COLOR_KEYS.length <= 1) return SPINNER_COLOR_KEYS[0]
    let candidate: SpinnerColorKey
    do {
      candidate = SPINNER_COLOR_KEYS[Math.floor(Math.random() * SPINNER_COLOR_KEYS.length)]
    } while (candidate === current)
    return candidate
  }

  /**
   * Classifies a spinner phrase into a mood category using keyword matching.
   * Deterministic: same input always returns the same mood.
   * Falls back to "magic" when no keywords match.
   */
  export function mood(phrase: string): SpinnerMood {
    const lower = phrase.toLowerCase()
    for (const entry of MOOD_KEYWORDS) {
      for (const word of entry.words) {
        if (lower.includes(word)) return entry.mood
      }
    }
    return "magic"
  }

  /**
   * Returns a SpinnerColorSpec for the given verb phrase.
   * The spec encodes which theme key to use as the base color and a tint step
   * (0 = base, 1 = lighter, 2 = darker) so Prompt can derive a visually
   * distinct RGBA even when multiple theme keys resolve to the same hue.
   */
  export function colorSpecFor(verb: string): SpinnerColorSpec {
    return MOOD_COLOR_SPEC[mood(verb)]
  }

  /**
   * Returns a generic busy label suitable for the global spinner row.
   * Used as the fallback value for forTool() on unknown tools.
   */
  export function global(): string {
    return "Working…"
  }

  /**
   * Returns the best present-continuous label for the given tool name.
   * Falls back to `global()` for unknown tools.
   */
  export function forTool(tool: string): string {
    return TOOL_VERB_MAP[tool] ?? global()
  }
}
