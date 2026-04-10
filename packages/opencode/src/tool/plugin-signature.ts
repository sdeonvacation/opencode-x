/**
 * Stable identity computation for plugin tool definitions.
 * Assigns monotonically-increasing IDs to plugin hook objects and their
 * `tool.definition` function references so that registry.ts can detect
 * when the plugin set changes and invalidate its tool cache.
 */

export type PluginSignatureState<TCache = unknown> = {
  pluginHookID: WeakMap<object, number>
  pluginFunctionID: WeakMap<Function, number>
  pluginHookSeq: number
  /** Set to undefined by computePluginDefinitionSignature when a new hook/fn is seen */
  cache?: TCache
}

/** Create the initial (empty) state for plugin signature tracking. */
export function createPluginSignatureState<TCache = unknown>(): PluginSignatureState<TCache> {
  return {
    pluginHookID: new WeakMap(),
    pluginFunctionID: new WeakMap(),
    pluginHookSeq: 1,
  }
}

/**
 * Compute a stable comma-joined signature string for the given plugin hooks.
 *
 * Each hook object and its `tool.definition` function are assigned a stable
 * numeric ID on first encounter (stored in `state`).  When a new hook or a
 * new function reference is seen, `state.cache` is set to `undefined` so the
 * caller knows the cache is stale.
 *
 * @param hooks  The list of plugin hook objects returned by `plugin.list()`.
 * @param state  Mutable state that persists across calls (WeakMaps + seq counter).
 * @returns      A comma-joined string like `"1:2,3:4"` — empty string when no hooks have `tool.definition`.
 */
export function computePluginDefinitionSignature<TCache>(
  hooks: readonly object[],
  state: PluginSignatureState<TCache>,
): string {
  const ids: string[] = []
  for (const hook of hooks) {
    const fn = (hook as Record<string, unknown>)["tool.definition"]
    if (!fn) continue

    let hookID = state.pluginHookID.get(hook)
    if (!hookID) {
      hookID = state.pluginHookSeq++
      state.pluginHookID.set(hook, hookID)
      state.cache = undefined
    }

    let fnID = state.pluginFunctionID.get(fn as Function)
    if (!fnID) {
      fnID = state.pluginHookSeq++
      state.pluginFunctionID.set(fn as Function, fnID)
      state.cache = undefined
    }

    ids.push(`${hookID}:${fnID}`)
  }
  return ids.join(",")
}
