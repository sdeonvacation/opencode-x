import { CHECKPOINT_SECTION_BUDGETS, MEMORY_SECTION_BUDGETS } from "./checkpoint-templates"
import { Token } from "@/util/token"

export type ValidationResult = { valid: boolean; errors: string[] }

const CHECKPOINT_SECTIONS = ["Current Task", "Key Decisions", "File Changes", "Open Issues", "Progress Summary"]
const MEMORY_SECTIONS = ["Project Facts", "Conventions", "Gotchas"]
const LEARNING_SECTIONS = MEMORY_SECTIONS
const PROGRESS_SECTIONS = ["File Changes", "Progress Summary"]

function hasSections(content: string, required: string[]): string[] {
  return required.filter((s) => !content.includes(`## ${s}`))
}

function result(errors: string[]): ValidationResult {
  return { valid: errors.length === 0, errors }
}

export function validateSnapshot(content: string): ValidationResult {
  const missing = hasSections(content, CHECKPOINT_SECTIONS)
  return result(missing.map((s) => `missing section: ## ${s}`))
}

export function validateLearning(content: string): ValidationResult {
  const missing = hasSections(content, LEARNING_SECTIONS)
  return result(missing.map((s) => `missing section: ## ${s}`))
}

export function validateMemory(content: string): ValidationResult {
  const missing = hasSections(content, MEMORY_SECTIONS)
  return result(missing.map((s) => `missing section: ## ${s}`))
}

export function validateProgress(content: string): ValidationResult {
  const missing = hasSections(content, PROGRESS_SECTIONS)
  return result(missing.map((s) => `missing section: ## ${s}`))
}

export function validateBudget(content: string, budgets: Record<string, number>): ValidationResult {
  const total = Object.values(budgets).reduce((sum, v) => sum + v, 0)
  const tokens = Token.estimate(content)
  if (tokens > total) return result([`total tokens ${tokens} exceeds budget ${total}`])
  return result([])
}

export function validateBudgetSections(content: string, budgets: Record<string, number>): ValidationResult {
  const errors: string[] = []
  const headings = Object.keys(budgets)
  const lines = content.split("\n")

  for (const key of headings) {
    const budget = budgets[key]
    const idx = lines.findIndex((l) => l.startsWith("## ") && l.toLowerCase().includes(key.toLowerCase()))
    if (idx === -1) continue
    const end = lines.findIndex((l, i) => i > idx && l.startsWith("## "))
    const section = lines.slice(idx + 1, end === -1 ? undefined : end).join("\n")
    const tokens = Token.estimate(section)
    if (tokens > budget) errors.push(`section "${key}" tokens ${tokens} exceeds budget ${budget}`)
  }

  return result(errors)
}

export function extractTitlesFromLearning(content: string): string[] {
  return content
    .split("\n")
    .filter((l) => l.startsWith("## "))
    .map((l) => l.slice(3).trim())
}
