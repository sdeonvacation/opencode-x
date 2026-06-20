import { describe, test, expect } from "bun:test"
import { SearchText, type SearchMatch } from "../../src/cli/cmd/tui/component/search/extract"

describe("SearchText.extract", () => {
  test("extracts text parts only", () => {
    const parts = [
      { type: "text", id: "p1", text: "hello world" },
      { type: "tool-invocation", id: "p2", tool: "bash" },
      { type: "text", id: "p3", text: "goodbye" },
    ] as any
    const result = SearchText.extract(parts)
    expect(result).toEqual([
      { id: "p1", text: "hello world" },
      { id: "p3", text: "goodbye" },
    ])
  })

  test("skips parts with empty text", () => {
    const parts = [
      { type: "text", id: "p1", text: "" },
      { type: "text", id: "p2", text: "   " },
      { type: "text", id: "p3", text: "valid" },
    ] as any
    const result = SearchText.extract(parts)
    expect(result).toEqual([{ id: "p3", text: "valid" }])
  })

  test("returns empty array for no text parts", () => {
    const parts = [
      { type: "tool-invocation", id: "p1", tool: "read" },
      { type: "reasoning", id: "p2", text: "thinking" },
    ] as any
    expect(SearchText.extract(parts)).toEqual([])
  })

  test("returns empty array for empty parts", () => {
    expect(SearchText.extract([])).toEqual([])
  })
})

describe("SearchText.find", () => {
  test("finds all case-insensitive matches", () => {
    const corpus = [{ id: "p1", text: "Hello World hello" }]
    const matches = SearchText.find(corpus, "hello", "msg1")
    expect(matches).toEqual([
      { messageID: "msg1", partID: "p1", offset: 0, length: 5 },
      { messageID: "msg1", partID: "p1", offset: 12, length: 5 },
    ])
  })

  test("returns empty for empty query", () => {
    const corpus = [{ id: "p1", text: "something" }]
    expect(SearchText.find(corpus, "", "msg1")).toEqual([])
  })

  test("returns empty when no matches", () => {
    const corpus = [{ id: "p1", text: "hello world" }]
    expect(SearchText.find(corpus, "xyz", "msg1")).toEqual([])
  })

  test("finds matches across multiple parts", () => {
    const corpus = [
      { id: "p1", text: "foo bar" },
      { id: "p2", text: "bar baz bar" },
    ]
    const matches = SearchText.find(corpus, "bar", "msg1")
    expect(matches).toEqual([
      { messageID: "msg1", partID: "p1", offset: 4, length: 3 },
      { messageID: "msg1", partID: "p2", offset: 0, length: 3 },
      { messageID: "msg1", partID: "p2", offset: 8, length: 3 },
    ])
  })

  test("handles overlapping potential matches", () => {
    const corpus = [{ id: "p1", text: "aaa" }]
    const matches = SearchText.find(corpus, "aa", "msg1")
    expect(matches).toEqual([
      { messageID: "msg1", partID: "p1", offset: 0, length: 2 },
      { messageID: "msg1", partID: "p1", offset: 1, length: 2 },
    ])
  })

  test("preserves messageID in results", () => {
    const corpus = [{ id: "p1", text: "test" }]
    const matches = SearchText.find(corpus, "test", "custom-id")
    expect(matches[0].messageID).toBe("custom-id")
  })

  test("handles special regex characters in query safely", () => {
    const corpus = [{ id: "p1", text: "foo.bar (baz)" }]
    const matches = SearchText.find(corpus, "foo.bar", "msg1")
    expect(matches).toEqual([{ messageID: "msg1", partID: "p1", offset: 0, length: 7 }])
  })

  test("case insensitive with mixed case query", () => {
    const corpus = [{ id: "p1", text: "JavaScript is great" }]
    const matches = SearchText.find(corpus, "JAVASCRIPT", "msg1")
    expect(matches).toEqual([{ messageID: "msg1", partID: "p1", offset: 0, length: 10 }])
  })

  test("empty corpus returns empty", () => {
    expect(SearchText.find([], "test", "msg1")).toEqual([])
  })
})
