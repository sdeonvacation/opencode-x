/**
 * StreamingDispatcher — Phase 3 mid-stream tool dispatch.
 *
 * When `enabled` is true, `observe(call, exec)` immediately invokes `exec()`
 * and stores the returned Promise in a `Map<toolCallId, Promise<Result>>`.
 * Subsequent `consume(id)` calls return the same cached Promise regardless of
 * how many concurrent callers await it (first-wins idempotency, §5.4).
 *
 * When `enabled` is false every method is a no-op / returns `undefined`, so
 * the code path is bit-identical to the pre-Phase-3 behaviour.
 *
 * No Effect dependency — plain async/Promise so the module is trivially
 * testable without an Effect runtime.
 */
export namespace StreamingDispatcher {
  export interface Call {
    toolCallId: string
    toolName: string
    input: unknown
  }

  export interface Result {
    toolCallId: string
    output: string
    metadata?: any
  }

  export interface Handle {
    /**
     * Register a pending tool call.
     *
     * When enabled and `call.toolCallId` has not been seen before, calls
     * `exec()` immediately and stores the returned Promise.  If the same id
     * arrives again the second call is a no-op (idempotency guard).
     *
     * When disabled, does nothing.
     */
    observe(call: Call, exec: () => Promise<Result>): void

    /**
     * Retrieve the cached Promise for `toolCallId`.
     *
     * Returns `undefined` when disabled, or when the id was never observed, or
     * after `dispose()` has been called.
     */
    consume(toolCallId: string): Promise<Result | undefined>

    /**
     * Clear the pending-results map.
     *
     * In-flight Promises are detached — their eventual resolution is ignored.
     * Callers that already hold a reference to a Promise via a prior `consume`
     * call will still resolve normally; they just won't be retrievable again.
     */
    dispose(): void
  }

  /**
   * Create a dispatcher handle.
   *
   * @param opts.enabled  When false the handle is a no-op identity stub.
   */
  export function create(opts: { enabled: boolean }): Handle {
    if (!opts.enabled) {
      return {
        observe: _noop,
        consume: _undefinedAsync,
        dispose: _noop,
      }
    }

    // Map from toolCallId → Promise<Result>.  The Promise is created exactly
    // once per id (first-wins); all subsequent consumers share the same
    // reference so concurrent awaits resolve to the same value.
    const pendingResults = new Map<string, Promise<Result>>()

    function observe(call: Call, exec: () => Promise<Result>): void {
      // Idempotency: if this id is already in-flight, do nothing.
      if (pendingResults.has(call.toolCallId)) return
      pendingResults.set(call.toolCallId, exec())
    }

    async function consume(toolCallId: string): Promise<Result | undefined> {
      const pending = pendingResults.get(toolCallId)
      if (pending === undefined) return undefined
      return pending
    }

    function dispose(): void {
      pendingResults.clear()
    }

    return { observe, consume, dispose }
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function _noop(..._args: any[]): void {
  // intentionally empty — no-op stub used when dispatcher is disabled
}

async function _undefinedAsync(_toolCallId: string): Promise<undefined> {
  return undefined
}
