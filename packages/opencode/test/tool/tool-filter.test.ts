import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { filterTools } from "../../src/tool/tool-filter"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { CodeSearchTool } from "../../src/tool/codesearch"
import { WebSearchTool } from "../../src/tool/websearch"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { EditTool } from "../../src/tool/edit"
import { WriteTool } from "../../src/tool/write"
import { BashTool } from "../../src/tool/bash"
import { Env } from "../../src/env"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

// Minimal Tool.Info stubs for the tools we care about
const codeSearch = {
  id: CodeSearchTool.id,
  init: async () => ({
    description: "",
    parameters: {} as any,
    execute: async () => ({ title: "", output: "", metadata: {} }),
  }),
}
const webSearch = {
  id: WebSearchTool.id,
  init: async () => ({
    description: "",
    parameters: {} as any,
    execute: async () => ({ title: "", output: "", metadata: {} }),
  }),
}
const applyPatch = {
  id: ApplyPatchTool.id,
  init: async () => ({
    description: "",
    parameters: {} as any,
    execute: async () => ({ title: "", output: "", metadata: {} }),
  }),
}
const edit = {
  id: EditTool.id,
  init: async () => ({
    description: "",
    parameters: {} as any,
    execute: async () => ({ title: "", output: "", metadata: {} }),
  }),
}
const write = {
  id: WriteTool.id,
  init: async () => ({
    description: "",
    parameters: {} as any,
    execute: async () => ({ title: "", output: "", metadata: {} }),
  }),
}
const bash = {
  id: BashTool.id,
  init: async () => ({
    description: "",
    parameters: {} as any,
    execute: async () => ({ title: "", output: "", metadata: {} }),
  }),
}

const allTools = [codeSearch, webSearch, applyPatch, edit, write, bash]

afterEach(async () => {
  await Instance.disposeAll()
})

describe("tool/tool-filter", () => {
  describe("CodeSearch / WebSearch visibility", () => {
    test("included for opencode provider", async () => {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const result = filterTools(allTools, {
            providerID: ProviderID.opencode,
            modelID: ModelID.make("some-model"),
          })
          const ids = result.map((t) => t.id)
          expect(ids).toContain(CodeSearchTool.id)
          expect(ids).toContain(WebSearchTool.id)
        },
      })
    })

    test("excluded for non-opencode provider without EXA flag", async () => {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const result = filterTools(allTools, {
            providerID: ProviderID.anthropic,
            modelID: ModelID.make("claude-3-5-sonnet"),
          })
          const ids = result.map((t) => t.id)
          expect(ids).not.toContain(CodeSearchTool.id)
          expect(ids).not.toContain(WebSearchTool.id)
        },
      })
    })
  })

  describe("ApplyPatch / Edit / Write switching", () => {
    test("Edit and Write included, ApplyPatch excluded for non-gpt models", async () => {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const result = filterTools(allTools, {
            providerID: ProviderID.anthropic,
            modelID: ModelID.make("claude-3-5-sonnet"),
          })
          const ids = result.map((t) => t.id)
          expect(ids).toContain(EditTool.id)
          expect(ids).toContain(WriteTool.id)
          expect(ids).not.toContain(ApplyPatchTool.id)
        },
      })
    })

    test("ApplyPatch included, Edit/Write excluded for gpt- non-oss non-gpt-4 models", async () => {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const result = filterTools(allTools, {
            providerID: ProviderID.openai,
            modelID: ModelID.make("gpt-4.1"),
          })
          const ids = result.map((t) => t.id)
          expect(ids).toContain(ApplyPatchTool.id)
          expect(ids).not.toContain(EditTool.id)
          expect(ids).not.toContain(WriteTool.id)
        },
      })
    })

    test("Edit/Write included for gpt-4 (legacy) models", async () => {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const result = filterTools(allTools, {
            providerID: ProviderID.openai,
            modelID: ModelID.make("gpt-4"),
          })
          const ids = result.map((t) => t.id)
          expect(ids).toContain(EditTool.id)
          expect(ids).toContain(WriteTool.id)
          expect(ids).not.toContain(ApplyPatchTool.id)
        },
      })
    })

    test("Edit/Write included for gpt-oss models", async () => {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const result = filterTools(allTools, {
            providerID: ProviderID.openai,
            modelID: ModelID.make("gpt-4.1-oss"),
          })
          const ids = result.map((t) => t.id)
          expect(ids).toContain(EditTool.id)
          expect(ids).toContain(WriteTool.id)
          expect(ids).not.toContain(ApplyPatchTool.id)
        },
      })
    })

    test("ApplyPatch included when OPENCODE_E2E_LLM_URL is set", async () => {
      await using tmp = await tmpdir()
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          Env.set("OPENCODE_E2E_LLM_URL", "http://localhost:1234")
          try {
            const result = filterTools(allTools, {
              providerID: ProviderID.anthropic,
              modelID: ModelID.make("claude-3-5-sonnet"),
            })
            const ids = result.map((t) => t.id)
            expect(ids).toContain(ApplyPatchTool.id)
            expect(ids).not.toContain(EditTool.id)
            expect(ids).not.toContain(WriteTool.id)
          } finally {
            Env.remove("OPENCODE_E2E_LLM_URL")
          }
        },
      })
    })
  })

  test("unrelated tools (bash) always pass through", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = filterTools(allTools, {
          providerID: ProviderID.anthropic,
          modelID: ModelID.make("claude-3-5-sonnet"),
        })
        expect(result.map((t) => t.id)).toContain(BashTool.id)
      },
    })
  })

  test("empty tools list returns empty array", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(filterTools([], { providerID: ProviderID.openai, modelID: ModelID.make("gpt-4.1") })).toEqual([])
      },
    })
  })
})
