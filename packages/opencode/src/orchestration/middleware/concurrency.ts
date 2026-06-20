import type { TaskExecutor, ExecuteInput, ExecuteResult } from "../executor"
import { acquire, release } from "../concurrency"

export class ConcurrencyMiddleware implements TaskExecutor {
  constructor(private readonly inner: TaskExecutor) {}

  async execute(input: ExecuteInput): Promise<ExecuteResult> {
    await acquire(input.concurrency.key, input.concurrency.limit, input.abort)
    try {
      return await this.inner.execute(input)
    } finally {
      release(input.concurrency.key)
    }
  }
}
