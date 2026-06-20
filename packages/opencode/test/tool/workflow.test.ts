import { describe, it, expect } from "bun:test"
import { WorkflowTool } from "@/tool/workflow"
import { Effect } from "effect"

describe("WorkflowTool", () => {
  it("has correct tool id", () => {
    expect(WorkflowTool.id).toBe("workflow")
  })

  it("resolves via Effect.gen to a tool info with init", async () => {
    // WorkflowTool is an Effect that resolves to Tool.Info
    const info = await Effect.runPromise(WorkflowTool)
    expect(info.id).toBe("workflow")
    expect(typeof info.init).toBe("function")
  })

  it("initializes to a tool definition with parameters and execute", async () => {
    const info = await Effect.runPromise(WorkflowTool)
    const def = await info.init()
    expect(typeof def.description).toBe("string")
    expect(def.description).toContain("workflow")
    expect(typeof def.execute).toBe("function")
    // Verify parameter schema
    const result = def.parameters.safeParse({ script: "deploy" })
    expect(result.success).toBe(true)
  })

  it("rejects invalid parameters", async () => {
    const info = await Effect.runPromise(WorkflowTool)
    const def = await info.init()
    // Missing required 'script'
    const result = def.parameters.safeParse({})
    expect(result.success).toBe(false)
  })

  it("validates max_concurrent_agents as positive integer", async () => {
    const info = await Effect.runPromise(WorkflowTool)
    const def = await info.init()
    const valid = def.parameters.safeParse({ script: "test", max_concurrent_agents: 3 })
    expect(valid.success).toBe(true)
    const invalid = def.parameters.safeParse({ script: "test", max_concurrent_agents: -1 })
    expect(invalid.success).toBe(false)
    const float = def.parameters.safeParse({ script: "test", max_concurrent_agents: 2.5 })
    expect(float.success).toBe(false)
  })

  it("allows optional args record", async () => {
    const info = await Effect.runPromise(WorkflowTool)
    const def = await info.init()
    const result = def.parameters.safeParse({ script: "build", args: { env: "prod", count: 3 } })
    expect(result.success).toBe(true)
  })
})
