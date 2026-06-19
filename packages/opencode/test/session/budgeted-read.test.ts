import { describe, test, expect } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { readBudgeted, readBudgetedSectionAware } from "@/session/budgeted-read"

describe("readBudgeted", () => {
  test("returns empty for missing file", async () => {
    const result = await readBudgeted("/tmp/nonexistent-budgeted-read.md", 100)
    expect(result.content).toBe("")
    expect(result.truncated).toBe(false)
  })

  test("returns full content within budget", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "small.md")
    await Bun.write(file, "hello world")
    const result = await readBudgeted(file, 100)
    expect(result.content).toBe("hello world")
    expect(result.truncated).toBe(false)
  })

  test("truncates content exceeding budget", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "big.md")
    const content = "x".repeat(800)
    await Bun.write(file, content)
    // budget=100 tokens => 400 chars max
    const result = await readBudgeted(file, 100)
    expect(result.content.length).toBe(400)
    expect(result.truncated).toBe(true)
  })

  test("exact budget boundary is not truncated", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "exact.md")
    const content = "a".repeat(400) // 400 chars = 100 tokens
    await Bun.write(file, content)
    const result = await readBudgeted(file, 100)
    expect(result.content).toBe(content)
    expect(result.truncated).toBe(false)
  })
})

describe("readBudgetedSectionAware", () => {
  test("returns empty for missing file", async () => {
    const result = await readBudgetedSectionAware("/tmp/nonexistent-budgeted-read-sa.md", 100)
    expect(result.content).toBe("")
    expect(result.truncated).toBe(false)
    expect(result.sections).toEqual([])
  })

  test("returns full content with all sections within budget", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "sections.md")
    const content = "## Intro\nhello\n## Details\nworld\n"
    await Bun.write(file, content)
    const result = await readBudgetedSectionAware(file, 1000)
    expect(result.content).toBe(content)
    expect(result.truncated).toBe(false)
    expect(result.sections).toEqual(["Intro", "Details"])
  })

  test("truncates by section boundary", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "large-sections.md")
    const sec1 = "## First\n" + "a".repeat(200) + "\n"
    const sec2 = "## Second\n" + "b".repeat(200) + "\n"
    const sec3 = "## Third\n" + "c".repeat(200) + "\n"
    await Bun.write(file, sec1 + sec2 + sec3)
    // budget enough for ~2 sections but not 3
    // each section is ~210 chars = ~53 tokens
    const result = await readBudgetedSectionAware(file, 110)
    expect(result.truncated).toBe(true)
    expect(result.sections).toEqual(["First", "Second"])
    expect(result.content).toBe(sec1 + sec2)
  })

  test("handles content before first heading", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "preamble.md")
    const content = "preamble text\n## Section\nbody\n"
    await Bun.write(file, content)
    const result = await readBudgetedSectionAware(file, 1000)
    expect(result.content).toBe(content)
    expect(result.sections).toEqual(["Section"])
    expect(result.truncated).toBe(false)
  })

  test("budget too small for any section", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "tight.md")
    const content = "## Big\n" + "x".repeat(2000) + "\n"
    await Bun.write(file, content)
    const result = await readBudgetedSectionAware(file, 10)
    expect(result.truncated).toBe(true)
    expect(result.content).toBe("")
    expect(result.sections).toEqual([])
  })
})
