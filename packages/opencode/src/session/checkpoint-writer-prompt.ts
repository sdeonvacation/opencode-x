import type { SessionID } from "./schema"

export function renderSectionBudgets(budgets: Record<string, number>): string {
  const header = "| Section | Budget (tokens) |"
  const sep = "| --- | --- |"
  const rows = Object.entries(budgets).map(([section, budget]) => `| ${section} | ${budget} |`)
  return [header, sep, ...rows].join("\n")
}

export function composeWriterPrompt(input: {
  session: SessionID
  paths: { checkpoint: string; memory: string; notes: string }
  template: string
  budgets: Record<string, number>
}): string {
  const table = renderSectionBudgets(input.budgets)
  return [
    "You are a checkpoint writer. Your job is to produce a structured checkpoint file.",
    "",
    "## Paths",
    "",
    `- Checkpoint: ${input.paths.checkpoint}`,
    `- Memory: ${input.paths.memory}`,
    `- Notes: ${input.paths.notes}`,
    "",
    "## Template",
    "",
    input.template,
    "",
    "## Section Budgets",
    "",
    table,
    "",
    "## Constraints",
    "",
    "- Use absolute paths only when referencing files.",
    "- Section budgets are enforced. Do not exceed token limits per section.",
    "- No tool calls outside the whitelist.",
  ].join("\n")
}
