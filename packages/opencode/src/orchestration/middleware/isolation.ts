import type { TaskExecutor, ExecuteInput, ExecuteResult } from "../executor"
import { isolatedRun } from "../isolation"
import { formatIsolation } from "../result"

export class IsolationDecorator implements TaskExecutor {
  constructor(private readonly inner: TaskExecutor) {}

  async execute(input: ExecuteInput): Promise<ExecuteResult> {
    const result = await isolatedRun({
      sessionID: input.sessionID,
      run: async () => {
        const inner = await this.inner.execute(input)
        if (inner.tag !== "foreground") throw new Error("IsolationDecorator only wraps foreground executors")
        return inner.text
      },
    })
    return { tag: "foreground", text: formatIsolation(result), sessionID: input.sessionID }
  }
}
