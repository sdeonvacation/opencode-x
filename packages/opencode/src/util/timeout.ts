export class TimeoutError extends Error {
  readonly ms: number
  constructor(ms: number) {
    super(`Operation timed out after ${ms}ms`)
    this.name = "TimeoutError"
    this.ms = ms
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeout: NodeJS.Timeout
  return Promise.race([
    promise.then((result) => {
      clearTimeout(timeout)
      return result
    }),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new TimeoutError(ms))
      }, ms)
    }),
  ])
}
