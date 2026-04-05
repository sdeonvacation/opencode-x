import { Bus } from "../bus"
import { OrchestrationEvent } from "./events"
import { create as createDetector } from "./loop-detector"

const MAX_IDLE_MS = 60 * 60 * 1000
const MAX_DETECTORS = 1000

type Entry = {
  threshold: number
  detector: ReturnType<typeof createDetector>
  touched: number
}

const detectors = new Map<string, Entry>()

function cleanup(now: number) {
  for (const [sessionID, entry] of detectors) {
    if (now - entry.touched <= MAX_IDLE_MS) continue
    detectors.delete(sessionID)
  }
  if (detectors.size <= MAX_DETECTORS) return
  const oldest = [...detectors.entries()].sort((a, b) => a[1].touched - b[1].touched)
  for (const [sessionID] of oldest) {
    if (detectors.size <= MAX_DETECTORS) break
    detectors.delete(sessionID)
  }
}

export class LoopDetectedError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly threshold: number,
  ) {
    super(
      `Loop detected: tool "${toolName}" called ${threshold} consecutive times with identical input. Aborting to prevent infinite loop.`,
    )
    this.name = "LoopDetectedError"
  }
}

export type ToolGuard = {
  readonly before: (entry: { toolName: string; input: unknown }) => Promise<void>
  readonly reset: () => void
}

export function create(opts: { sessionID: string; threshold: number }): ToolGuard {
  const now = Date.now()
  cleanup(now)
  const detector = (() => {
    const found = detectors.get(opts.sessionID)
    if (found && found.threshold === opts.threshold) {
      found.touched = now
      return found.detector
    }
    const created = createDetector({ threshold: opts.threshold })
    detectors.set(opts.sessionID, { threshold: opts.threshold, detector: created, touched: now })
    return created
  })()

  return {
    async before(entry) {
      const found = detectors.get(opts.sessionID)
      if (found) found.touched = Date.now()
      detector.record(entry)
      if (!detector.detect(entry)) return
      await Bus.publish(OrchestrationEvent.LoopDetected, {
        sessionID: opts.sessionID,
        toolName: entry.toolName,
        count: opts.threshold,
      })
      throw new LoopDetectedError(entry.toolName, opts.threshold)
    },
    reset() {
      detector.reset()
      detectors.delete(opts.sessionID)
    },
  }
}
