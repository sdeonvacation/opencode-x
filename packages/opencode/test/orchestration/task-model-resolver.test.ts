import { describe, expect, test } from "bun:test"
import { resolveTaskModel, type ResolveTaskModelInput } from "../../src/orchestration/task-model-resolver"

const fallback = { providerID: "anthropic", modelID: "claude-3-5-sonnet" }
const categoryModel = { providerID: "openai", modelID: "gpt-4.1" }
const ultraworkModel = { providerID: "openai", modelID: "o3" }

function makeInput(overrides: Partial<ResolveTaskModelInput> = {}): ResolveTaskModelInput {
  return {
    prompt: "do some work",
    subagentType: "explore",
    categories: {},
    fallback,
    ...overrides,
  }
}

describe("orchestration/task-model-resolver", () => {
  test("returns fallback when no overrides apply", () => {
    expect(resolveTaskModel(makeInput())).toEqual(fallback)
  })

  test("category match returns category model", () => {
    const result = resolveTaskModel(
      makeInput({
        subagentType: "explore",
        categories: { explore: categoryModel },
      }),
    )
    expect(result).toEqual(categoryModel)
  })

  test("taskCategory takes priority over subagentType for category routing", () => {
    const result = resolveTaskModel(
      makeInput({
        subagentType: "explore",
        taskCategory: "build",
        categories: { explore: categoryModel, build: ultraworkModel },
      }),
    )
    expect(result).toEqual(ultraworkModel)
  })

  test("unknown category falls back to fallback model", () => {
    const result = resolveTaskModel(
      makeInput({
        subagentType: "unknown-agent",
        categories: { explore: categoryModel },
      }),
    )
    expect(result).toEqual(fallback)
  })

  test("ultrawork keyword in prompt returns ultrawork model", () => {
    const result = resolveTaskModel(
      makeInput({
        prompt: "please use ulw for this task",
        ultraworkModel,
      }),
    )
    expect(result).toEqual(ultraworkModel)
  })

  test("ultrawork keyword detection is case-insensitive", () => {
    const result = resolveTaskModel(
      makeInput({
        prompt: "Use ULTRAWORK for this",
        ultraworkModel,
      }),
    )
    expect(result).toEqual(ultraworkModel)
  })

  test("explicit use_ultrawork=true returns ultrawork model", () => {
    const result = resolveTaskModel(
      makeInput({
        useUltrawork: true,
        ultraworkModel,
      }),
    )
    expect(result).toEqual(ultraworkModel)
  })

  test("use_ultrawork=false does not activate ultrawork", () => {
    const result = resolveTaskModel(
      makeInput({
        useUltrawork: false,
        ultraworkModel,
      }),
    )
    expect(result).toEqual(fallback)
  })

  test("ultrawork takes priority over category model", () => {
    const result = resolveTaskModel(
      makeInput({
        prompt: "use ulw",
        subagentType: "explore",
        categories: { explore: categoryModel },
        ultraworkModel,
      }),
    )
    expect(result).toEqual(ultraworkModel)
  })

  test("ultrawork keyword ignored when no ultraworkModel configured", () => {
    const result = resolveTaskModel(
      makeInput({
        prompt: "use ulw for this",
        ultraworkModel: undefined,
      }),
    )
    expect(result).toEqual(fallback)
  })

  test("ultrawork keyword inside code block is ignored", () => {
    const result = resolveTaskModel(
      makeInput({
        prompt: "```\nconst mode = 'ulw'\n```",
        ultraworkModel,
      }),
    )
    // keyword is inside fenced code — should not trigger ultrawork
    expect(result).toEqual(fallback)
  })

  test("explicit use_ultrawork without configured model returns category/fallback", () => {
    const result = resolveTaskModel(
      makeInput({
        useUltrawork: true,
        ultraworkModel: undefined,
        subagentType: "explore",
        categories: { explore: categoryModel },
      }),
    )
    expect(result).toEqual(categoryModel)
  })
})
