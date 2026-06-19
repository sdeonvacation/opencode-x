import { describe, expect, test } from "bun:test"
import {
  validateSnapshot,
  validateLearning,
  validateMemory,
  validateProgress,
  validateBudget,
  validateBudgetSections,
  extractTitlesFromLearning,
} from "../../src/session/checkpoint-validator"

const FULL_SNAPSHOT = `## Current Task
Build the checkpoint system

## Key Decisions
- Use markdown format

## File Changes
- src/foo.ts created

## Open Issues
- None

## Progress Summary
Done
`

const PARTIAL_SNAPSHOT = `## Current Task
Build the checkpoint system

## Key Decisions
- Use markdown format
`

describe("validateSnapshot", () => {
  test("valid with all sections", () => {
    const r = validateSnapshot(FULL_SNAPSHOT)
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  test("invalid with missing sections", () => {
    const r = validateSnapshot(PARTIAL_SNAPSHOT)
    expect(r.valid).toBe(false)
    expect(r.errors).toContain("missing section: ## File Changes")
    expect(r.errors).toContain("missing section: ## Open Issues")
    expect(r.errors).toContain("missing section: ## Progress Summary")
  })

  test("invalid on empty content", () => {
    const r = validateSnapshot("")
    expect(r.valid).toBe(false)
    expect(r.errors).toHaveLength(5)
  })
})

const FULL_MEMORY = `## Project Facts
- Uses bun runtime

## Conventions
- Single word names

## Gotchas
- No mocks
`

describe("validateLearning", () => {
  test("valid with all sections", () => {
    const r = validateLearning(FULL_MEMORY)
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  test("invalid with missing section", () => {
    const r = validateLearning("## Project Facts\n- foo\n")
    expect(r.valid).toBe(false)
    expect(r.errors).toContain("missing section: ## Conventions")
    expect(r.errors).toContain("missing section: ## Gotchas")
  })
})

describe("validateMemory", () => {
  test("valid with all sections", () => {
    const r = validateMemory(FULL_MEMORY)
    expect(r.valid).toBe(true)
  })

  test("invalid on empty", () => {
    const r = validateMemory("")
    expect(r.valid).toBe(false)
    expect(r.errors).toHaveLength(3)
  })
})

describe("validateProgress", () => {
  test("valid with required sections", () => {
    const r = validateProgress("## File Changes\n- foo\n\n## Progress Summary\nDone\n")
    expect(r.valid).toBe(true)
  })

  test("invalid without progress summary", () => {
    const r = validateProgress("## File Changes\n- foo\n")
    expect(r.valid).toBe(false)
    expect(r.errors).toContain("missing section: ## Progress Summary")
  })
})

describe("validateBudget", () => {
  test("passes within budget", () => {
    const budgets = { a: 100, b: 100 }
    const content = "x".repeat(200) // 50 tokens
    const r = validateBudget(content, budgets)
    expect(r.valid).toBe(true)
  })

  test("fails when exceeding budget", () => {
    const budgets = { a: 10, b: 10 }
    const content = "x".repeat(200) // 50 tokens > 20 budget
    const r = validateBudget(content, budgets)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/total tokens 50 exceeds budget 20/)
  })
})

describe("validateBudgetSections", () => {
  test("passes when all sections within budget", () => {
    const content = `## Task\nshort content\n\n## Decisions\nbrief\n`
    const budgets = { task: 500, decisions: 500 }
    const r = validateBudgetSections(content, budgets)
    expect(r.valid).toBe(true)
  })

  test("fails when section exceeds its budget", () => {
    const long = "x".repeat(100) // 25 tokens
    const content = `## Task\n${long}\n\n## Decisions\nbrief\n`
    const budgets = { task: 10, decisions: 500 }
    const r = validateBudgetSections(content, budgets)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/section "task" tokens 25 exceeds budget 10/)
  })

  test("skips sections not found in content", () => {
    const content = `## Task\nshort\n`
    const budgets = { task: 500, missing: 500 }
    const r = validateBudgetSections(content, budgets)
    expect(r.valid).toBe(true)
  })
})

describe("extractTitlesFromLearning", () => {
  test("extracts heading texts", () => {
    const content = `## Project Facts\n- foo\n\n## Conventions\n- bar\n\n## Gotchas\n- baz\n`
    const titles = extractTitlesFromLearning(content)
    expect(titles).toEqual(["Project Facts", "Conventions", "Gotchas"])
  })

  test("returns empty array for no headings", () => {
    expect(extractTitlesFromLearning("no headings here")).toEqual([])
  })

  test("ignores non-h2 headings", () => {
    const content = `# Top\n### Sub\n## Real\n`
    const titles = extractTitlesFromLearning(content)
    expect(titles).toEqual(["Real"])
  })
})
