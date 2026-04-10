import { Effect } from "effect"
import { MessageV2 } from "./message-v2"

const COALESCE_MS = 300

type Timer = ReturnType<typeof setTimeout>

type Input = {
  flush: (part: MessageV2.Part) => Effect.Effect<void>
}

export type PartCoalescer = {
  readonly update: (part: MessageV2.Part) => Effect.Effect<void>
  readonly flush: () => Effect.Effect<void>
  readonly dispose: () => Effect.Effect<void>
}

function isTerminal(part: MessageV2.Part): boolean {
  if (part.type === "tool") {
    return part.state.status === "completed" || part.state.status === "error"
  }
  if (part.type === "text" || part.type === "reasoning") {
    return !!part.time?.end
  }
  if (
    part.type === "step-start" ||
    part.type === "step-finish" ||
    part.type === "patch" ||
    part.type === "snapshot" ||
    part.type === "compaction" ||
    part.type === "subtask" ||
    part.type === "retry"
  ) {
    return true
  }
  return false
}

export const create = (input: Input): PartCoalescer => {
  const buffer = new Map<string, { part: MessageV2.Part; timer?: Timer }>()
  let disposed = false

  const flushPart = Effect.fn("PartCoalescer.flushPart")(function* (id: string) {
    const current = buffer.get(id)
    if (!current) return
    if (current.timer) clearTimeout(current.timer)
    buffer.delete(id)
    yield* input.flush(current.part)
  })

  const flush = Effect.fn("PartCoalescer.flush")(function* () {
    const ids = [...buffer.keys()]
    for (const id of ids) {
      yield* flushPart(id)
    }
  })

  const update = Effect.fn("PartCoalescer.update")(function* (part: MessageV2.Part) {
    if (disposed) {
      yield* input.flush(part)
      return
    }

    const id = part.id
    const prev = buffer.get(id)
    if (prev?.timer) clearTimeout(prev.timer)
    buffer.set(id, { part })

    if (isTerminal(part)) {
      yield* flushPart(id)
      return
    }

    yield* Effect.sync(() => {
      const timer = setTimeout(() => {
        if (disposed) return
        Effect.runFork(flushPart(id))
      }, COALESCE_MS)
      buffer.set(id, { part, timer })
    })
  })

  const dispose = Effect.fn("PartCoalescer.dispose")(function* () {
    disposed = true
    yield* flush()
    buffer.clear()
  })

  return { update, flush, dispose }
}
