/**
 * ListenerIndex — fast O(1) membership check for plugin hook event names.
 *
 * Built once at hook-load time from all loaded plugin hook modules.
 * Future: rebuild on MCP hot-reload (see HLD §10 future work).
 */
export namespace ListenerIndex {
  /**
   * Build a counter map: event-name → number of plugins that have a truthy
   * value for that key.  Lenient — hooks may have any shape; we iterate own
   * enumerable keys and count truthy values only.
   */
  export function build(hooks: any[]): Map<string, number> {
    const index = new Map<string, number>()
    for (const hook of hooks) {
      if (!hook || typeof hook !== "object") continue
      for (const key of Object.keys(hook)) {
        if (!hook[key]) continue // skip falsy (undefined, null, false)
        index.set(key, (index.get(key) ?? 0) + 1)
      }
    }
    return index
  }

  /**
   * O(1) membership test — returns true when at least one plugin listens on
   * the given event name.
   */
  export function has(idx: Map<string, number>, name: string): boolean {
    return (idx.get(name) ?? 0) > 0
  }
}
