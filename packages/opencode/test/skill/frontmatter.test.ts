import { test, expect, describe } from "bun:test"
import { Skill } from "../../src/skill"

describe("parseExtras", () => {
  test("empty raw returns all undefined", () => {
    const out = Skill.parseExtras({})
    expect(out.whenToUse).toBeUndefined()
    expect(out.disableModelInvocation).toBeUndefined()
    expect(out.paths).toBeUndefined()
  })

  test("when_to_use snake-case alias", () => {
    const out = Skill.parseExtras({ when_to_use: "Use when refactoring" })
    expect(out.whenToUse).toBe("Use when refactoring")
  })

  test("whenToUse camel-case wins over snake_case", () => {
    const out = Skill.parseExtras({ whenToUse: "camel", when_to_use: "snake" })
    expect(out.whenToUse).toBe("camel")
  })

  test("disable-model-invocation kebab alias coerced from boolean", () => {
    expect(Skill.parseExtras({ "disable-model-invocation": true }).disableModelInvocation).toBe(true)
    expect(Skill.parseExtras({ "disable-model-invocation": false }).disableModelInvocation).toBe(false)
  })

  test("disable-model-invocation accepts string 'true'/'false'", () => {
    expect(Skill.parseExtras({ "disable-model-invocation": "true" }).disableModelInvocation).toBe(true)
    expect(Skill.parseExtras({ "disable-model-invocation": "false" }).disableModelInvocation).toBe(false)
  })

  test("paths string normalized", () => {
    expect(Skill.parseExtras({ paths: "src/**" }).paths).toEqual(["src"])
  })

  test("paths array normalized", () => {
    expect(Skill.parseExtras({ paths: ["**/*.py", "src/**"] }).paths).toEqual(["**/*.py", "src"])
  })

  test("paths '**' yields undefined", () => {
    expect(Skill.parseExtras({ paths: "**" }).paths).toBeUndefined()
  })

  test("backward compat — no extras returns undefined fields", () => {
    const out = Skill.parseExtras({ name: "x", description: "y" })
    expect(out.whenToUse).toBeUndefined()
    expect(out.disableModelInvocation).toBeUndefined()
    expect(out.paths).toBeUndefined()
  })
})

describe("Info schema", () => {
  test("parses minimal skill (no extras)", () => {
    const result = Skill.Info.safeParse({
      name: "foo",
      description: "bar",
      location: "/x/SKILL.md",
      content: "# foo",
    })
    expect(result.success).toBe(true)
  })

  test("parses skill with all extras", () => {
    const result = Skill.Info.safeParse({
      name: "foo",
      description: "bar",
      location: "/x/SKILL.md",
      content: "# foo",
      whenToUse: "use when X",
      disableModelInvocation: true,
      paths: ["**/*.ts"],
    })
    expect(result.success).toBe(true)
  })
})

describe("fmt with whenToUse", () => {
  const skill: Skill.Info = {
    name: "foo",
    description: "Base description",
    location: "/abs/SKILL.md",
    content: "# foo",
    whenToUse: "Use when refactoring",
  }

  test("non-verbose appends whenToUse after description", () => {
    const out = Skill.fmt([skill], { verbose: false })
    expect(out).toContain("- **foo**: Base description: Use when refactoring")
  })

  test("verbose includes <when_to_use> child", () => {
    const out = Skill.fmt([skill], { verbose: true })
    expect(out).toContain("<when_to_use>Use when refactoring</when_to_use>")
  })

  test("non-verbose without whenToUse omits suffix", () => {
    const plain: Skill.Info = {
      name: "bar",
      description: "Plain",
      location: "/abs/SKILL.md",
      content: "",
    }
    const out = Skill.fmt([plain], { verbose: false })
    expect(out).toContain("- **bar**: Plain")
    expect(out).not.toContain("Plain:")
  })
})

describe("Skill filter predicates", () => {
  const isModelInvocable = (s: Skill.Info) => s.disableModelInvocation !== true

  test("modelInvocable drops disableModelInvocation:true", () => {
    const a: Skill.Info = { name: "a", description: "", location: "", content: "" }
    const b: Skill.Info = { ...a, name: "b", disableModelInvocation: true }
    const c: Skill.Info = { ...a, name: "c", disableModelInvocation: false }
    expect([a, b, c].filter(isModelInvocable).map((s) => s.name)).toEqual(["a", "c"])
  })
})
