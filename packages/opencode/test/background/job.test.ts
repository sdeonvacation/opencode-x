import { afterEach, describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, ManagedRuntime, Scope } from "effect"
import { BackgroundJob } from "../../src/background/job"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

function setup() {
  return ManagedRuntime.make(BackgroundJob.layer)
}

function run<A>(rt: ManagedRuntime.ManagedRuntime<any, any>, dir: string, effect: Effect.Effect<A, any, any>) {
  return Instance.provide({ directory: dir, fn: () => rt.runPromise(effect) })
}

describe("BackgroundJob", () => {
  test("start returns info with running status", async () => {
    await using tmp = await tmpdir()
    const rt = setup()
    try {
      const info = await run(
        rt,
        tmp.path,
        BackgroundJob.Service.use((svc) => svc.start({ type: "test", title: "hello", run: Effect.succeed("done") })),
      )
      expect(info.type).toBe("test")
      expect(info.title).toBe("hello")
      expect(info.status).toBe("running")
      expect(info.id).toStartWith("job_")
      expect(info.started_at).toBeGreaterThan(0)
    } finally {
      await rt.dispose()
    }
  })

  test("list returns all jobs sorted by started_at", async () => {
    await using tmp = await tmpdir()
    const rt = setup()
    try {
      await run(
        rt,
        tmp.path,
        BackgroundJob.Service.use((svc) =>
          Effect.gen(function* () {
            yield* svc.start({ type: "a", run: Effect.succeed("1") })
            yield* svc.start({ type: "b", run: Effect.succeed("2") })
            const jobs = yield* svc.list()
            expect(jobs.length).toBe(2)
            expect(jobs[0].type).toBe("a")
            expect(jobs[1].type).toBe("b")
          }),
        ),
      )
    } finally {
      await rt.dispose()
    }
  })

  test("get returns job by id", async () => {
    await using tmp = await tmpdir()
    const rt = setup()
    try {
      await run(
        rt,
        tmp.path,
        BackgroundJob.Service.use((svc) =>
          Effect.gen(function* () {
            const info = yield* svc.start({ type: "lookup", run: Effect.succeed("x") })
            const found = yield* svc.get(info.id)
            expect(found).toBeDefined()
            expect(found!.id).toBe(info.id)
          }),
        ),
      )
    } finally {
      await rt.dispose()
    }
  })

  test("get returns undefined for unknown id", async () => {
    await using tmp = await tmpdir()
    const rt = setup()
    try {
      await run(
        rt,
        tmp.path,
        BackgroundJob.Service.use((svc) =>
          Effect.gen(function* () {
            const found = yield* svc.get("job_nonexistent")
            expect(found).toBeUndefined()
          }),
        ),
      )
    } finally {
      await rt.dispose()
    }
  })

  test("wait resolves when job completes", async () => {
    await using tmp = await tmpdir()
    const rt = setup()
    try {
      await run(
        rt,
        tmp.path,
        BackgroundJob.Service.use((svc) =>
          Effect.gen(function* () {
            const info = yield* svc.start({ type: "wait-test", run: Effect.succeed("result") })
            const result = yield* svc.wait({ id: info.id })
            expect(result.timedOut).toBe(false)
            expect(result.info).toBeDefined()
            expect(result.info!.status).toBe("completed")
            expect(result.info!.output).toBe("result")
          }),
        ),
      )
    } finally {
      await rt.dispose()
    }
  })

  test("wait returns timedOut when timeout expires", async () => {
    await using tmp = await tmpdir()
    const rt = setup()
    try {
      await run(
        rt,
        tmp.path,
        BackgroundJob.Service.use((svc) =>
          Effect.gen(function* () {
            const gate = yield* Deferred.make<void>()
            const info = yield* svc.start({
              type: "slow",
              run: Deferred.await(gate).pipe(Effect.as("late")),
            })
            const result = yield* svc.wait({ id: info.id, timeout: 0 })
            expect(result.timedOut).toBe(true)
            expect(result.info).toBeDefined()
            expect(result.info!.status).toBe("running")
          }),
        ),
      )
    } finally {
      await rt.dispose()
    }
  })

  test("wait for unknown id returns not timed out", async () => {
    await using tmp = await tmpdir()
    const rt = setup()
    try {
      await run(
        rt,
        tmp.path,
        BackgroundJob.Service.use((svc) =>
          Effect.gen(function* () {
            const result = yield* svc.wait({ id: "job_unknown" })
            expect(result.timedOut).toBe(false)
            expect(result.info).toBeUndefined()
          }),
        ),
      )
    } finally {
      await rt.dispose()
    }
  })

  test("cancel interrupts running job", async () => {
    await using tmp = await tmpdir()
    const rt = setup()
    try {
      await run(
        rt,
        tmp.path,
        BackgroundJob.Service.use((svc) =>
          Effect.gen(function* () {
            const gate = yield* Deferred.make<void>()
            const info = yield* svc.start({
              type: "cancel-test",
              run: Deferred.await(gate).pipe(Effect.as("never")),
            })
            const cancelled = yield* svc.cancel(info.id)
            expect(cancelled).toBeDefined()
            expect(cancelled!.status).toBe("cancelled")
          }),
        ),
      )
    } finally {
      await rt.dispose()
    }
  })

  test("cancel returns undefined for unknown id", async () => {
    await using tmp = await tmpdir()
    const rt = setup()
    try {
      await run(
        rt,
        tmp.path,
        BackgroundJob.Service.use((svc) =>
          Effect.gen(function* () {
            const result = yield* svc.cancel("job_unknown")
            expect(result).toBeUndefined()
          }),
        ),
      )
    } finally {
      await rt.dispose()
    }
  })

  test("job that fails has error status", async () => {
    await using tmp = await tmpdir()
    const rt = setup()
    try {
      await run(
        rt,
        tmp.path,
        BackgroundJob.Service.use((svc) =>
          Effect.gen(function* () {
            const info = yield* svc.start({
              type: "fail",
              run: Effect.fail(new Error("boom")),
            })
            const result = yield* svc.wait({ id: info.id })
            expect(result.timedOut).toBe(false)
            expect(result.info!.status).toBe("error")
            expect(result.info!.error).toBe("boom")
          }),
        ),
      )
    } finally {
      await rt.dispose()
    }
  })

  test("start with custom id uses that id", async () => {
    await using tmp = await tmpdir()
    const rt = setup()
    try {
      await run(
        rt,
        tmp.path,
        BackgroundJob.Service.use((svc) =>
          Effect.gen(function* () {
            const info = yield* svc.start({ id: "job_custom123", type: "custom", run: Effect.succeed("ok") })
            expect(info.id).toBe("job_custom123")
          }),
        ),
      )
    } finally {
      await rt.dispose()
    }
  })

  test("start with duplicate running id returns existing", async () => {
    await using tmp = await tmpdir()
    const rt = setup()
    try {
      await run(
        rt,
        tmp.path,
        BackgroundJob.Service.use((svc) =>
          Effect.gen(function* () {
            const gate = yield* Deferred.make<void>()
            const a = yield* svc.start({
              id: "job_dup",
              type: "dup",
              run: Deferred.await(gate).pipe(Effect.as("first")),
            })
            const b = yield* svc.start({
              id: "job_dup",
              type: "dup2",
              run: Effect.succeed("second"),
            })
            expect(a.id).toBe(b.id)
            expect(b.status).toBe("running")
          }),
        ),
      )
    } finally {
      await rt.dispose()
    }
  })

  test("metadata is preserved in info", async () => {
    await using tmp = await tmpdir()
    const rt = setup()
    try {
      await run(
        rt,
        tmp.path,
        BackgroundJob.Service.use((svc) =>
          Effect.gen(function* () {
            const info = yield* svc.start({
              type: "meta",
              metadata: { key: "value" },
              run: Effect.succeed("ok"),
            })
            expect(info.metadata).toEqual({ key: "value" })
            const result = yield* svc.wait({ id: info.id })
            expect(result.info!.metadata).toEqual({ key: "value" })
          }),
        ),
      )
    } finally {
      await rt.dispose()
    }
  })
})
