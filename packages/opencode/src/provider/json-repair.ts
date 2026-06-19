/**
 * JsonRepair — state-machine JSON fixer for truncated/malformed tool call arguments.
 *
 * Pure functions, no dependencies, never throws.
 * Handles: unclosed strings, unclosed objects/arrays, trailing commas,
 * truncated numbers, null bytes/control characters.
 */
export namespace JsonRepair {
  /**
   * Attempt to repair malformed JSON. Returns fixed string or undefined if unrecoverable.
   */
  export function repair(input: string): string | undefined {
    if (!input || input.length === 0) return undefined

    // Strip null bytes and control characters (except whitespace)
    let cleaned = ""
    for (let i = 0; i < input.length; i++) {
      const code = input.charCodeAt(i)
      if (code === 0) continue
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) continue
      cleaned += input[i]
    }

    // Try parsing as-is first
    if (tryParse(cleaned)) return cleaned

    // State machine repair
    const result = stateMachineRepair(cleaned)
    if (!result) return undefined

    // Validate repaired output
    if (tryParse(result)) return result
    return undefined
  }

  /**
   * Quick heuristic: does the error suggest truncation/malformed JSON?
   */
  export function isRepairable(input: string, error: string): boolean {
    if (!input || input.length === 0) return false
    const lower = error.toLowerCase()
    if (lower.includes("unexpected end")) return true
    if (lower.includes("unterminated")) return true
    if (lower.includes("expected")) return true
    if (lower.includes("json")) return true
    if (lower.includes("parse")) return true
    if (lower.includes("invalid")) return true
    // Check if input looks like it starts as JSON
    const trimmed = input.trimStart()
    return trimmed.startsWith("{") || trimmed.startsWith("[")
  }

  function tryParse(s: string): boolean {
    try {
      JSON.parse(s)
      return true
    } catch {
      return false
    }
  }

  function stateMachineRepair(input: string): string | undefined {
    const stack: Array<"{" | "[" | '"'> = []
    let out = ""
    let i = 0
    let inString = false
    let escaped = false

    while (i < input.length) {
      const ch = input[i]

      if (inString) {
        if (escaped) {
          out += ch
          escaped = false
          i++
          continue
        }
        if (ch === "\\") {
          escaped = true
          out += ch
          i++
          continue
        }
        if (ch === '"') {
          inString = false
          stack.pop()
          out += ch
          i++
          continue
        }
        out += ch
        i++
        continue
      }

      // Not in string
      if (ch === '"') {
        inString = true
        stack.push('"')
        out += ch
        i++
        continue
      }

      if (ch === "{") {
        stack.push("{")
        out += ch
        i++
        continue
      }

      if (ch === "[") {
        stack.push("[")
        out += ch
        i++
        continue
      }

      if (ch === "}") {
        const idx = stack.lastIndexOf("{")
        if (idx !== -1) stack.splice(idx)
        out += ch
        i++
        continue
      }

      if (ch === "]") {
        const idx = stack.lastIndexOf("[")
        if (idx !== -1) stack.splice(idx)
        out += ch
        i++
        continue
      }

      out += ch
      i++
    }

    // Close unclosed string
    if (inString) {
      out += '"'
      stack.pop()
    }

    // Strip trailing commas before closing
    out = out.replace(/,(\s*)$/, "$1")

    // Fix truncated numbers (e.g., "123." at end)
    out = out.replace(/(\d+)\.$/, "$1.0")
    out = out.replace(/(\d+)\.(\s*[}\]])/, "$1.0$2")

    // Close unclosed containers (in reverse order)
    for (let j = stack.length - 1; j >= 0; j--) {
      const open = stack[j]
      if (open === "{") {
        out = out.replace(/,(\s*)$/, "$1")
        out += "}"
      }
      if (open === "[") {
        out = out.replace(/,(\s*)$/, "$1")
        out += "]"
      }
    }

    // Strip trailing commas before any closer throughout
    out = out.replace(/,(\s*[}\]])/g, "$1")

    if (out.length === 0) return undefined
    return out
  }
}
