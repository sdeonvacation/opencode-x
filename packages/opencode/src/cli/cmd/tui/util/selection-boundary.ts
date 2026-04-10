import type { Renderable } from "@opentui/core"

export function within(node: Renderable | null | undefined, root: Renderable | null | undefined) {
  if (!node || !root) return false
  let cur: Renderable | null = node
  while (cur) {
    if (cur === root) return true
    cur = cur.parent
  }
  return false
}
