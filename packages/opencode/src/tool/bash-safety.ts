/**
 * [fork-perf] BashSafety — read-only bash command whitelist for Phase 2 parallel-safety.
 * New file: does not exist upstream. Rebase-safe additive.
 */
export namespace BashSafety {
  /**
   * Prefixes considered read-only. Commands must begin with one of these tokens
   * (after trimming leading whitespace) to be eligible for parallel execution.
   */
  export const WHITELIST_PREFIXES: readonly string[] = [
    "ls",
    "cat",
    "grep",
    "find",
    "git status",
    "git log",
    "git diff",
    "pwd",
    "wc",
  ]

  /** Characters that introduce command chaining — any presence rejects the command. */
  const CHAIN_CHARS = ["&&", "||", ";", "|"]

  /**
   * Returns true iff `cmd` is a read-only command: no chaining characters and
   * the trimmed command starts with one of the WHITELIST_PREFIXES.
   *
   * v1 semantics: any chaining character anywhere in the string causes rejection.
   */
  export function isReadOnly(cmd: string): boolean {
    const trimmed = cmd.trimStart()

    // Reject any command that contains chaining operators
    for (const chain of CHAIN_CHARS) {
      if (trimmed.includes(chain)) return false
    }

    // Accept if the trimmed command starts with a whitelisted prefix followed by
    // end-of-string, a space, or a dash (flag).
    for (const prefix of WHITELIST_PREFIXES) {
      if (trimmed === prefix) return true
      if (trimmed.startsWith(prefix + " ") || trimmed.startsWith(prefix + "\t")) return true
    }

    return false
  }
}
