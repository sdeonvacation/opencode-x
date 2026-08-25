import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import path from "path"
import fs from "fs"
import os from "os"
import { PersistentMemory } from "../../src/memory/persistent"
import { Log } from "../../src/util/log"

Log.init({ print: false })

// Real fs in tmpdir; root param keeps tests off Global.Path.data
let tmp: string

const mem = () => path.join(tmp, "memory")

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-persistent-memory-test-"))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("PersistentMemory.write", () => {
  test("creates memory directory and file", () => {
    PersistentMemory.write({ name: "test-pref", type: "user", content: "likes dark mode", root: mem() })
    expect(fs.existsSync(mem())).toBe(true)
    const files = fs.readdirSync(mem())
    expect(files.length).toBe(1)
    expect(files[0]).toBe("user-test-pref.md")
  })

  test("writes valid frontmatter format", () => {
    PersistentMemory.write({ name: "my-fact", type: "project", content: "uses bun runtime", root: mem() })
    const raw = fs.readFileSync(path.join(mem(), "project-my-fact.md"), "utf8")
    expect(raw).toContain("---")
    expect(raw).toContain("name: my-fact")
    expect(raw).toContain("type: project")
    expect(raw).toContain("created:")
    expect(raw).toContain("uses bun runtime")
  })

  test("writes project frontmatter and list parses entry.project", () => {
    PersistentMemory.write({ name: "dep", type: "project", content: "uses effect-ts", project: "/repo/a", root: mem() })
    const raw = fs.readFileSync(path.join(mem(), "project-dep.md"), "utf8")
    expect(raw).toContain("project: /repo/a")
    const entry = PersistentMemory.list({ root: mem() }).find((e) => e.name === "dep")
    expect(entry?.project).toBe("/repo/a")
  })

  test("omits project field when not provided and entry.project is undefined", () => {
    PersistentMemory.write({ name: "pref", type: "user", content: "prefers vim", root: mem() })
    const raw = fs.readFileSync(path.join(mem(), "user-pref.md"), "utf8")
    expect(raw).not.toContain("project:")
    const entry = PersistentMemory.list({ root: mem() }).find((e) => e.name === "pref")
    expect(entry?.project).toBeUndefined()
  })

  test("slugifies name for filename as ${type}-${slug}.md", () => {
    PersistentMemory.write({ name: "My Special Pref!", type: "feedback", content: "test", root: mem() })
    const files = fs.readdirSync(mem())
    expect(files[0]).toBe("feedback-my-special-pref-.md")
  })

  test("overwrites existing file with same name and type", () => {
    PersistentMemory.write({ name: "fact", type: "user", content: "old", root: mem() })
    PersistentMemory.write({ name: "fact", type: "user", content: "new", root: mem() })
    const files = fs.readdirSync(mem())
    expect(files.length).toBe(1)
    const raw = fs.readFileSync(path.join(mem(), "user-fact.md"), "utf8")
    expect(raw).toContain("new")
    expect(raw).not.toContain("old")
  })
})

