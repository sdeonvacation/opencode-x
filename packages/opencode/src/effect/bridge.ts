import { Effect, Exit, Fiber, ServiceMap } from "effect"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { InstanceRef, WorkspaceRef } from "./instance-ref"

export interface Shape {
  readonly promise: <A, E, R>(effect: Effect.Effect<A, E, R>) => Promise<A>
  readonly fork: <A, E, R>(effect: Effect.Effect<A, E, R>) => Fiber.Fiber<A, E>
  readonly run: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E>
  readonly bind: <Args extends readonly unknown[], Result>(fn: (...args: Args) => Result) => (...args: Args) => Result
}

function captureSync() {
  const fiber = Fiber.getCurrent()
  const instance = fiber ? ServiceMap.getReferenceUnsafe(fiber.services, InstanceRef) : undefined
  const workspace =
    (fiber ? ServiceMap.getReferenceUnsafe(fiber.services, WorkspaceRef) : undefined) ?? WorkspaceContext.workspaceID
  return { instance, workspace }
}

function attachWith<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  captured: { instance: any; workspace: any },
): Effect.Effect<A, E, R> {
  let result = effect
  if (captured.instance !== undefined) result = Effect.provideService(result, InstanceRef, captured.instance) as any
  if (captured.workspace !== undefined) result = Effect.provideService(result, WorkspaceRef, captured.workspace) as any
  return result
}

export function make() {
  return Effect.gen(function* () {
    const ctx = yield* Effect.services()
    const captured = captureSync()
    const instance = (yield* InstanceRef) ?? captured.instance
    const workspace = (yield* WorkspaceRef) ?? captured.workspace

    const wrap = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      attachWith(effect.pipe(Effect.provide(ctx)) as Effect.Effect<A, E, never>, { instance, workspace })

    return {
      promise: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromise(wrap(effect)),
      fork: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runFork(wrap(effect)),
      run: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.callback<A, E>((resume) => {
          Effect.runPromiseExit(wrap(effect)).then((exit) =>
            resume(Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause)),
          )
        }),
      bind:
        <Args extends readonly unknown[], Result>(fn: (...args: Args) => Result) =>
        (...args: Args) =>
          Effect.runSync(wrap(Effect.sync(() => fn(...args)))),
    } satisfies Shape
  })
}

export * as EffectBridge from "./bridge"
