import { describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { make } from "../../src/effect/bridge"

describe("EffectBridge", () => {
  test("make returns shape with promise/fork/run/bind", async () => {
    const bridge = await Effect.runPromise(make())
    expect(bridge.promise).toBeFunction()
    expect(bridge.fork).toBeFunction()
    expect(bridge.run).toBeFunction()
    expect(bridge.bind).toBeFunction()
  })

  test("promise resolves effect to value", async () => {
    const bridge = await Effect.runPromise(make())
    const result = await bridge.promise(Effect.succeed(42))
    expect(result).toBe(42)
  })

  test("promise rejects on failure", async () => {
    const bridge = await Effect.runPromise(make())
    await expect(bridge.promise(Effect.fail("boom"))).rejects.toThrow()
  })

  test("fork returns a fiber", async () => {
    const bridge = await Effect.runPromise(make())
    const fiber = bridge.fork(Effect.succeed("hello"))
    expect(fiber).toBeDefined()
    const result = await Effect.runPromise(Fiber.join(fiber))
    expect(result).toBe("hello")
  })

  test("run wraps effect for deferred execution", async () => {
    const bridge = await Effect.runPromise(make())
    const wrapped = bridge.run(Effect.succeed(99))
    const result = await Effect.runPromise(wrapped)
    expect(result).toBe(99)
  })

  test("run propagates failure", async () => {
    const bridge = await Effect.runPromise(make())
    const wrapped = bridge.run(Effect.fail("err"))
    const exit = await Effect.runPromiseExit(wrapped)
    expect(exit._tag).toBe("Failure")
  })

  test("bind wraps sync function", async () => {
    const bridge = await Effect.runPromise(make())
    const add = (a: number, b: number) => a + b
    const bound = bridge.bind(add)
    expect(bound(3, 4)).toBe(7)
  })
})
