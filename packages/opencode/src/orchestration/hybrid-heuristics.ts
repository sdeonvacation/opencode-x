import type { OperationType } from "./hybrid-types"

const COMPLEX_RE = /(npm|yarn|pnpm|bun|docker|gradle|mvn|build|deploy|test)\b/i
const SIMPLE_RE = /(echo|pwd|whoami|env)\b/i

/**
 * Regex-based bash command classification.
 * Returns "bash_complex" or "bash_simple" when matched, undefined otherwise.
 * Heuristics only upgrade (simple → complex), never downgrade.
 */
export function classify(cmd: string): OperationType | undefined {
  if (COMPLEX_RE.test(cmd)) return "bash_complex"
  if (SIMPLE_RE.test(cmd)) return "bash_simple"
  return undefined
}
