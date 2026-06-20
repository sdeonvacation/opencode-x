import { Effect, Layer, ManagedRuntime } from "effect"
import * as ServiceMap from "effect/ServiceMap"
import { Instance } from "@/project/instance"
import { Context } from "@/util/context"
import { InstanceRef, WorkspaceRef } from "./instance-ref"
import { Observability } from "./oltp"
import { WorkspaceContext } from "@/control-plane/workspace-context"

export const memoMap = Layer.makeMemoMapUnsafe()

function attach<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  try {
    const ctx = Instance.current
    const workspaceID = WorkspaceContext.workspaceID
    return effect.pipe(Effect.provideService(InstanceRef, ctx), Effect.provideService(WorkspaceRef, workspaceID))
  } catch (err) {
    if (!(err instanceof Context.NotFound)) throw err
  }
  return effect
}

const runtimes: Array<{ dispose: () => Promise<void> }> = []

export function makeRuntime<I, S, E>(service: ServiceMap.Service<I, S>, layer: Layer.Layer<I, E>) {
  let rt: ManagedRuntime.ManagedRuntime<I, E> | undefined
  const getRuntime = () => {
    if (!rt) {
      rt = ManagedRuntime.make(Layer.merge(layer, Observability.layer), { memoMap })
      runtimes.push(rt)
    }
    return rt
  }

  return {
    runSync: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) => getRuntime().runSync(attach(service.use(fn))),
    runPromiseExit: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>, options?: Effect.RunOptions) =>
      getRuntime().runPromiseExit(attach(service.use(fn)), options),
    runPromise: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>, options?: Effect.RunOptions) =>
      getRuntime().runPromise(attach(service.use(fn)), options),
    runFork: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) => getRuntime().runFork(attach(service.use(fn))),
    runCallback: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) =>
      getRuntime().runCallback(attach(service.use(fn))),
  }
}

/** Dispose all ManagedRuntimes created by makeRuntime. Test cleanup only. */
export async function disposeAllRuntimes(timeout = 5000) {
  const pending = runtimes.splice(0)
  if (!pending.length) return
  const deadline = Promise.allSettled(pending.map((rt) => rt.dispose()))
  const timer = new Promise<void>((r) => setTimeout(r, timeout))
  await Promise.race([deadline, timer])
}
