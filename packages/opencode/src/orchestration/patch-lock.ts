type Waiter = {
  resolve: () => void
}

type Lock = {
  held: boolean
  queue: Waiter[]
}

const locks = new Map<string, Lock>()

export async function acquire(project: string): Promise<void> {
  const lock = locks.get(project) ?? { held: false, queue: [] }
  locks.set(project, lock)

  if (!lock.held) {
    lock.held = true
    return
  }

  await new Promise<void>((resolve) => {
    lock.queue.push({ resolve })
  })
}

export function release(project: string): void {
  const lock = locks.get(project)
  if (!lock) return

  // Transfer ownership to next waiter (held stays true)
  const next = lock.queue.shift()
  if (next) {
    next.resolve()
    return
  }

  lock.held = false
  if (lock.queue.length === 0) locks.delete(project)
}
