/**
 * TransformCache — memoize expensive ProviderTransform computations.
 *
 * Cache is bounded at CACHE_MAX entries with LRU eviction (move-to-front on
 * hit, evict least-recently-used on insertion when at capacity).
 * Gated behind cfg.experimental?.transform_cache — callers must check before
 * invoking memo().  When the flag is off callers just invoke the function
 * directly and never touch this module.
 */
export namespace TransformCache {
  /** Maximum number of entries before LRU eviction kicks in. */
  const CACHE_MAX = 256

  export interface Key {
    modelID: string
    toolHash: string
    sessionID: string
  }

  /** Stable string key from a composite cache key. */
  function keyOf(k: Key): string {
    return `${k.modelID}\0${k.toolHash}\0${k.sessionID}`
  }

  // LRU map: Map preserves insertion order; on hit we delete + re-set to move
  // the entry to the "most recently used" (tail) position.  On capacity evict,
  // we remove the head (least recently used).
  const _cache = new Map<string, unknown>()

  /**
   * Return the cached value for key if present, else call fn(), cache the
   * result, and return it.  LRU eviction when size exceeds CACHE_MAX.
   */
  export function memo<T>(key: Key, fn: () => T): T {
    const k = keyOf(key)
    if (_cache.has(k)) {
      // Move to front (most-recently-used tail) to update LRU order.
      const value = _cache.get(k) as T
      _cache.delete(k)
      _cache.set(k, value)
      return value
    }

    const value = fn()

    // Evict least-recently-used (head) entry when at capacity.
    if (_cache.size >= CACHE_MAX) {
      const lru = _cache.keys().next().value
      if (lru !== undefined) _cache.delete(lru)
    }

    _cache.set(k, value)
    return value
  }

  /**
   * Drop all cached entries whose key starts with modelID (i.e. the model's
   * tool list changed — e.g. MCP dynamic registration).
   */
  export function invalidate(modelID: string): void {
    const prefix = modelID + "\0"
    for (const k of _cache.keys()) {
      if (k.startsWith(prefix)) _cache.delete(k)
    }
  }

  /**
   * Stable canonical hash of a tool-id list.
   * Sort + join ensures order-independence.
   * Uses Bun.hash when available, falls back to djb2.
   */
  export function hash(toolIds: string[]): string {
    const canonical = [...toolIds].sort().join(",")
    if (typeof Bun !== "undefined" && typeof (Bun as any).hash === "function") {
      return String((Bun as any).hash(canonical))
    }
    return djb2(canonical)
  }

  /** djb2 hash — fast, collision-tolerant fallback for non-Bun runtimes. */
  function djb2(s: string): string {
    let h = 5381
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h) ^ s.charCodeAt(i)
      h = h >>> 0 // keep unsigned 32-bit
    }
    return h.toString(16)
  }

  /** Exposed for tests only — resets the module-level cache. */
  export function _reset(): void {
    _cache.clear()
  }
}
