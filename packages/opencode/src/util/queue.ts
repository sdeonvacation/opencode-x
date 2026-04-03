export class AsyncQueue<T> implements AsyncIterable<T> {
  private queue: T[] = []
  private resolvers: ((value: T) => void)[] = []
  private maxSize: number

  constructor(opts?: { maxSize?: number }) {
    this.maxSize = opts?.maxSize ?? Number.POSITIVE_INFINITY
  }

  push(item: T) {
    const resolve = this.resolvers.shift()
    if (resolve) {
      resolve(item)
      return
    }

    const terminal = item === (null as T)
    if (this.queue.length >= this.maxSize && !terminal) {
      const index = this.queue.findIndex((value) => value !== (null as T))
      if (index === -1) return
      this.queue.splice(index, 1)
    }

    this.queue.push(item)
  }

  async next(): Promise<T> {
    if (this.queue.length > 0) return this.queue.shift()!
    return new Promise((resolve) => this.resolvers.push(resolve))
  }

  async *[Symbol.asyncIterator]() {
    while (true) yield await this.next()
  }
}

export async function work<T>(concurrency: number, items: T[], fn: (item: T) => Promise<void>) {
  const pending = [...items]
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const item = pending.pop()
        if (item === undefined) return
        await fn(item)
      }
    }),
  )
}
