import { describe, it, expect, mock, beforeEach } from "bun:test"
import { WorkflowGenerate } from "@/workflow/generate"

// Mock the dependencies
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

mock.module("@/provider/provider", () => ({
  Provider: {
    parseModel: (str: string) => {
      const [providerID, ...rest] = str.split("/")
      return { providerID, modelID: rest.join("/") }
    },
    getModel: mock(() => Promise.resolve(mockModel)),
    defaultModel: mock(() => Promise.resolve({ providerID: "openai", modelID: "gpt-4o-mini" })),
    getLanguage: mock(() => Promise.resolve(mockLanguage)),
  },
}))

mock.module("@/config/config", () => ({
  Config: {
    get: mock(() => Promise.resolve({ small_model: "openai/gpt-4o-mini" })),
  },
}))

mock.module("@/agent/agent", () => ({
  Agent: {
    list: mock(() =>
      Promise.resolve([
        { name: "coder", mode: "primary", description: "Primary coding agent" },
        { name: "tester", mode: "secondary", description: "Run and debug tests" },
        { name: "debugger", mode: "secondary", description: "Debug failures" },
      ]),
    ),
    get: mock(() => Promise.resolve({ name: "coder", mode: "primary" })),
    defaultAgent: mock(() => Promise.resolve("coder")),
  },
}))

mock.module("@/util/log", () => ({
  Log: {
    create: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
    }),
  },
}))

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
    // description should be truncated with ellipsis
    expect(desc.length).toBeLessThan(150)
    expect(desc).toContain("...")
  })

  it("throws when no model available", async () => {
    const { Provider } = await import("@/provider/provider")
    const orig = Provider.getModel
    ;(Provider as any).getModel = mock(() => Promise.reject(new Error("nope")))
    ;(Provider as any).defaultModel = mock(() => Promise.reject(new Error("no default")))

    await expect(WorkflowGenerate.generate("fail", "x")).rejects.toThrow()
    ;(Provider as any).getModel = orig
  })
})
