import { describe, expect, test } from "bun:test"
import { detect } from "../../src/orchestration/ultrawork"
import { resolveModel } from "../../src/orchestration/ultrawork-hook"

describe("orchestration/ultrawork", () => {
  const model = { providerID: "openai", modelID: "ultra" }

  test("detects ulw and ultrawork keywords case-insensitively", () => {
    expect(detect("please use ulw for this", model)).toEqual(model)
    expect(detect("please use Ultrawork for this", model)).toEqual(model)
  })

  test("ignores keywords inside fenced code blocks", () => {
    expect(detect("```ts\nconst mode = 'ulw'\n```", model)).toBeNull()
  })

  test("ignores keywords inside inline code", () => {
    expect(detect("Run `ultrawork` later", model)).toBeNull()
  })

  test("returns null without configured model", () => {
    expect(detect("please use ulw", undefined)).toBeNull()
  })

  test("returns null when keyword is absent or only in urls", () => {
    expect(detect("normal prompt text", model)).toBeNull()
    expect(detect("see https://example.com/ulw for details", model)).toBeNull()
  })

  test("detects keyword at start or end of prompt", () => {
    expect(detect("ulw please handle this", model)).toEqual(model)
    expect(detect("please handle this with ultrawork", model)).toEqual(model)
  })

  test("resolveModel only returns model when explicitly enabled", () => {
    expect(resolveModel({ ultraworkModel: model })).toBeNull()
    expect(resolveModel({ enabled: false, ultraworkModel: model })).toBeNull()
    expect(resolveModel({ enabled: true, ultraworkModel: model })).toEqual(model)
  })

  test("keyword detection can drive routing while explicit access still works", () => {
    expect(detect("please route this to ultrawork", model) ?? resolveModel({ ultraworkModel: model })).toEqual(model)
    expect(detect("normal prompt", model) ?? resolveModel({ enabled: true, ultraworkModel: model })).toEqual(model)
  })
})
