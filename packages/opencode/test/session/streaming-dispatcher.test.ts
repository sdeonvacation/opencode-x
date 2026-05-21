import { describe, expect, test } from "bun:test"
import { StreamingDispatcher } from "../../src/session/streaming-dispatcher"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(toolCallId: string, output = "ok"): StreamingDispatcher.Result {
  return { toolCallId, output, metadata: {} }
}

function makeExec(
  toolCallId: string,
  output = "ok",
  delayMs = 0,
): () => Promise<StreamingDispatcher.Result> {
  return () =>
    new Promise((resolve) =>
      delayMs > 0
        ? setTimeout(() => resolve(makeResult(toolCallId, output)), delayMs)
        : resolve(makeResult(toolCallId, output)),
    )
}

// ---------------------------------------------------------------------------
// Tests: disabled dispatcher (enabled: false)
// ---------------------------------------------------------------------------

describe("StreamingDispatcher — disabled", () => {
  test("observe is a no-op (exec never called)", () => {
    const handle = StreamingDispatcher.create({ enabled: false })
    let called = false
    handle.observe({ toolCallId: "id_1", toolName: "bash", input: {} }, () => {
      called = true
      return Promise.resolve(makeResult("id_1"))
    })
    expect(called).toBe(false)
  })

  test("consume returns undefined", async () => {
    const handle = StreamingDispatcher.create({ enabled: false })
    handle.observe({ toolCallId: "id_1", toolName: "bash", input: {} }, makeExec("id_1"))
    const result = await handle.consume("id_1")
    expect(result).toBeUndefined()
  })

  test("consume returns undefined for unknown id", async () => {
    const handle = StreamingDispatcher.create({ enabled: false })
    const result = await handle.consume("id_unknown")
    expect(result).toBeUndefined()
  })

  test("dispose does not throw", () => {
    const handle = StreamingDispatcher.create({ enabled: false })
    expect(() => handle.dispose()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Tests: enabled dispatcher (enabled: true)
// ---------------------------------------------------------------------------

describe("StreamingDispatcher — enabled", () => {
  test("observe call_1 then consume returns the result", async () => {
    const handle = StreamingDispatcher.create({ enabled: true })
    handle.observe({ toolCallId: "call_1", toolName: "bash", input: { command: "ls" } }, makeExec("call_1", "file.txt"))
    const result = await handle.consume("call_1")
    expect(result).not.toBeUndefined()
    expect(result!.toolCallId).toBe("call_1")
    expect(result!.output).toBe("file.txt")
  })

  test("consume unknown id returns undefined", async () => {
    const handle = StreamingDispatcher.create({ enabled: true })
    const result = await handle.consume("never_observed")
    expect(result).toBeUndefined()
  })

  test("idempotency: observe twice with same id executes only once", async () => {
    const handle = StreamingDispatcher.create({ enabled: true })
    let execCount = 0

    const exec = () => {
      execCount++
      return Promise.resolve(makeResult("call_1", `run_${execCount}`))
    }

    handle.observe({ toolCallId: "call_1", toolName: "bash", input: {} }, exec)
    handle.observe({ toolCallId: "call_1", toolName: "bash", input: {} }, exec)

    expect(execCount).toBe(1)

    const result = await handle.consume("call_1")
    expect(result!.output).toBe("run_1")
  })

  test("idempotency: two concurrent consumes for same id resolve to same value", async () => {
    const handle = StreamingDispatcher.create({ enabled: true })
    // Use a small delay so the Promise is still in-flight when consume is called
    handle.observe(
      { toolCallId: "call_1", toolName: "bash", input: {} },
      makeExec("call_1", "shared_output", 20),
    )

    const [r1, r2] = await Promise.all([handle.consume("call_1"), handle.consume("call_1")])

    expect(r1).not.toBeUndefined()
    expect(r2).not.toBeUndefined()
    // Both must be the exact same resolved value
    expect(r1!.output).toBe("shared_output")
    expect(r2!.output).toBe("shared_output")
    expect(r1).toBe(r2)
  })

  test("3 parallel calls fork concurrently and all results are retrievable", async () => {
    const handle = StreamingDispatcher.create({ enabled: true })
    const started: string[] = []

    const makeTrackedExec =
      (id: string, delayMs: number) => (): Promise<StreamingDispatcher.Result> => {
        started.push(id)
        return new Promise((resolve) =>
          setTimeout(() => resolve(makeResult(id, `output_${id}`)), delayMs),
        )
      }

    // Observe all three — exec() is called synchronously inside observe
    handle.observe({ toolCallId: "c1", toolName: "read", input: {} }, makeTrackedExec("c1", 30))
    handle.observe({ toolCallId: "c2", toolName: "grep", input: {} }, makeTrackedExec("c2", 20))
    handle.observe({ toolCallId: "c3", toolName: "ls", input: {} }, makeTrackedExec("c3", 10))

    // All three execs must have started immediately (no sequencing)
    expect(started).toEqual(["c1", "c2", "c3"])

    const [r1, r2, r3] = await Promise.all([
      handle.consume("c1"),
      handle.consume("c2"),
      handle.consume("c3"),
    ])

    expect(r1!.output).toBe("output_c1")
    expect(r2!.output).toBe("output_c2")
    expect(r3!.output).toBe("output_c3")
  })

  test("dispose clears map — consume returns undefined for previously observed id", async () => {
    const handle = StreamingDispatcher.create({ enabled: true })
    handle.observe({ toolCallId: "call_1", toolName: "bash", input: {} }, makeExec("call_1"))

    // Verify it's observable before dispose
    const before = await handle.consume("call_1")
    expect(before).not.toBeUndefined()

    handle.dispose()

    // After dispose the map is cleared; new consume returns undefined
    const after = await handle.consume("call_1")
    expect(after).toBeUndefined()
  })

  test("dispose: callers that already hold a Promise reference still resolve", async () => {
    const handle = StreamingDispatcher.create({ enabled: true })
    handle.observe(
      { toolCallId: "call_1", toolName: "bash", input: {} },
      makeExec("call_1", "still_resolves", 30),
    )

    // Grab the Promise reference before dispose
    const promiseRef = handle.consume("call_1")

    handle.dispose()

    // The detached Promise should still resolve via the existing reference
    const result = await promiseRef
    expect(result!.output).toBe("still_resolves")
  })

  test("result includes metadata when provided by exec", async () => {
    const handle = StreamingDispatcher.create({ enabled: true })
    handle.observe({ toolCallId: "call_meta", toolName: "read", input: {} }, () =>
      Promise.resolve({ toolCallId: "call_meta", output: "content", metadata: { lines: 42 } }),
    )

    const result = await handle.consume("call_meta")
    expect(result!.metadata).toEqual({ lines: 42 })
  })
})
