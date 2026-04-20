import { describe, expect, test } from "bun:test"
import type { Tool } from "ai"
import { bashKind, category, complexityClassify, extractOutput, listLines } from "../../src/session/route-classifier"
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

  test("filterForRoute: local allowlist", () => {
    const input = {
      grep: {} as Tool,
      read: {} as Tool,
      bash: {} as Tool,
      edit: {} as Tool,
      task: {} as Tool,
      webfetch: {} as Tool,
    }
    expect(Object.keys(filterForRoute(input, "local"))).toEqual(["grep", "read", "bash"])
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
