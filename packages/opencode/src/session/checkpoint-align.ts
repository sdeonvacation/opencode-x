import type { MessageV2 } from "./message-v2"

export function alignToNonToolResultUser(messages: MessageV2.WithParts[], index: number): number {
  if (messages.length === 0) return 0
  for (let i = Math.min(index, messages.length - 1); i >= 0; i--) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    if (msg.parts.length === 0) continue
    if (msg.parts.every((p: MessageV2.Part) => p.type === "tool")) continue
    return i
  }
  return 0
}
