import { Bus } from "../bus"
import { OrchestrationEvent } from "./events"

type Waiter = {
  resolve: () => void
  reject: (err: Error) => void
  settled: boolean
}

type Slot = {
  active: number
  limit: number
  queue: Waiter[]
}

export class ConcurrencyCancelledError extends Error {
  constructor(public readonly key: string) {
    super(`Concurrency wait cancelled for key: ${key}`)
    this.name = "ConcurrencyCancelledError"
  }
}

const slots = new Map<string, Slot>()

function getSlot(key: string, limit: number) {
  const slot = slots.get(key) ?? { active: 0, limit, queue: [] }
  slot.limit = limit
  slots.set(key, slot)
  return slot
}

function cleanup(key: string, slot: Slot) {
  if (slot.active === 0 && slot.queue.length === 0) slots.delete(key)
}

function cancelWaiter(key: string, slot: Slot, waiter: Waiter) {
  if (waiter.settled) return
  waiter.settled = true
  const index = slot.queue.indexOf(waiter)
  if (index >= 0) slot.queue.splice(index, 1)
  waiter.reject(new ConcurrencyCancelledError(key))
  cleanup(key, slot)
}

export async function acquire(key: string, limit: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new ConcurrencyCancelledError(key)

  const slot = getSlot(key, limit)
  if (slot.active < slot.limit) {
    slot.active++
    return
  }

  await Bus.publish(OrchestrationEvent.ConcurrencyQueued, {
    key,
    queueLength: slot.queue.length + 1,
  })

  await new Promise<void>((resolve, reject) => {
    let onAbort: (() => void) | undefined
    const waiter: Waiter = {
      settled: false,
      resolve: () => {
        if (onAbort) signal?.removeEventListener("abort", onAbort)
        resolve()
      },
      reject: (err) => {
        if (onAbort) signal?.removeEventListener("abort", onAbort)
        reject(err)
      },
    }

    slot.queue.push(waiter)

    if (signal) {
      onAbort = () => cancelWaiter(key, slot, waiter)
      signal.addEventListener("abort", onAbort, { once: true })
      if (signal.aborted) onAbort()
    }
  })
}

export function release(key: string): void {
  const slot = slots.get(key)
  if (!slot || slot.active === 0) return

  slot.active--
  while (slot.queue.length > 0) {
    const next = slot.queue.shift()!
    if (next.settled) continue
    next.settled = true
    slot.active++
    next.resolve()
    void Bus.publish(OrchestrationEvent.ConcurrencyReleased, {
      key,
      queueLength: slot.queue.length,
    })
    return
  }

  cleanup(key, slot)
  void Bus.publish(OrchestrationEvent.ConcurrencyReleased, {
    key,
    queueLength: 0,
  })
}

export function cancelWaiters(key: string): void {
  const slot = slots.get(key)
  if (!slot) return

  const err = new ConcurrencyCancelledError(key)
  for (const waiter of slot.queue) {
    if (waiter.settled) continue
    waiter.settled = true
    waiter.reject(err)
  }
  slot.queue = []
  cleanup(key, slot)
}

export function stats(key: string): { active: number; queued: number } {
  const slot = slots.get(key)
  return {
    active: slot?.active ?? 0,
    queued: slot?.queue.length ?? 0,
  }
}
