import fs from "fs/promises"
import type { SessionID } from "./schema"
import { type ValidationResult, validateSnapshot, validateBudget } from "./checkpoint-validator"
import { checkpointPath } from "./checkpoint-paths"
import { CHECKPOINT_SECTION_BUDGETS } from "./checkpoint-templates"

export async function loadPriorDiscoveredTitles(session: SessionID): Promise<string[]> {
  const file = checkpointPath(session)
  const content = await Bun.file(file)
    .text()
    .catch(() => "")
  if (!content) return []
  return content
    .split("\n")
    .filter((l) => l.startsWith("## "))
    .map((l) => l.slice(3).trim())
}

export async function runValidatorsForCkpt(session: SessionID): Promise<ValidationResult> {
  const file = checkpointPath(session)
  const content = await Bun.file(file)
    .text()
    .catch(() => "")
  if (!content) return { valid: false, errors: ["checkpoint file not found or empty"] }
  const snap = validateSnapshot(content)
  if (!snap.valid) return snap
  const budget = validateBudget(content, CHECKPOINT_SECTION_BUDGETS)
  if (!budget.valid) return budget
  return { valid: true, errors: [] }
}

export async function quarantineCheckpoint(session: SessionID): Promise<void> {
  const src = checkpointPath(session)
  const dst = src.replace(/\.md$/, ".quarantine.md")
  await fs.rename(src, dst)
}

export function buildReflectionMessage(errors: string[]): string {
  const items = errors.map((e, i) => `${i + 1}. ${e}`)
  return [
    "The previous checkpoint failed validation:",
    "",
    ...items,
    "",
    "Fix the above issues and regenerate the checkpoint.",
  ].join("\n")
}
