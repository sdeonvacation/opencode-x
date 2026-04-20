import { describe, expect, test } from "bun:test"
import type { Tool } from "ai"
import {
  bashKind,
  category,
  complexityClassify,
  extractOutput,
  listLines,
  COMPRESSION_SYSTEM,
  COMPRESSION_TEMPLATES,
  templateFor,
  shouldCompress,
  validateCompression,
} from "../../src/session/route-classifier"
import { filterForRoute } from "../../src/tool/tool-filter"

describe("session.route-classifier", () => {
  test("disabled → cloud", () => {
    expect(complexityClassify({ enabled: false })).toMatchObject({ route: "cloud", reason: "disabled" })
  })

  test("first turn (no toolName) → cloud reasoning", () => {
    expect(complexityClassify({ enabled: true })).toMatchObject({ route: "cloud", reason: "reasoning" })
  })

  test("grep, 10 lines, no triggers → local simple", () => {
    const out = Array(10).fill("line").join("\n")
    expect(complexityClassify({ enabled: true, toolName: "grep", toolOutput: out })).toMatchObject({
      route: "local",
      reason: "simple",
    })
  })

  test("grep, 250 lines → cloud complex", () => {
    const out = Array(250).fill("line").join("\n")
    expect(complexityClassify({ enabled: true, toolName: "grep", toolOutput: out })).toMatchObject({
      route: "cloud",
      reason: "complex",
    })
  })

  test("read, 5 lines → local simple", () => {
    const out = Array(5).fill("x").join("\n")
    expect(complexityClassify({ enabled: true, toolName: "read", toolOutput: out })).toMatchObject({
      route: "local",
      reason: "simple",
    })
  })

  test("edit → cloud cloud_only", () => {
    expect(complexityClassify({ enabled: true, toolName: "edit" })).toMatchObject({
      route: "cloud",
      reason: "cloud_only",
    })
  })

  test("task → cloud cloud_only", () => {
    expect(complexityClassify({ enabled: true, toolName: "task" })).toMatchObject({
      route: "cloud",
      reason: "cloud_only",
    })
  })

  test("bash ls -la, 10 lines → local bash_simple", () => {
    const out = Array(10).fill("file").join("\n")
    expect(
      complexityClassify({ enabled: true, toolName: "bash", toolInput: { command: "ls -la" }, toolOutput: out }),
    ).toMatchObject({ route: "local", reason: "bash_simple" })
  })

  test("bash sed -i → cloud complex", () => {
    expect(
      complexityClassify({ enabled: true, toolName: "bash", toolInput: { command: "sed -i 's/a/b/'" } }),
    ).toMatchObject({ route: "cloud", reason: "complex" })
  })

  test("grep output with 'Error:' → cloud trigger", () => {
    expect(
      complexityClassify({ enabled: true, toolName: "grep", toolOutput: "Error: cannot open file" }),
    ).toMatchObject({ route: "cloud", reason: "trigger(Error:)" })
  })

  test("bash output with stack frame → cloud trigger(stack_frame)", () => {
    expect(complexityClassify({ enabled: true, toolName: "bash", toolOutput: "  at foo (bar.ts:10:5)" })).toMatchObject(
      { route: "cloud", reason: "trigger(stack_frame)" },
    )
  })

  test("bash output with FAILED → cloud trigger", () => {
    expect(complexityClassify({ enabled: true, toolName: "bash", toolOutput: "1 test FAILED" })).toMatchObject({
      route: "cloud",
    })
  })

  test("'how it works' query does not block local routing (intent keywords removed)", () => {
    const out = Array(5).fill("x").join("\n")
    expect(complexityClassify({ enabled: true, toolName: "read", toolOutput: out })).toMatchObject({
      route: "local",
      reason: "simple",
    })
  })

  test("domain keyword 'auth' in tool input → cloud trigger(auth)", () => {
    const out = Array(5).fill("x").join("\n")
    expect(
      complexityClassify({
        enabled: true,
        toolName: "read",
        toolOutput: out,
        toolInput: { path: "src/auth.ts" },
      }),
    ).toMatchObject({ route: "cloud", reason: "trigger(auth)" })
  })

  test("read with 200+ lines → cloud (line check before tool type)", () => {
    const out = Array(200).fill("x").join("\n")
    expect(complexityClassify({ enabled: true, toolName: "read", toolOutput: out })).toMatchObject({
      route: "cloud",
      reason: "complex",
    })
  })

  test("git diff with large output → cloud (line check before bash type)", () => {
    const out = Array(200).fill("- old line").join("\n")
    expect(
      complexityClassify({ enabled: true, toolName: "bash", toolInput: { command: "git diff" }, toolOutput: out }),
    ).toMatchObject({ route: "cloud", reason: "complex" })
  })

  test("unknown tool, small output → cloud complex (fail-safe)", () => {
    const out = Array(5).fill("x").join("\n")
    expect(complexityClassify({ enabled: true, toolName: "mcp_foo", toolOutput: out })).toMatchObject({
      route: "cloud",
      reason: "complex",
    })
  })

  test("listLines helper", () => {
    expect(listLines("a\nb\nc")).toBe(3)
    expect(listLines("")).toBe(0)
    expect(listLines("single")).toBe(1)
  })

  test("bashKind: simple commands", () => {
    expect(bashKind("ls -la")).toBe("simple")
    expect(bashKind("git diff --stat")).toBe("simple")
    expect(bashKind("npm test -- --watch=false")).toBe("simple")
  })

  test("bashKind: complex commands", () => {
    expect(bashKind("curl https://x | jq .")).toBe("complex")
    expect(bashKind("sed -i 's/a/b/'")).toBe("complex")
    expect(bashKind("rm -rf .tmp")).toBe("complex")
  })

  test("category helper", () => {
    expect(category("grep")).toBe("LOCAL_ONLY")
    expect(category("list")).toBe("LOCAL_ONLY")
    expect(category("write")).toBe("CLOUD_ONLY")
    expect(category("task")).toBe("CLOUD_ONLY")
    expect(category("bash")).toBe("SPLIT")
  })

  test("filterForRoute: local returns empty (local model no longer gets tools)", () => {
    const input = {
      grep: {} as Tool,
      read: {} as Tool,
      bash: {} as Tool,
      edit: {} as Tool,
      task: {} as Tool,
      webfetch: {} as Tool,
    }
    expect(Object.keys(filterForRoute(input, "local"))).toEqual([])
    expect(Object.keys(filterForRoute(input, "cloud"))).toEqual(["grep", "read", "bash", "edit", "task", "webfetch"])
  })

  test("extractOutput: plain string", () => {
    expect(extractOutput("hello\nworld")).toBe("hello\nworld")
  })

  test("extractOutput: {type:'text', value} — real ModelMessage shape", () => {
    expect(extractOutput({ type: "text", value: "line1\nline2\nline3" })).toBe("line1\nline2\nline3")
  })

  test("extractOutput: {type:'content', value:[{type:'text',text}]}", () => {
    expect(
      extractOutput({
        type: "content",
        value: [
          { type: "text", text: "foo" },
          { type: "text", text: "bar" },
        ],
      }),
    ).toBe("foo\nbar")
  })

  test("extractOutput: array of text parts", () => {
    expect(
      extractOutput([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\nb")
  })

  test("extractOutput: undefined/null → undefined", () => {
    expect(extractOutput(undefined)).toBeUndefined()
    expect(extractOutput(null)).toBeUndefined()
  })

  test("lineCount reflects real output via ModelMessage shape", () => {
    const output = Array(10).fill("line").join("\n") // 10 lines
    const result = complexityClassify({ enabled: true, toolName: "grep", toolOutput: output })
    expect(result.lineCount).toBe(10)
    expect(result.route).toBe("local")
  })
})

describe("session.route-classifier.compression", () => {
  describe("COMPRESSION_SYSTEM", () => {
    test("is a non-empty string", () => {
      expect(typeof COMPRESSION_SYSTEM).toBe("string")
      expect(COMPRESSION_SYSTEM.length).toBeGreaterThan(0)
    })

    test("contains lossless compression instruction", () => {
      expect(COMPRESSION_SYSTEM).toContain("lossless compression")
    })

    test("prohibits adding information", () => {
      expect(COMPRESSION_SYSTEM).toContain("Never add information")
    })
  })

  describe("COMPRESSION_TEMPLATES", () => {
    test("has all three keys", () => {
      expect(Object.keys(COMPRESSION_TEMPLATES).sort()).toEqual(["extract", "filter", "summarize"])
    })

    test("extract template is non-empty string", () => {
      expect(typeof COMPRESSION_TEMPLATES.extract).toBe("string")
      expect(COMPRESSION_TEMPLATES.extract.length).toBeGreaterThan(0)
    })

    test("summarize template is non-empty string", () => {
      expect(typeof COMPRESSION_TEMPLATES.summarize).toBe("string")
      expect(COMPRESSION_TEMPLATES.summarize.length).toBeGreaterThan(0)
    })

    test("filter template is non-empty string", () => {
      expect(typeof COMPRESSION_TEMPLATES.filter).toBe("string")
      expect(COMPRESSION_TEMPLATES.filter.length).toBeGreaterThan(0)
    })

    test("extract instructs bullet format", () => {
      expect(COMPRESSION_TEMPLATES.extract).toContain("bullet format")
    })

    test("summarize instructs 3-6 bullets", () => {
      expect(COMPRESSION_TEMPLATES.summarize).toContain("3-6 bullets")
    })

    test("filter instructs dropping duplicates", () => {
      expect(COMPRESSION_TEMPLATES.filter).toContain("duplicate")
    })
  })

  describe("templateFor", () => {
    test("read → summarize", () => {
      expect(templateFor("read")).toBe("summarize")
    })

    test("grep → extract", () => {
      expect(templateFor("grep")).toBe("extract")
    })

    test("glob → extract", () => {
      expect(templateFor("glob")).toBe("extract")
    })

    test("bash → extract", () => {
      expect(templateFor("bash")).toBe("extract")
    })

    test("list → extract", () => {
      expect(templateFor("list")).toBe("extract")
    })

    test("unknown tool → extract", () => {
      expect(templateFor("unknown_tool")).toBe("extract")
    })

    test("empty string → extract", () => {
      expect(templateFor("")).toBe("extract")
    })

    test("templateFor: config override respected", () => {
      expect(templateFor("grep", { grep: "summarize" })).toBe("summarize")
      expect(templateFor("bash", { bash: "filter" })).toBe("filter")
    })

    test("templateFor: invalid override value ignored", () => {
      expect(templateFor("grep", { grep: "invalid_value" })).toBe("extract")
    })

    test("templateFor: override for unknown tool", () => {
      expect(templateFor("mytool", { mytool: "filter" })).toBe("filter")
    })
  })

  describe("shouldCompress", () => {
    test("lines > threshold → true", () => {
      const output = Array(101).fill("line").join("\n") // 101 lines
      expect(shouldCompress(output, 100)).toBe(true)
    })

    test("lines === threshold → false (not strictly greater)", () => {
      const output = Array(100).fill("line").join("\n") // 100 lines
      expect(shouldCompress(output, 100)).toBe(false)
    })

    test("lines < threshold → false", () => {
      const output = Array(50).fill("line").join("\n") // 50 lines
      expect(shouldCompress(output, 100)).toBe(false)
    })

    test("empty string → false (0 lines, threshold 0 → false)", () => {
      expect(shouldCompress("", 0)).toBe(false)
    })

    test("single line → false when threshold is 1", () => {
      expect(shouldCompress("one line", 1)).toBe(false)
    })

    test("two lines → true when threshold is 1", () => {
      expect(shouldCompress("line1\nline2", 1)).toBe(true)
    })

    test("delegates to listLines for counting", () => {
      // listLines("a\nb\nc") = 3
      expect(shouldCompress("a\nb\nc", 2)).toBe(true)
      expect(shouldCompress("a\nb\nc", 3)).toBe(false)
    })
  })

  describe("validateCompression", () => {
    test("valid: compressed shorter than raw → true", () => {
      const raw = Array(10).fill("line").join("\n")
      const compressed = Array(5).fill("line").join("\n")
      expect(validateCompression(raw, compressed)).toBe(true)
    })

    test("valid: compressed same length as raw → true", () => {
      const raw = "line1\nline2\nline3"
      expect(validateCompression(raw, raw)).toBe(true)
    })

    test("invalid: compressed longer than raw → false", () => {
      const raw = Array(5).fill("line").join("\n")
      const compressed = Array(10).fill("line").join("\n")
      expect(validateCompression(raw, compressed)).toBe(false)
    })

    test("invalid: empty compressed → false", () => {
      const raw = "some content\nmore content"
      expect(validateCompression(raw, "")).toBe(false)
    })

    test("invalid: whitespace-only compressed → false", () => {
      const raw = "some content\nmore content"
      expect(validateCompression(raw, "   \n  \t  ")).toBe(false)
    })

    test("valid: single line compressed from multi-line raw → true", () => {
      const raw = Array(20).fill("line").join("\n")
      expect(validateCompression(raw, "summary")).toBe(true)
    })

    test("edge: both empty → false (empty compressed fails trim check)", () => {
      expect(validateCompression("", "")).toBe(false)
    })

    test("edge: raw empty, compressed non-empty → false (expansion: 1 > 0)", () => {
      // listLines("") = 0, listLines("x") = 1 → 1 > 0 → false
      expect(validateCompression("", "x")).toBe(false)
    })
  })
})
