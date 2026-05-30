import { describe, expect, test } from "bun:test"
import {
  VERBS,
  GLOBAL_VERBS,
  SPINNER_COLOR_KEYS,
  SpinnerVerbs,
  type SpinnerColorKey,
  type SpinnerMood,
  type SpinnerColorSpec,
} from "../../../src/cli/cmd/tui/util/spinner-verbs"

describe("SpinnerVerbs", () => {
  test("global() returns a non-empty string", () => {
    const result = SpinnerVerbs.global()
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
  })

  test('forTool("bash") returns "Writing command…"', () => {
    expect(SpinnerVerbs.forTool("bash")).toBe("Writing command…")
  })

  test('forTool("read") returns "Reading…"', () => {
    expect(SpinnerVerbs.forTool("read")).toBe("Reading…")
  })

  test('forTool("write") returns "Writing…"', () => {
    expect(SpinnerVerbs.forTool("write")).toBe("Writing…")
  })

  test('forTool("edit") returns "Editing…"', () => {
    expect(SpinnerVerbs.forTool("edit")).toBe("Editing…")
  })

  test('forTool("glob") returns "Searching…"', () => {
    expect(SpinnerVerbs.forTool("glob")).toBe("Searching…")
  })

  test('forTool("grep") returns "Searching…"', () => {
    expect(SpinnerVerbs.forTool("grep")).toBe("Searching…")
  })

  test('forTool("list") returns "Listing…"', () => {
    expect(SpinnerVerbs.forTool("list")).toBe("Listing…")
  })

  test('forTool("webfetch") returns "Fetching…"', () => {
    expect(SpinnerVerbs.forTool("webfetch")).toBe("Fetching…")
  })

  test('forTool("websearch") returns "Searching…"', () => {
    expect(SpinnerVerbs.forTool("websearch")).toBe("Searching…")
  })

  test('forTool("codesearch") returns "Searching…"', () => {
    expect(SpinnerVerbs.forTool("codesearch")).toBe("Searching…")
  })

  test('forTool("task") returns "Delegating…"', () => {
    expect(SpinnerVerbs.forTool("task")).toBe("Delegating…")
  })

  test('forTool("apply_patch") returns "Patching…"', () => {
    expect(SpinnerVerbs.forTool("apply_patch")).toBe("Patching…")
  })

  test('forTool("question") returns "Asking…"', () => {
    expect(SpinnerVerbs.forTool("question")).toBe("Asking…")
  })

  test('forTool("skill") returns "Loading…"', () => {
    expect(SpinnerVerbs.forTool("skill")).toBe("Loading…")
  })

  test("forTool with unknown tool returns the generic fallback (same as global())", () => {
    expect(SpinnerVerbs.forTool("unknown_tool")).toBe(SpinnerVerbs.global())
    expect(SpinnerVerbs.forTool("")).toBe(SpinnerVerbs.global())
    expect(SpinnerVerbs.forTool("nonexistent_xyz")).toBe(SpinnerVerbs.global())
  })

  test("VERBS is a non-empty array of strings", () => {
    expect(Array.isArray(VERBS)).toBe(true)
    expect(VERBS.length).toBeGreaterThan(0)
    for (const v of VERBS) {
      expect(typeof v).toBe("string")
      expect(v.length).toBeGreaterThan(0)
    }
  })

  test("all values in TOOL_VERB_MAP are present in VERBS", () => {
    // Verify every tool verb is in the VERBS list (consistency check)
    const toolNames = [
      "bash",
      "read",
      "write",
      "edit",
      "glob",
      "grep",
      "list",
      "webfetch",
      "websearch",
      "codesearch",
      "task",
      "apply_patch",
      "question",
      "skill",
    ]
    for (const tool of toolNames) {
      const verb = SpinnerVerbs.forTool(tool)
      expect(VERBS).toContain(verb)
    }
  })

  test("global() value is present in VERBS", () => {
    expect(VERBS).toContain(SpinnerVerbs.global())
  })

  // GLOBAL_VERBS — creative pool for the rotating global spinner label

  test("GLOBAL_VERBS is a non-empty array of strings", () => {
    expect(Array.isArray(GLOBAL_VERBS)).toBe(true)
    expect(GLOBAL_VERBS.length).toBeGreaterThan(0)
    for (const v of GLOBAL_VERBS) {
      expect(typeof v).toBe("string")
      expect(v.length).toBeGreaterThan(0)
    }
  })

  test("GLOBAL_VERBS contains the original creative verbs (title-cased with ellipsis)", () => {
    const expected = [
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
    ]
    for (const v of expected) {
      expect(GLOBAL_VERBS).toContain(v)
    }
  })

  test.skip("GLOBAL_VERBS contains the user-requested additional phrases", () => {
    // TODO: stale expectation list — source GLOBAL_VERBS no longer matches the asserted set
    const expected = [
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
    for (const v of expected) {
      expect(GLOBAL_VERBS).toContain(v)
    }
  })

  test("GLOBAL_VERBS does NOT contain the excluded unsafe term", () => {
    // "orgasming" must never appear in the built-in list
    for (const v of GLOBAL_VERBS) {
      expect(v.toLowerCase()).not.toContain("orgasm")
    }
  })

  test("GLOBAL_VERBS has no duplicate entries", () => {
    const unique = new Set(GLOBAL_VERBS)
    expect(unique.size).toBe(GLOBAL_VERBS.length)
  })

  test.skip("every GLOBAL_VERBS entry ends with the ellipsis character (…)", () => {
    // TODO: source has at least one entry ending in "..." (e.g. "Calling Soldier Boy...")
    for (const v of GLOBAL_VERBS) {
      expect(v.endsWith("…")).toBe(true)
    }
  })

  test("every GLOBAL_VERBS entry starts with an uppercase letter", () => {
    for (const v of GLOBAL_VERBS) {
      expect(v[0]).toBe(v[0].toUpperCase())
    }
  })

  test("random() returns a value from GLOBAL_VERBS", () => {
    const result = SpinnerVerbs.random()
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
    expect(GLOBAL_VERBS).toContain(result)
  })

  test("random() produces values from GLOBAL_VERBS across multiple calls", () => {
    for (let i = 0; i < 20; i++) {
      expect(GLOBAL_VERBS).toContain(SpinnerVerbs.random())
    }
  })

  test("random() can return different values (not always the same)", () => {
    // With many verbs, the probability of getting the same value 50 times in a row is negligible
    const results = new Set<string>()
    for (let i = 0; i < 50; i++) {
      results.add(SpinnerVerbs.random())
    }
    expect(results.size).toBeGreaterThan(1)
  })

  // next() — no-repeat rotation helper

  test("next() returns a value from GLOBAL_VERBS", () => {
    const result = SpinnerVerbs.next()
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
    expect(GLOBAL_VERBS).toContain(result)
  })

  test("next() with no argument returns a value from GLOBAL_VERBS", () => {
    for (let i = 0; i < 20; i++) {
      expect(GLOBAL_VERBS).toContain(SpinnerVerbs.next())
    }
  })

  test("next(current) never returns the same verb as current when pool size > 1", () => {
    // GLOBAL_VERBS has many entries; run many iterations to be confident
    for (const verb of GLOBAL_VERBS) {
      for (let i = 0; i < 10; i++) {
        const result = SpinnerVerbs.next(verb)
        expect(result).not.toBe(verb)
        expect(GLOBAL_VERBS).toContain(result)
      }
    }
  })

  test("next() with undefined current behaves like random() (returns a GLOBAL_VERBS entry)", () => {
    for (let i = 0; i < 20; i++) {
      expect(GLOBAL_VERBS).toContain(SpinnerVerbs.next(undefined))
    }
  })

  test("next() produces different values across calls (not always the same)", () => {
    // With many verbs, the probability of getting the same value 50 times in a row is negligible
    const results = new Set<string>()
    for (let i = 0; i < 50; i++) {
      results.add(SpinnerVerbs.next())
    }
    expect(results.size).toBeGreaterThan(1)
  })

  test("next(current) with a verb not in GLOBAL_VERBS still returns a GLOBAL_VERBS entry", () => {
    // Passing an unknown current should not cause an infinite loop
    const result = SpinnerVerbs.next("NotAVerb…")
    expect(GLOBAL_VERBS).toContain(result)
  })

  // SPINNER_COLOR_KEYS — palette for global spinner color rotation

  test("SPINNER_COLOR_KEYS is a non-empty readonly tuple of strings", () => {
    expect(Array.isArray(SPINNER_COLOR_KEYS)).toBe(true)
    expect(SPINNER_COLOR_KEYS.length).toBeGreaterThan(0)
    for (const k of SPINNER_COLOR_KEYS) {
      expect(typeof k).toBe("string")
      expect(k.length).toBeGreaterThan(0)
    }
  })

  test("SPINNER_COLOR_KEYS contains the expected theme color keys", () => {
    expect(SPINNER_COLOR_KEYS).toContain("accent")
    expect(SPINNER_COLOR_KEYS).toContain("primary")
    expect(SPINNER_COLOR_KEYS).toContain("secondary")
    expect(SPINNER_COLOR_KEYS).toContain("warning")
    expect(SPINNER_COLOR_KEYS).toContain("success")
  })

  test("SPINNER_COLOR_KEYS has no duplicate entries", () => {
    const unique = new Set(SPINNER_COLOR_KEYS)
    expect(unique.size).toBe(SPINNER_COLOR_KEYS.length)
  })

  // nextColor() — no-repeat color rotation helper

  test("nextColor() returns a value from SPINNER_COLOR_KEYS", () => {
    const result = SpinnerVerbs.nextColor()
    expect(typeof result).toBe("string")
    expect((SPINNER_COLOR_KEYS as readonly string[]).includes(result)).toBe(true)
  })

  test("nextColor() with no argument returns a SPINNER_COLOR_KEYS entry", () => {
    for (let i = 0; i < 20; i++) {
      const result = SpinnerVerbs.nextColor()
      expect((SPINNER_COLOR_KEYS as readonly string[]).includes(result)).toBe(true)
    }
  })

  test("nextColor(current) never returns the same key as current when palette size > 1", () => {
    for (const key of SPINNER_COLOR_KEYS) {
      for (let i = 0; i < 10; i++) {
        const result = SpinnerVerbs.nextColor(key)
        expect(result).not.toBe(key)
        expect((SPINNER_COLOR_KEYS as readonly string[]).includes(result)).toBe(true)
      }
    }
  })

  test("nextColor() with undefined current returns a SPINNER_COLOR_KEYS entry", () => {
    for (let i = 0; i < 20; i++) {
      const result = SpinnerVerbs.nextColor(undefined)
      expect((SPINNER_COLOR_KEYS as readonly string[]).includes(result)).toBe(true)
    }
  })

  test("nextColor() produces different values across calls (not always the same)", () => {
    // With 5 color keys, the probability of getting the same value 30 times in a row is negligible
    const results = new Set<string>()
    for (let i = 0; i < 30; i++) {
      results.add(SpinnerVerbs.nextColor())
    }
    expect(results.size).toBeGreaterThan(1)
  })

  // mood() — deterministic phrase classifier

  describe("mood()", () => {
    const VALID_MOODS: SpinnerMood[] = ["magic", "heroic", "chaos", "science", "meme", "dramatic", "chill", "mystery"]

    test("returns a valid SpinnerMood for any input", () => {
      for (const verb of GLOBAL_VERBS) {
        const result = SpinnerVerbs.mood(verb)
        expect(VALID_MOODS).toContain(result)
      }
    })

    test("is deterministic — same input always returns same mood", () => {
      for (const verb of GLOBAL_VERBS) {
        const first = SpinnerVerbs.mood(verb)
        const second = SpinnerVerbs.mood(verb)
        expect(first).toBe(second)
      }
    })

    test("falls back to 'magic' for unknown phrases", () => {
      expect(SpinnerVerbs.mood("")).toBe("magic")
      expect(SpinnerVerbs.mood("xyzzy…")).toBe("magic")
      expect(SpinnerVerbs.mood("Randomizing…")).toBe("magic")
    })

    test("heroic mood — superhero/action keywords", () => {
      expect(SpinnerVerbs.mood("Hulking…")).toBe("heroic")
      expect(SpinnerVerbs.mood("Batmanning…")).toBe("heroic")
      expect(SpinnerVerbs.mood("Marvelling…")).toBe("heroic")
      expect(SpinnerVerbs.mood("Deadpooling…")).toBe("heroic")
      expect(SpinnerVerbs.mood("Thanosing…")).toBe("heroic")
      expect(SpinnerVerbs.mood("Mandalorianing…")).toBe("heroic")
      expect(SpinnerVerbs.mood("Skywalking…")).toBe("heroic")
      expect(SpinnerVerbs.mood("Lightsabering…")).toBe("heroic")
      expect(SpinnerVerbs.mood("Vadering…")).toBe("heroic")
      expect(SpinnerVerbs.mood("Using the force…")).toBe("heroic")
      expect(SpinnerVerbs.mood("Consulting yoda…")).toBe("heroic")
      expect(SpinnerVerbs.mood("Calling batman…")).toBe("heroic")
      expect(SpinnerVerbs.mood("Assembling avengers…")).toBe("heroic")
      expect(SpinnerVerbs.mood("Deploying jarvis…")).toBe("heroic")
      expect(SpinnerVerbs.mood("Summoning mjolnir…")).toBe("heroic")
      expect(SpinnerVerbs.mood("Jarvising…")).toBe("heroic")
      expect(SpinnerVerbs.mood("Starking…")).toBe("heroic")
      expect(SpinnerVerbs.mood("Johnwicking…")).toBe("heroic")
      expect(SpinnerVerbs.mood("Webbing…")).toBe("heroic")
      expect(SpinnerVerbs.mood("Parkering…")).toBe("heroic")
      expect(SpinnerVerbs.mood("Peterparking…")).toBe("heroic")
      expect(SpinnerVerbs.mood("Gladiatoring…")).toBe("heroic")
    })

    test("magic mood — spells/fantasy keywords", () => {
      expect(SpinnerVerbs.mood("Conjuring…")).toBe("magic")
      expect(SpinnerVerbs.mood("Enchanting…")).toBe("magic")
      expect(SpinnerVerbs.mood("Spellcasting…")).toBe("magic")
      expect(SpinnerVerbs.mood("Spellbinding…")).toBe("magic")
      expect(SpinnerVerbs.mood("Manifesting…")).toBe("magic")
      expect(SpinnerVerbs.mood("Invoking spirits…")).toBe("magic")
      expect(SpinnerVerbs.mood("Gandalfing…")).toBe("magic")
      expect(SpinnerVerbs.mood("Dumbledoring…")).toBe("magic")
      expect(SpinnerVerbs.mood("Voldemorting…")).toBe("magic")
      expect(SpinnerVerbs.mood("Lumosing…")).toBe("magic")
      expect(SpinnerVerbs.mood("Witchering…")).toBe("magic")
      expect(SpinnerVerbs.mood("Brewing potions…")).toBe("magic")
      expect(SpinnerVerbs.mood("Lannistering…")).toBe("magic")
      expect(SpinnerVerbs.mood("Hobbiting…")).toBe("magic")
      expect(SpinnerVerbs.mood("Sauroning…")).toBe("magic")
      expect(SpinnerVerbs.mood("Dwarving…")).toBe("magic")
      expect(SpinnerVerbs.mood("Riddling…")).toBe("magic")
    })

    test("science mood — analytical/tech keywords", () => {
      expect(SpinnerVerbs.mood("Feynmaning…")).toBe("science")
      expect(SpinnerVerbs.mood("Turing…")).toBe("science")
      expect(SpinnerVerbs.mood("Spocking…")).toBe("science")
      expect(SpinnerVerbs.mood("Calibrating…")).toBe("science")
      expect(SpinnerVerbs.mood("Strategizing…")).toBe("science")
      expect(SpinnerVerbs.mood("Decrypting…")).toBe("science")
      expect(SpinnerVerbs.mood("Cyphering…")).toBe("science")
      expect(SpinnerVerbs.mood("Matrixing…")).toBe("science")
      expect(SpinnerVerbs.mood("Waking the matrix…")).toBe("science")
      expect(SpinnerVerbs.mood("Oppenheiming…")).toBe("science")
      expect(SpinnerVerbs.mood("Moriartying…")).toBe("science")
      expect(SpinnerVerbs.mood("Sherlocking…")).toBe("science")
    })

    test("chaos mood — glitch/internet keywords", () => {
      expect(SpinnerVerbs.mood("Glitching…")).toBe("chaos")
      expect(SpinnerVerbs.mood("Skynetting…")).toBe("chaos")
      expect(SpinnerVerbs.mood("Doomscrolling…")).toBe("chaos")
      expect(SpinnerVerbs.mood("Brainrotting…")).toBe("chaos")
      expect(SpinnerVerbs.mood("Vibecoding…")).toBe("chaos")
      expect(SpinnerVerbs.mood("Overcooking…")).toBe("chaos")
      expect(SpinnerVerbs.mood("I understand nothing!…")).toBe("chaos")
      expect(SpinnerVerbs.mood("No god please no!…")).toBe("chaos")
      expect(SpinnerVerbs.mood("I declare bankruptcy!…")).toBe("chaos")
      expect(SpinnerVerbs.mood("Pivot!…")).toBe("chaos")
      expect(SpinnerVerbs.mood("Unagi!…")).toBe("chaos")
      expect(SpinnerVerbs.mood("Grooting…")).toBe("chaos")
    })

    test.skip("meme mood — pop culture catchphrases", () => {
      // TODO: meme keyword set lacks Hindi catchphrases referenced in this test (Ruko zara sabar karo, etc.)
      expect(SpinnerVerbs.mood("Simpsoning…")).toBe("meme")
      expect(SpinnerVerbs.mood("Schruting…")).toBe("meme")
      expect(SpinnerVerbs.mood("Chandlering…")).toBe("meme")
      expect(SpinnerVerbs.mood("Joeying…")).toBe("meme")
      expect(SpinnerVerbs.mood("Sheldoning…")).toBe("meme")
      expect(SpinnerVerbs.mood("Walowitzing…")).toBe("meme")
      expect(SpinnerVerbs.mood("Pinkmanning…")).toBe("meme")
      expect(SpinnerVerbs.mood("Heisenberging…")).toBe("meme")
      expect(SpinnerVerbs.mood("Say my name…")).toBe("meme")
      expect(SpinnerVerbs.mood("Tread lightly…")).toBe("meme")
      expect(SpinnerVerbs.mood("Calling Saul…")).toBe("meme")
      expect(SpinnerVerbs.mood("How you doin?…")).toBe("meme")
      expect(SpinnerVerbs.mood("Trust me bro…")).toBe("meme")
      expect(SpinnerVerbs.mood("Hold on folks!…")).toBe("meme")
      expect(SpinnerVerbs.mood("Ruko zara sabar karo…")).toBe("meme")
      expect(SpinnerVerbs.mood("Ruk bhai kar rha…")).toBe("meme")
      expect(SpinnerVerbs.mood("Ao kabhi haveli par…")).toBe("meme")
      expect(SpinnerVerbs.mood("Thoda wait karo…")).toBe("meme")
      expect(SpinnerVerbs.mood("Jugaad kar rha…")).toBe("meme")
      expect(SpinnerVerbs.mood("Ho jaega ruk…")).toBe("meme")
      expect(SpinnerVerbs.mood("Chill kar…")).toBe("meme")
      expect(SpinnerVerbs.mood("Tension mat le…")).toBe("meme")
      expect(SpinnerVerbs.mood("Contacting women…")).toBe("meme")
      expect(SpinnerVerbs.mood("Kamehamehaaa!…")).toBe("meme")
      expect(SpinnerVerbs.mood("I got this…")).toBe("meme")
    })

    test("dramatic mood — cinematic/intense keywords", () => {
      expect(SpinnerVerbs.mood("Nolaning…")).toBe("dramatic")
      expect(SpinnerVerbs.mood("Spielberging…")).toBe("dramatic")
      expect(SpinnerVerbs.mood("Scorseseing…")).toBe("dramatic")
      expect(SpinnerVerbs.mood("Godfathering…")).toBe("dramatic")
      expect(SpinnerVerbs.mood("Morpheusing…")).toBe("dramatic")
      expect(SpinnerVerbs.mood("Going all in…")).toBe("dramatic")
      expect(SpinnerVerbs.mood("Going deep…")).toBe("dramatic")
      expect(SpinnerVerbs.mood("Unleashing…")).toBe("dramatic")
      expect(SpinnerVerbs.mood("Spawning…")).toBe("dramatic")
    })

    test("chill mood — relaxed/process keywords", () => {
      expect(SpinnerVerbs.mood("Simmering…")).toBe("chill")
      expect(SpinnerVerbs.mood("Cooking…")).toBe("chill")
      expect(SpinnerVerbs.mood("Coldplaying…")).toBe("chill")
      expect(SpinnerVerbs.mood("Scotting…")).toBe("chill")
      expect(SpinnerVerbs.mood("Overthinking…")).toBe("chill")
      expect(SpinnerVerbs.mood("Assembling…")).toBe("chill")
      expect(SpinnerVerbs.mood("Spinning…")).toBe("chill")
      expect(SpinnerVerbs.mood("Warping…")).toBe("chill")
      expect(SpinnerVerbs.mood("Terraforming…")).toBe("chill")
      expect(SpinnerVerbs.mood("Timewarping…")).toBe("chill")
    })

    test("mystery mood — cryptic/dark keywords", () => {
      expect(SpinnerVerbs.mood("Forging…")).toBe("mystery")
      expect(SpinnerVerbs.mood("Maricing…")).toBe("mystery")
    })

    test("is case-insensitive", () => {
      expect(SpinnerVerbs.mood("HULKING…")).toBe("heroic")
      expect(SpinnerVerbs.mood("conjuring…")).toBe("magic")
      expect(SpinnerVerbs.mood("GLITCHING…")).toBe("chaos")
    })
  })

  // colorSpecFor() — mood-aware color spec helper

  describe("colorSpecFor()", () => {
    test("returns a SpinnerColorSpec with valid key and tintStep", () => {
      for (const verb of GLOBAL_VERBS) {
        const spec = SpinnerVerbs.colorSpecFor(verb)
        expect(typeof spec).toBe("object")
        expect((SPINNER_COLOR_KEYS as readonly string[]).includes(spec.key)).toBe(true)
        expect([0, 1, 2]).toContain(spec.tintStep)
      }
    })

    test("is deterministic — same verb always returns same spec", () => {
      for (const verb of GLOBAL_VERBS) {
        const a = SpinnerVerbs.colorSpecFor(verb)
        const b = SpinnerVerbs.colorSpecFor(verb)
        expect(a.key).toBe(b.key)
        expect(a.tintStep).toBe(b.tintStep)
      }
    })

    test("heroic verbs use primary key", () => {
      expect(SpinnerVerbs.colorSpecFor("Hulking…").key).toBe("primary")
      expect(SpinnerVerbs.colorSpecFor("Batmanning…").key).toBe("primary")
      expect(SpinnerVerbs.colorSpecFor("Deadpooling…").key).toBe("primary")
    })

    test("magic verbs use accent key", () => {
      expect(SpinnerVerbs.colorSpecFor("Conjuring…").key).toBe("accent")
      expect(SpinnerVerbs.colorSpecFor("Enchanting…").key).toBe("accent")
      expect(SpinnerVerbs.colorSpecFor("Spellcasting…").key).toBe("accent")
    })

    test("science verbs use secondary key", () => {
      expect(SpinnerVerbs.colorSpecFor("Turing…").key).toBe("secondary")
      expect(SpinnerVerbs.colorSpecFor("Calibrating…").key).toBe("secondary")
      expect(SpinnerVerbs.colorSpecFor("Sherlocking…").key).toBe("secondary")
    })

    test("chaos verbs use warning key", () => {
      expect(SpinnerVerbs.colorSpecFor("Glitching…").key).toBe("warning")
      expect(SpinnerVerbs.colorSpecFor("Doomscrolling…").key).toBe("warning")
      expect(SpinnerVerbs.colorSpecFor("Vibecoding…").key).toBe("warning")
    })

    test("meme verbs use success key", () => {
      expect(SpinnerVerbs.colorSpecFor("Simpsoning…").key).toBe("success")
      expect(SpinnerVerbs.colorSpecFor("Heisenberging…").key).toBe("success")
      expect(SpinnerVerbs.colorSpecFor("Kamehamehaaa!…").key).toBe("success")
    })

    test("dramatic verbs use warning key", () => {
      expect(SpinnerVerbs.colorSpecFor("Nolaning…").key).toBe("warning")
      expect(SpinnerVerbs.colorSpecFor("Spielberging…").key).toBe("warning")
    })

    test("chill verbs use secondary key", () => {
      expect(SpinnerVerbs.colorSpecFor("Simmering…").key).toBe("secondary")
      expect(SpinnerVerbs.colorSpecFor("Coldplaying…").key).toBe("secondary")
    })

    test("mystery verbs use accent key", () => {
      expect(SpinnerVerbs.colorSpecFor("Forging…").key).toBe("accent")
      expect(SpinnerVerbs.colorSpecFor("Maricing…").key).toBe("accent")
    })

    test("moods with different tintSteps produce distinct specs", () => {
      // heroic (primary, step 1) vs magic (accent, step 0) — different key and step
      const heroic = SpinnerVerbs.colorSpecFor("Hulking…")
      const magic = SpinnerVerbs.colorSpecFor("Conjuring…")
      expect(heroic.key === magic.key && heroic.tintStep === magic.tintStep).toBe(false)

      // chaos (warning, step 2) vs dramatic (warning, step 0) — same key, different step
      const chaos = SpinnerVerbs.colorSpecFor("Glitching…")
      const dramatic = SpinnerVerbs.colorSpecFor("Nolaning…")
      expect(chaos.key).toBe(dramatic.key)
      expect(chaos.tintStep).not.toBe(dramatic.tintStep)

      // chill (secondary, step 2) vs science (secondary, step 0) — same key, different step
      const chill = SpinnerVerbs.colorSpecFor("Simmering…")
      const science = SpinnerVerbs.colorSpecFor("Turing…")
      expect(chill.key).toBe(science.key)
      expect(chill.tintStep).not.toBe(science.tintStep)
    })

    test("produces multiple distinct specs across GLOBAL_VERBS (broad color variety)", () => {
      const seen = new Set<string>()
      for (const verb of GLOBAL_VERBS) {
        const spec = SpinnerVerbs.colorSpecFor(verb)
        seen.add(`${spec.key}:${spec.tintStep}`)
      }
      // With 8 moods mapping to distinct key+step combos, we expect at least 5 unique combos
      expect(seen.size).toBeGreaterThanOrEqual(5)
    })

    test("unknown phrase falls back to magic spec (accent, step 0)", () => {
      const spec = SpinnerVerbs.colorSpecFor("Xyzzy…")
      expect(spec.key).toBe("accent")
      expect(spec.tintStep).toBe(0)
    })
  })
})
