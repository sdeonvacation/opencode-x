import { describe, expect, test } from "bun:test"

// Unit test for the tokens helper function logic used in session/index.tsx
// This tests the pure logic extracted from the TUI component

function tokens(n: number): string {
  const t = Math.ceil(n / 4)
  if (t < 1000) return `~${t} tok`
  return `~${(t / 1000).toFixed(1)}k tok`
}

function output(parts: Array<{ type: string; text?: string }>): string {
  return parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("")
}

// Mirrors the bgTok memo logic from the Task component
function bgTok(opts: { background: boolean; running: boolean; output: string }): string | undefined {
  if (!opts.background) return undefined
  if (opts.running) return undefined
  return opts.output.length > 0 ? tokens(opts.output.length) : ""
}

// Mirrors the tok memo logic from InlineTool with override support
function inlineTok(opts: {
  override?: string
  status: string
  raw?: string
  metadata?: { output?: string }
  output?: string
}): string | undefined {
  if (opts.override !== undefined) return opts.override || undefined
  if (opts.status === "pending") {
    const len = opts.raw?.length ?? 0
    return len > 0 ? tokens(len) : undefined
  }
  if (opts.status === "running") {
    const out = opts.metadata?.output
    if (typeof out === "string" && out.length > 0) return tokens(out.length)
    return undefined
  }
  if (opts.status === "completed") {
    return tokens(opts.output?.length ?? 0)
  }
  return undefined
}

describe("background task token display", () => {
  test("tokens formats small counts", () => {
    expect(tokens(100)).toBe("~25 tok")
    expect(tokens(4)).toBe("~1 tok")
    expect(tokens(3996)).toBe("~999 tok")
  })

  test("tokens formats large counts with k suffix", () => {
    expect(tokens(4000)).toBe("~1.0k tok")
    expect(tokens(8000)).toBe("~2.0k tok")
    expect(tokens(40000)).toBe("~10.0k tok")
  })

  test("tokens handles zero", () => {
    expect(tokens(0)).toBe("~0 tok")
  })

  test("output extracts text from parts", () => {
    const parts = [{ type: "text", text: "hello " }, { type: "tool" }, { type: "text", text: "world" }]
    expect(output(parts)).toBe("hello world")
  })

  test("output returns empty for no text parts", () => {
    const parts = [{ type: "tool" }, { type: "reasoning" }]
    expect(output(parts)).toBe("")
  })

  test("output returns empty for empty array", () => {
    expect(output([])).toBe("")
  })

  test("completion line has no token suffix (moved to InlineTool tok prop)", () => {
    const toolCount = 5
    const duration = "12s"
    const line = `└ ${toolCount} toolcalls · ${duration}`
    expect(line).toBe("└ 5 toolcalls · 12s")
    expect(line).not.toContain("tok")
  })
})

describe("bgTok memo", () => {
  test("returns undefined for non-background tasks", () => {
    expect(bgTok({ background: false, running: false, output: "hello" })).toBeUndefined()
  })

  test("returns undefined while running", () => {
    expect(bgTok({ background: true, running: true, output: "hello" })).toBeUndefined()
  })

  test("returns token string when completed with output", () => {
    expect(bgTok({ background: true, running: false, output: "a".repeat(4000) })).toBe("~1.0k tok")
  })

  test("returns empty string when completed with no output", () => {
    expect(bgTok({ background: true, running: false, output: "" })).toBe("")
  })
})

describe("InlineTool tok override", () => {
  test("override with token string takes precedence", () => {
    expect(inlineTok({ override: "~500 tok", status: "completed", output: "short" })).toBe("~500 tok")
  })

  test("override with empty string returns undefined (suppresses display)", () => {
    expect(inlineTok({ override: "", status: "completed", output: "short" })).toBeUndefined()
  })

  test("no override falls through to completed logic", () => {
    expect(inlineTok({ status: "completed", output: "a".repeat(400) })).toBe("~100 tok")
  })

  test("no override falls through to pending logic with data", () => {
    expect(inlineTok({ status: "pending", raw: "a".repeat(80) })).toBe("~20 tok")
  })

  test("no override falls through to pending logic without data", () => {
    expect(inlineTok({ status: "pending" })).toBeUndefined()
  })

  test("no override falls through to running with metadata output", () => {
    expect(inlineTok({ status: "running", metadata: { output: "x".repeat(200) } })).toBe("~50 tok")
  })

  test("no override falls through to running without metadata", () => {
    expect(inlineTok({ status: "running" })).toBeUndefined()
  })
})
