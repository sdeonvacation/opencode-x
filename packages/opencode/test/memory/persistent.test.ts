import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import path from "path"
import fs from "fs"
import os from "os"
import { PersistentMemory } from "../../src/memory/persistent"
import { Global } from "../../src/global"
import { Log } from "../../src/util/log"

Log.init({ print: false })

// Override Global.Path.data for test isolation
let original: string
let tmp: string

beforeEach(() => {
  tmp = path.join(os.tmpdir(), "opencode-persistent-memory-test-" + Math.random().toString(36).slice(2))
  fs.mkdirSync(tmp, { recursive: true })
  original = Global.Path.data
  ;(Global.Path as any).data = tmp
})

afterEach(() => {
  ;(Global.Path as any).data = original
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("PersistentMemory.write", () => {
  test("creates memory directory and file", () => {
    PersistentMemory.write({ name: "test-pref", type: "user", content: "likes dark mode" })
    const dir = path.join(tmp, "memory")
    expect(fs.existsSync(dir)).toBe(true)
    const files = fs.readdirSync(dir)
    expect(files.length).toBe(1)
    expect(files[0]).toBe("user-test-pref.md")
  })

  test("writes valid frontmatter format", () => {
    PersistentMemory.write({ name: "my-fact", type: "project", content: "uses bun runtime" })
    const filepath = path.join(tmp, "memory", "project-my-fact.md")
    const raw = fs.readFileSync(filepath, "utf8")
    expect(raw).toContain("---")
    expect(raw).toContain("name: my-fact")
    expect(raw).toContain("type: project")
    expect(raw).toContain("created:")
    expect(raw).toContain("uses bun runtime")
  })

  test("includes project field when provided", () => {
    PersistentMemory.write({ name: "dep", type: "project", content: "uses effect-ts", project: "myapp" })
    const filepath = path.join(tmp, "memory", "project-dep.md")
    const raw = fs.readFileSync(filepath, "utf8")
    expect(raw).toContain("project: myapp")
  })

  test("omits project field when not provided", () => {
    PersistentMemory.write({ name: "pref", type: "user", content: "prefers vim" })
    const filepath = path.join(tmp, "memory", "user-pref.md")
    const raw = fs.readFileSync(filepath, "utf8")
    expect(raw).not.toContain("project:")
  })

  test("slugifies name for filename", () => {
    PersistentMemory.write({ name: "My Special Pref!", type: "feedback", content: "test" })
    const files = fs.readdirSync(path.join(tmp, "memory"))
    expect(files[0]).toBe("feedback-my-special-pref-.md")
  })

  test("overwrites existing file with same name and type", () => {
    PersistentMemory.write({ name: "fact", type: "user", content: "old" })
    PersistentMemory.write({ name: "fact", type: "user", content: "new" })
    const files = fs.readdirSync(path.join(tmp, "memory"))
    expect(files.length).toBe(1)
    const raw = fs.readFileSync(path.join(tmp, "memory", "user-fact.md"), "utf8")
    expect(raw).toContain("new")
    expect(raw).not.toContain("old")
  })
})

describe("PersistentMemory.list", () => {
  test("returns empty array when no memory dir", () => {
    const result = PersistentMemory.list()
    expect(result).toEqual([])
  })

  test("returns entries sorted newest first", () => {
    PersistentMemory.write({ name: "first", type: "user", content: "a" })
    // Ensure different mtime
    const filepath = path.join(tmp, "memory", "user-first.md")
    const past = new Date(Date.now() - 10000)
    fs.utimesSync(filepath, past, past)
    PersistentMemory.write({ name: "second", type: "user", content: "b" })

    const result = PersistentMemory.list()
    expect(result.length).toBe(2)
    expect(result[0].name).toBe("second")
    expect(result[1].name).toBe("first")
  })

  test("filters by type", () => {
    PersistentMemory.write({ name: "a", type: "user", content: "x" })
    PersistentMemory.write({ name: "b", type: "project", content: "y" })
    PersistentMemory.write({ name: "c", type: "feedback", content: "z" })

    const result = PersistentMemory.list({ type: "project" })
    expect(result.length).toBe(1)
    expect(result[0].name).toBe("b")
  })

  test("respects limit option", () => {
    PersistentMemory.write({ name: "a", type: "user", content: "x" })
    PersistentMemory.write({ name: "b", type: "user", content: "y" })
    PersistentMemory.write({ name: "c", type: "user", content: "z" })

    const result = PersistentMemory.list({ limit: 2 })
    expect(result.length).toBe(2)
  })

  test("skips non-md files", () => {
    fs.mkdirSync(path.join(tmp, "memory"), { recursive: true })
    fs.writeFileSync(path.join(tmp, "memory", "notes.txt"), "not a memory")
    PersistentMemory.write({ name: "real", type: "user", content: "valid" })

    const result = PersistentMemory.list()
    expect(result.length).toBe(1)
    expect(result[0].name).toBe("real")
  })

  test("skips files without valid frontmatter", () => {
    fs.mkdirSync(path.join(tmp, "memory"), { recursive: true })
    fs.writeFileSync(path.join(tmp, "memory", "bad.md"), "no frontmatter here")
    PersistentMemory.write({ name: "good", type: "user", content: "valid" })

    const result = PersistentMemory.list()
    expect(result.length).toBe(1)
    expect(result[0].name).toBe("good")
  })
})

describe("PersistentMemory.inject", () => {
  test("returns empty string when no memories", () => {
    expect(PersistentMemory.inject()).toBe("")
  })

  test("wraps entries in persistent-memory tags", () => {
    PersistentMemory.write({ name: "pref", type: "user", content: "likes typescript" })
    const result = PersistentMemory.inject()
    expect(result).toContain("<persistent-memory>")
    expect(result).toContain("</persistent-memory>")
    expect(result).toContain("[user] pref: likes typescript")
  })

  test("filters by project - includes unscoped and matching", () => {
    PersistentMemory.write({ name: "global", type: "user", content: "global pref" })
    PersistentMemory.write({ name: "proj-a", type: "project", content: "for a", project: "a" })
    PersistentMemory.write({ name: "proj-b", type: "project", content: "for b", project: "b" })

    const result = PersistentMemory.inject({ project: "a" })
    expect(result).toContain("global pref")
    expect(result).toContain("for a")
    expect(result).not.toContain("for b")
  })

  test("respects MAX_LINES limit", () => {
    // Write many memories that together exceed 500 lines
    for (let i = 0; i < 20; i++) {
      const content = Array(30).fill(`line ${i}`).join("\n")
      PersistentMemory.write({ name: `mem-${i}`, type: "user", content })
    }

    const result = PersistentMemory.inject()
    // Should not contain all 20 entries (20 * ~31 lines = 620 > 500)
    const count = (result.match(/\[user\] mem-/g) || []).length
    expect(count).toBeLessThan(20)
    expect(count).toBeGreaterThan(0)
  })

  test("skips entry that would exceed line limit", () => {
    // Single entry with 600 lines exceeds MAX_LINES immediately
    const long = Array(600).fill("line").join("\n")
    PersistentMemory.write({ name: "huge", type: "user", content: long })

    const result = PersistentMemory.inject()
    expect(result).toBe("")
  })
})
