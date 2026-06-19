import type { MessageV2 } from "./message-v2"
import type { MessageID } from "./schema"
import { Token } from "@/util/token"
import { alignToNonToolResultUser } from "./checkpoint-align"

export const TAIL_MIN_TOKENS = 10_000
export const TAIL_MAX_TOKENS = 20_000
export const COMPACTABLE_TOOL_NAMES: Set<string> = new Set(["read", "glob", "grep", "bash", "webfetch", "websearch"])

export type BoundaryResult = {
  index: number
  id: MessageID
  tail: MessageV2.WithParts[]
  head: MessageV2.WithParts[]
}

export function estimateMessageTokens(msg: MessageV2.WithParts): number {
  let tokens = 0
  for (const part of msg.parts) {
    if (part.type === "text" || part.type === "reasoning") {
      tokens += Token.estimate(part.text)
    } else if (part.type === "tool") {
      if (part.state.status === "completed") tokens += Token.estimate(part.state.output)
      if (part.state.status === "error") tokens += Token.estimate(part.state.error)
    }
  }
  return tokens
}

export function computeBoundary(
  messages: MessageV2.WithParts[],
  opts?: { min?: number; max?: number },
): BoundaryResult | undefined {
  if (messages.length <= 2) return undefined
  const min = opts?.min ?? TAIL_MIN_TOKENS
  let tokens = 0
  let candidate = messages.length - 1
  for (let i = messages.length - 1; i >= 0; i--) {
    tokens += estimateMessageTokens(messages[i])
    if (tokens >= min) {
      candidate = i
      break
    }
  }
  if (tokens < min) candidate = 0
  const aligned = alignToNonToolResultUser(messages, candidate)
  // boundary index is the last message of head; split after aligned user msg
  const index = aligned === 0 ? 0 : aligned - 1
  if (index <= 0) return undefined
  return {
    index,
    id: messages[index].info.id,
    head: messages.slice(0, index + 1),
    tail: messages.slice(index + 1),
  }
}
