const DEFAULT_THRESHOLD = 5

type Entry = {
  toolName: string
  input: unknown
}

export type LoopDetector = {
  readonly record: (entry: Entry) => void
  readonly detect: (entry: Entry) => boolean
  readonly reset: () => void
}

function hash(entry: Entry) {
  return Bun.hash(entry.toolName + "\0" + JSON.stringify(entry.input))
}

export function create(input?: { threshold?: number }): LoopDetector {
  const threshold = Math.max(1, input?.threshold ?? DEFAULT_THRESHOLD)
  const ring = new Array<ReturnType<typeof Bun.hash>>(threshold)
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

  const reset = () => {
    ring.fill(undefined as never)
    total = 0
  }

  return { record, detect, reset }
}
