export type ProgressItem = { path: string; status: string; at: number }

const WRITTEN_AT_RE = /<!--\s*written_at:\s*(\d+)\s*-->/
const LINE_RE = /^-\s*\[([^\]]+)\]\s+(.+?)\s*<!--\s*written_at:\s*(\d+)\s*-->$/

export function parseWrittenAt(line: string): number | undefined {
  const match = WRITTEN_AT_RE.exec(line)
  if (!match) return undefined
  return parseInt(match[1], 10)
}

export function parseReconciledMap(content: string): Map<string, ProgressItem> {
  const map = new Map<string, ProgressItem>()
  for (const line of content.split("\n")) {
    const match = LINE_RE.exec(line.trim())
    if (!match) continue
    map.set(match[2], { path: match[2], status: match[1], at: parseInt(match[3], 10) })
  }
  return map
}

export function buildProgressDiffItems(
  prev: Map<string, ProgressItem>,
  curr: Map<string, ProgressItem>,
): ProgressItem[] {
  return [...curr.values()].filter((item) => {
    const old = prev.get(item.path)
    if (!old) return true
    return old.status !== item.status
  })
}

export function buildProgressDiff(prev: string, curr: string): string {
  const old = parseReconciledMap(prev)
  const now = parseReconciledMap(curr)
  const items = buildProgressDiffItems(old, now)
  if (items.length === 0) return ""
  return items.map((item) => `- [${item.status}] ${item.path} <!-- written_at: ${item.at} -->`).join("\n")
}
