import { describe, expect, test } from "bun:test"
import {
  parseWrittenAt,
  parseReconciledMap,
  buildProgressDiffItems,
  buildProgressDiff,
} from "@/session/checkpoint-progress-reconcile"

describe("parseWrittenAt", () => {
  test("extracts timestamp from valid comment", () => {
    expect(parseWrittenAt("<!-- written_at: 1234567890 -->")).toBe(1234567890)
  })

  test("extracts from line with surrounding content", () => {
    expect(parseWrittenAt("- [done] foo.ts <!-- written_at: 99 -->")).toBe(99)
  })

  test("returns undefined for no match", () => {
    expect(parseWrittenAt("no timestamp here")).toBeUndefined()
  })

  test("returns undefined for empty string", () => {
    expect(parseWrittenAt("")).toBeUndefined()
  })

  test("handles extra whitespace in comment", () => {
    expect(parseWrittenAt("<!--  written_at:  42  -->")).toBe(42)
  })
})

describe("parseReconciledMap", () => {
  test("parses single line", () => {
    const content = "- [done] src/foo.ts <!-- written_at: 100 -->"
    const map = parseReconciledMap(content)
    expect(map.size).toBe(1)
    expect(map.get("src/foo.ts")).toEqual({ path: "src/foo.ts", status: "done", at: 100 })
  })

  test("parses multiple lines", () => {
    const content = [
      "- [done] src/a.ts <!-- written_at: 1 -->",
      "- [wip] src/b.ts <!-- written_at: 2 -->",
      "- [blocked] src/c.ts <!-- written_at: 3 -->",
    ].join("\n")
    const map = parseReconciledMap(content)
    expect(map.size).toBe(3)
    expect(map.get("src/b.ts")!.status).toBe("wip")
  })

  test("skips non-matching lines", () => {
    const content = ["## Progress", "- [done] src/a.ts <!-- written_at: 1 -->", "", "some text"].join("\n")
    const map = parseReconciledMap(content)
    expect(map.size).toBe(1)
  })

  test("returns empty map for empty string", () => {
    expect(parseReconciledMap("").size).toBe(0)
  })

  test("handles paths with spaces", () => {
    const content = "- [done] src/my file.ts <!-- written_at: 5 -->"
    const map = parseReconciledMap(content)
    expect(map.get("src/my file.ts")).toEqual({ path: "src/my file.ts", status: "done", at: 5 })
  })
})

describe("buildProgressDiffItems", () => {
  test("returns new items not in prev", () => {
    const prev = new Map()
    const curr = new Map([["a.ts", { path: "a.ts", status: "done", at: 1 }]])
    const diff = buildProgressDiffItems(prev, curr)
    expect(diff).toEqual([{ path: "a.ts", status: "done", at: 1 }])
  })

  test("returns items with changed status", () => {
    const prev = new Map([["a.ts", { path: "a.ts", status: "wip", at: 1 }]])
    const curr = new Map([["a.ts", { path: "a.ts", status: "done", at: 2 }]])
    const diff = buildProgressDiffItems(prev, curr)
    expect(diff).toEqual([{ path: "a.ts", status: "done", at: 2 }])
  })

  test("excludes unchanged items", () => {
    const prev = new Map([["a.ts", { path: "a.ts", status: "done", at: 1 }]])
    const curr = new Map([["a.ts", { path: "a.ts", status: "done", at: 2 }]])
    const diff = buildProgressDiffItems(prev, curr)
    expect(diff).toEqual([])
  })

  test("returns empty array when both empty", () => {
    expect(buildProgressDiffItems(new Map(), new Map())).toEqual([])
  })

  test("handles mix of new and changed", () => {
    const prev = new Map([["a.ts", { path: "a.ts", status: "wip", at: 1 }]])
    const curr = new Map([
      ["a.ts", { path: "a.ts", status: "done", at: 2 }],
      ["b.ts", { path: "b.ts", status: "wip", at: 3 }],
    ])
    const diff = buildProgressDiffItems(prev, curr)
    expect(diff.length).toBe(2)
  })
})

describe("buildProgressDiff", () => {
  test("returns markdown diff for new items", () => {
    const prev = ""
    const curr = "- [done] src/a.ts <!-- written_at: 100 -->"
    const result = buildProgressDiff(prev, curr)
    expect(result).toBe("- [done] src/a.ts <!-- written_at: 100 -->")
  })

  test("returns empty string when no changes", () => {
    const content = "- [done] src/a.ts <!-- written_at: 100 -->"
    expect(buildProgressDiff(content, content)).toBe("")
  })

  test("returns only changed/new items", () => {
    const prev = ["- [done] src/a.ts <!-- written_at: 1 -->", "- [wip] src/b.ts <!-- written_at: 2 -->"].join("\n")
    const curr = [
      "- [done] src/a.ts <!-- written_at: 1 -->",
      "- [done] src/b.ts <!-- written_at: 3 -->",
      "- [wip] src/c.ts <!-- written_at: 4 -->",
    ].join("\n")
    const result = buildProgressDiff(prev, curr)
    expect(result).toContain("- [done] src/b.ts <!-- written_at: 3 -->")
    expect(result).toContain("- [wip] src/c.ts <!-- written_at: 4 -->")
    expect(result).not.toContain("src/a.ts")
  })

  test("returns empty string for both empty", () => {
    expect(buildProgressDiff("", "")).toBe("")
  })
})