describe("PersistentMemory.list", () => {
  test("returns empty array when no memory dir", () => {
    expect(PersistentMemory.list({ root: mem() })).toEqual([])
  })

  test("returns entries sorted newest first", () => {
    PersistentMemory.write({ name: "first", type: "user", content: "a", root: mem() })
    const filepath = path.join(mem(), "user-first.md")
    const past = new Date(Date.now() - 10000)
    fs.utimesSync(filepath, past, past)
    PersistentMemory.write({ name: "second", type: "user", content: "b", root: mem() })

    const result = PersistentMemory.list({ root: mem() })
    expect(result.length).toBe(2)
    expect(result[0].name).toBe("second")
    expect(result[1].name).toBe("first")
  })

  test("filters by type", () => {
    PersistentMemory.write({ name: "a", type: "user", content: "x", root: mem() })
    PersistentMemory.write({ name: "b", type: "project", content: "y", root: mem() })
    PersistentMemory.write({ name: "c", type: "feedback", content: "z", root: mem() })

    const result = PersistentMemory.list({ type: "project", root: mem() })
    expect(result.length).toBe(1)
    expect(result[0].name).toBe("b")
  })

  test("respects limit option", () => {
    PersistentMemory.write({ name: "a", type: "user", content: "x", root: mem() })
    PersistentMemory.write({ name: "b", type: "user", content: "y", root: mem() })
    PersistentMemory.write({ name: "c", type: "user", content: "z", root: mem() })

    const result = PersistentMemory.list({ limit: 2, root: mem() })
    expect(result.length).toBe(2)
  })

  test("skips non-md files", () => {
    fs.mkdirSync(mem(), { recursive: true })
    fs.writeFileSync(path.join(mem(), "notes.txt"), "not a memory")
    PersistentMemory.write({ name: "real", type: "user", content: "valid", root: mem() })

    const result = PersistentMemory.list({ root: mem() })
    expect(result.length).toBe(1)
    expect(result[0].name).toBe("real")
  })

  test("skips files without valid frontmatter", () => {
    fs.mkdirSync(mem(), { recursive: true })
    fs.writeFileSync(path.join(mem(), "bad.md"), "no frontmatter here")
    PersistentMemory.write({ name: "good", type: "user", content: "valid", root: mem() })

    const result = PersistentMemory.list({ root: mem() })
    expect(result.length).toBe(1)
    expect(result[0].name).toBe("good")
  })
})

describe("PersistentMemory.inject", () => {
  test("returns empty string when no memories", () => {
    expect(PersistentMemory.inject({ root: mem() })).toBe("")
  })

  test("wraps entries in persistent-memory tags", () => {
    PersistentMemory.write({ name: "pref", type: "user", content: "likes typescript", root: mem() })
    const result = PersistentMemory.inject({ root: mem() })
    expect(result).toContain("<persistent-memory>")
    expect(result).toContain("</persistent-memory>")
    expect(result).toContain("[user] pref: likes typescript")
  })

  test("filters by project - includes unscoped and matching, excludes other projects", () => {
    PersistentMemory.write({ name: "global", type: "user", content: "global pref", root: mem() })
    PersistentMemory.write({ name: "proj-a", type: "project", content: "for a", project: "/repo/a", root: mem() })
    PersistentMemory.write({ name: "proj-b", type: "project", content: "for b", project: "/repo/b", root: mem() })

    const result = PersistentMemory.inject({ project: "/repo/a", root: mem() })
    expect(result).toContain("global pref")
    expect(result).toContain("for a")
    expect(result).not.toContain("for b")
  })

  test("returns everything when no project filter given", () => {
    PersistentMemory.write({ name: "global", type: "user", content: "global pref", root: mem() })
    PersistentMemory.write({ name: "proj-a", type: "project", content: "for a", project: "/repo/a", root: mem() })
    PersistentMemory.write({ name: "proj-b", type: "feedback", content: "for b", project: "/repo/b", root: mem() })

    const result = PersistentMemory.inject({ root: mem() })
    expect(result).toContain("global pref")
    expect(result).toContain("for a")
    expect(result).toContain("for b")
  })

  test("respects MAX_LINES limit", () => {
    for (let i = 0; i < 20; i++) {
      const content = Array(30).fill(`line ${i}`).join("\n")
      PersistentMemory.write({ name: `mem-${i}`, type: "user", content, root: mem() })
    }

    const result = PersistentMemory.inject({ root: mem() })
    // 20 entries * ~31 lines exceeds MAX_LINES (500)
    const count = (result.match(/\[user\] mem-/g) || []).length
    expect(count).toBeLessThan(20)
    expect(count).toBeGreaterThan(0)
  })

  test("skips entry that would exceed line limit", () => {
    const long = Array(600).fill("line").join("\n")
    PersistentMemory.write({ name: "huge", type: "user", content: long, root: mem() })

    expect(PersistentMemory.inject({ root: mem() })).toBe("")
  })
})
