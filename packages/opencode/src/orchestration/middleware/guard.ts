import type { TaskExecutor, ExecuteInput, ExecuteResult } from "../executor"
import { create as createGuard } from "../tool-guard"

export class GuardMiddleware implements TaskExecutor {
  constructor(
    private readonly inner: TaskExecutor,
    private readonly guardInput: { toolName: string; input: unknown },
  ) {}

  async execute(input: ExecuteInput): Promise<ExecuteResult> {
    const guard = createGuard({
      sessionID: input.guard.sessionID,
      threshold: input.guard.threshold,
    })
    await guard.before(this.guardInput)
    return this.inner.execute(input)
  }
}
