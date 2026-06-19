import { describe, it, expect } from "bun:test"
import { WorkflowMeta } from "@/workflow/meta"

describe("WorkflowMeta.parse", () => {
  it("parses all fields correctly", () => {
    const source = [
      "/// meta",
      '/// name: "MyFlow"',
      '/// description: "does stuff"',
      "/// timeout: 30000",
      "/// max_agents: 4",
      '/// args: {param: {type: "string", required: true}}',
      "/// end meta",
      "console.log('body')",
    ].join("\n")
    const result = WorkflowMeta.parse(source)
    expect("meta" in result).toBe(true)
    const parsed = result as WorkflowMeta.Parsed
    expect(parsed.meta.name).toBe("MyFlow")
    expect(parsed.meta.description).toBe("does stuff")
    expect(parsed.meta.timeout).toBe(30000)
    expect(parsed.meta.max_agents).toBe(4)
    expect(parsed.meta.args).toEqual({ param: { type: "string", required: true } })
    expect(parsed.body).toBe("console.log('body')")
  })

  it("returns empty meta when only name specified", () => {
    const source = ["/// meta", '/// name: "OnlyName"', "/// end meta", "code()"].join("\n")
    const result = WorkflowMeta.parse(source) as WorkflowMeta.Parsed
    expect(result.meta.name).toBe("OnlyName")
    expect(result.meta.description).toBeUndefined()
    expect(result.meta.timeout).toBeUndefined()
    expect(result.meta.max_agents).toBeUndefined()
    expect(result.meta.args).toBeUndefined()
  })

  it("returns empty meta and full body when no meta block", () => {
    const source = "const x = 1\nconst y = 2"
    const result = WorkflowMeta.parse(source) as WorkflowMeta.Parsed
    expect(result.meta).toEqual({})
    expect(result.body).toBe(source)
  })

  it("returns error for line without /// prefix", () => {
    const source = ["/// meta", "no prefix here", "/// end meta"].join("\n")
    const result = WorkflowMeta.parse(source)
    expect("line" in result).toBe(true)
    const err = result as WorkflowMeta.ParseError
    expect(err.line).toBe(2)
    expect(err.message).toContain('expected "///" prefix')
  })

  it("returns error for missing end meta", () => {
    const source = ["/// meta", '/// name: "test"'].join("\n")
    const result = WorkflowMeta.parse(source)
    expect("line" in result).toBe(true)
    const err = result as WorkflowMeta.ParseError
    expect(err.message).toContain('missing "/// end meta"')
  })

  it("returns error for unknown key", () => {
    const source = ["/// meta", "/// bogus: 123", "/// end meta"].join("\n")
    const result = WorkflowMeta.parse(source)
    expect("line" in result).toBe(true)
    const err = result as WorkflowMeta.ParseError
    expect(err.line).toBe(2)
    expect(err.message).toContain('unknown key "bogus"')
  })

  it("parses object with unquoted keys", () => {
    const source = ["/// meta", '/// args: {name: {type: "string"}, count: {type: "number"}}', "/// end meta"].join(
      "\n",
    )
    const result = WorkflowMeta.parse(source) as WorkflowMeta.Parsed
    expect(result.meta.args).toEqual({ name: { type: "string" }, count: { type: "number" } })
  })

  it("parses array value", () => {
    const source = ["/// meta", "/// timeout: 5000", "/// end meta"].join("\n")
    const result = WorkflowMeta.parse(source) as WorkflowMeta.Parsed
    expect(result.meta.timeout).toBe(5000)
  })

  it("parses number and boolean values", () => {
    const source = ["/// meta", "/// timeout: 5000", "/// max_agents: 2", "/// end meta"].join("\n")
    const result = WorkflowMeta.parse(source) as WorkflowMeta.Parsed
    expect(result.meta.timeout).toBe(5000)
    expect(result.meta.max_agents).toBe(2)
  })

  it("body is everything after end meta", () => {
    const source = ["/// meta", '/// name: "X"', "/// end meta", "line1", "line2", "line3"].join("\n")
    const result = WorkflowMeta.parse(source) as WorkflowMeta.Parsed
    expect(result.body).toBe("line1\nline2\nline3")
  })
})
