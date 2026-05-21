const DEFAULT_THRESHOLD = 3

type Entry = {
  toolName: string
  input: unknown
}

export type DoomLoopDetector = {
  readonly record: (entry: Entry) => void
  readonly detect: (entry: Entry) => boolean
}

/** djb2 hash — fast, collision-tolerant fallback for non-Bun runtimes. */
function djb2(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i)
    h = h >>> 0 // keep unsigned 32-bit
  }
  return h
}

function hash(entry: Entry): number {
  const canonical = entry.toolName + "\0" + JSON.stringify(entry.input)
  // [fork-perf] Phase 1B: Bun.hash may not exist on Node; fall back to djb2
  if (typeof Bun !== "undefined" && typeof (Bun as any).hash === "function") {
    return Number((Bun as any).hash(canonical))
  }
  return djb2(canonical)
}

export function create(input?: { threshold?: number }): DoomLoopDetector {
  const threshold = Math.max(1, input?.threshold ?? DEFAULT_THRESHOLD)
  const ring = new Array<number>(threshold)
  let total = 0

  const record = (entry: Entry) => {
    ring[total % threshold] = hash(entry)
    total++
  }

  const detect = (entry: Entry) => {
    if (total < threshold) return false
    const sig = hash(entry)
    const start = total - threshold
    for (let i = 0; i < threshold; i++) {
      if (ring[(start + i) % threshold] !== sig) return false
    }
    return true
  }

  return { record, detect }
}
