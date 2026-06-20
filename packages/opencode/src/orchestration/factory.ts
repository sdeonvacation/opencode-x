import type { TaskExecutor, ExecuteInput, ExecutionMode } from "./executor"
import { ForegroundExecutor } from "./executor/foreground"
import { BackgroundExecutor, type BackgroundMeta } from "./executor/background"
import { ConcurrencyMiddleware } from "./middleware/concurrency"
import { GuardMiddleware } from "./middleware/guard"
import { IsolationDecorator } from "./middleware/isolation"
import { Instance } from "@/project/instance"

export type CreateExecutorOptions = {
  mode: ExecutionMode
  isolation?: boolean
  vcs?: string
  worktreeEnabled?: boolean
  guardInput: { toolName: string; input: unknown }
  backgroundMeta?: BackgroundMeta
}

export function createExecutor(opts: CreateExecutorOptions): TaskExecutor {
  const shouldIsolate = opts.isolation && opts.worktreeEnabled && opts.vcs === "git"

  if (opts.mode === "background") {
    if (!opts.backgroundMeta) throw new Error("backgroundMeta required for background mode")
    let executor: TaskExecutor = new BackgroundExecutor(opts.backgroundMeta)
    // Background handles concurrency internally (inside fiber)
    // Guard runs synchronously before fiber fork
    if (shouldIsolate) {
      // Isolation flag passed through to BackgroundExecutor via input.isolation
      // BackgroundExecutor handles isolation internally (inside fiber with Instance.bind)
    }
    return new GuardMiddleware(executor, opts.guardInput)
  }

  // Foreground mode
  let executor: TaskExecutor = new ForegroundExecutor()
  if (shouldIsolate) {
    executor = new IsolationDecorator(executor)
  }
  executor = new ConcurrencyMiddleware(executor)
  return new GuardMiddleware(executor, opts.guardInput)
}
