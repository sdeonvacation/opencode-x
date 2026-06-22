import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test"
import { Provider } from "@/provider/provider"
import { Agent } from "@/agent/agent"

// Mock generateText from ai (external package, safe to mock.module)
const mockGenerateText = mock(() =>
  Promise.resolve({
    text: `/// meta
/// name: "test"
/// description: "Run tests and fix failures"
/// max_agents: 3
/// end meta

phase("test")
const result = bash("bun test")
if (result.exitCode !== 0) {
  phase("fix")
  agent("debugger", { prompt: "Fix: " + result.stderr })
}
log("info", "done")`,
  }),
)

mock.module("ai", () => ({
  generateText: mockGenerateText,
  wrapLanguageModel: ({ model }: any) => model,
}))

const mockModel = {
  id: "gpt-4o-mini",
  providerID: "openai",
}

const mockLanguage = { id: "mock-lang" }

// Direct property mocks on namespace objects (avoids mock.module leaking on Linux)
const origGetModel = Provider.getModel
const origDefaultModel = Provider.defaultModel
const origGetLanguage = Provider.getLanguage
const origAgentList = Agent.list
const origAgentGet = (Agent as any).get
const origAgentDefault = (Agent as any).defaultAgent

Provider.getModel = mock(() => Promise.resolve(mockModel)) as any
Provider.defaultModel = mock(() => Promise.resolve({ providerID: "openai", modelID: "gpt-4o-mini" })) as any
Provider.getLanguage = mock(() => Promise.resolve(mockLanguage)) as any
;(Agent as any).list = mock(() =>
  Promise.resolve([
    { name: "coder", mode: "primary", description: "Primary coding agent" },
    { name: "tester", mode: "secondary", description: "Run and debug tests" },
    { name: "debugger", mode: "secondary", description: "Debug failures" },
  ]),
)
;(Agent as any).get = mock(() => Promise.resolve({ name: "coder", mode: "primary" }))
;(Agent as any).defaultAgent = mock(() => Promise.resolve("coder"))

afterAll(() => {
  Provider.getModel = origGetModel
  Provider.defaultModel = origDefaultModel
  Provider.getLanguage = origGetLanguage
  ;(Agent as any).list = origAgentList
  ;(Agent as any).get = origAgentGet
  ;(Agent as any).defaultAgent = origAgentDefault
})

// Import AFTER mocks are set up
const { WorkflowGenerate } = await import("@/workflow/generate")

describe("WorkflowGenerate", () => {
  beforeEach(() => {
    mockGenerateText.mockClear()
  })

  it("generates script with meta block", async () => {
    const script = await WorkflowGenerate.generate("test-wf", "Run tests and fix failures")
    expect(script).toContain("/// meta")
    expect(script).toContain("/// end meta")
  })

  it("calls generateText with correct system prompt", async () => {
    await WorkflowGenerate.generate("deploy", "Deploy to production")
    expect(mockGenerateText).toHaveBeenCalledTimes(1)
    const calls = mockGenerateText.mock.calls as any[]
    const call = calls[0][0]
    expect(call.system).toContain("workflow script generator")
    expect(call.system).toContain("phase(name)")
    expect(call.system).toContain("agent(name, { prompt })")
    expect(call.system).toContain("bash(command)")
  })

  it("passes name and prompt in user message", async () => {
    await WorkflowGenerate.generate("my-flow", "Do something cool")
    const calls = mockGenerateText.mock.calls as any[]
    const msg = calls[0][0].messages[0].content
    expect(msg).toContain('named "my-flow"')
    expect(msg).toContain("Do something cool")
  })

  it("uses temperature 0", async () => {
    await WorkflowGenerate.generate("t", "test")
    const calls = mockGenerateText.mock.calls as any[]
    expect(calls[0][0].temperature).toBe(0)
  })

  it("strips markdown fences from response", async () => {
    mockGenerateText.mockImplementationOnce(() =>
      Promise.resolve({
        text: '```javascript\n/// meta\n/// name: "x"\n/// end meta\nlog("info", "hi")\n```',
      }),
    )
    const script = await WorkflowGenerate.generate("x", "say hi")
    expect(script).not.toContain("```")
    expect(script).toStartWith("/// meta")
  })

  it("prepends meta block when missing from response", async () => {
    mockGenerateText.mockImplementationOnce(() =>
      Promise.resolve({
        text: 'phase("start")\nlog("info", "hello")',
      }),
    )
    const script = await WorkflowGenerate.generate("hello", "greet the user")
    expect(script).toStartWith("/// meta")
    expect(script).toContain('/// name: "hello"')
    expect(script).toContain('/// description: "greet the user"')
    expect(script).toContain("/// end meta")
    expect(script).toContain('phase("start")')
  })

  it("truncates long descriptions in fallback meta", async () => {
    mockGenerateText.mockImplementationOnce(() => Promise.resolve({ text: 'log("info", "ok")' }))
    const long = "a".repeat(200)
    const script = await WorkflowGenerate.generate("trunc", long)
    const desc = script.split("\n").find((l) => l.includes("/// description:"))!
    expect(desc.length).toBeLessThan(150)
    expect(desc).toContain("...")
  })

  it("throws when no model available", async () => {
    const orig = Provider.getModel
    const origDef = Provider.defaultModel
    Provider.getModel = mock(() => Promise.reject(new Error("nope"))) as any
    Provider.defaultModel = mock(() => Promise.reject(new Error("no default"))) as any

    await expect(WorkflowGenerate.generate("fail", "x")).rejects.toThrow()
    Provider.getModel = orig
    Provider.defaultModel = origDef
  })
})
