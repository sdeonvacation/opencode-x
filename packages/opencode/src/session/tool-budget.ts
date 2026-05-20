import { MessageV2 } from "./message-v2"

const TRUNCATED = "[tool result truncated to save context]"

/**
 * Applies a character budget to tool result outputs across message history.
 * Iterates oldest-first, summing completed tool output lengths.
 * When budget is exceeded, replaces oldest tool outputs with a truncation marker.
 */
export function applyToolBudget(msgs: MessageV2.WithParts[], budget: number): MessageV2.WithParts[] {
  if (budget <= 0) return msgs

  // Collect all tool outputs with their positions (oldest first)
  const entries: { msg: number; part: number; len: number }[] = []
  for (let m = 0; m < msgs.length; m++) {
    for (let p = 0; p < msgs[m].parts.length; p++) {
      const part = msgs[m].parts[p]
      if (part.type === "tool" && part.state.status === "completed") {
        entries.push({ msg: m, part: p, len: part.state.output.length })
      }
    }
  }

  // Sum total tool output chars
  let total = 0
  for (const entry of entries) {
    total += entry.len
  }

  if (total <= budget) return msgs

  // Determine which entries to truncate (oldest first until under budget)
  const truncate = new Set<string>()
  let excess = total - budget
  for (const entry of entries) {
    if (excess <= 0) break
    truncate.add(`${entry.msg}:${entry.part}`)
    excess -= entry.len
  }

  // Build new array without mutating input
  const result: MessageV2.WithParts[] = []
  for (let m = 0; m < msgs.length; m++) {
    let modified = false
    let parts: MessageV2.Part[] | undefined
    for (let p = 0; p < msgs[m].parts.length; p++) {
      if (truncate.has(`${m}:${p}`)) {
        if (!modified) {
          parts = msgs[m].parts.slice()
          modified = true
        }
        const part = msgs[m].parts[p] as MessageV2.ToolPart
        parts![p] = {
          ...part,
          state: {
            ...part.state,
            output: TRUNCATED,
          } as MessageV2.ToolStateCompleted,
        }
      }
    }
    if (modified) {
      result.push({ ...msgs[m], parts: parts! })
    } else {
      result.push(msgs[m])
    }
  }

  return result
}
