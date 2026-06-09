import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

describe("Instance.isolated", () => {
  test("isolated defaults to false for normal instances", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(Instance.isolated).toBe(false)
      },
    })
  })

  test("isolated is true when provide called with isolated flag", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      isolated: true,
      fn: async () => {
        expect(Instance.isolated).toBe(true)
      },
    })
  })

  test("isolated instances are not cached", async () => {
    await using tmp = await tmpdir()
    let calls = 0
    const state = Instance.state(() => ({ n: ++calls }))

    await Instance.provide({
      directory: tmp.path,
      isolated: true,
      fn: async () => {
        state()
      },
    })

    await Instance.provide({
      directory: tmp.path,
      isolated: true,
      fn: async () => {
        state()
      },
    })

    // Each isolated provide creates fresh state
    expect(calls).toBe(2)
  })

  test("isolated instance does not pollute the cache for normal instances", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      isolated: true,
      fn: async () => {
        expect(Instance.isolated).toBe(true)
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(Instance.isolated).toBe(false)
      },
    })
  })

  test("context exposes isolated via current", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      isolated: true,
      fn: async () => {
        expect(Instance.current.isolated).toBe(true)
      },
    })
  })
})
