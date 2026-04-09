/**
 * Pure helper for resolving a subagent session ID from a task tool part.
 *
 * Resolution order (3-tier):
 *  1. `metadataSessionId`  — set by the backend via ctx.metadata(); authoritative.
 *  2. `cache.get(partId)`  — persists across component unmount/remount cycles.
 *  3. Time-ordered index fallback — ranks task parts by `time.start` and maps
 *     them to child sessions sorted by session ID; handles cancelled tasks where
 *     `ctx.metadata()` may never have completed.
 */

export type MinimalToolPart = {
  id: string
  type: string
  tool: string
  sessionID: string
  state: { time?: { start?: number } }
}

export type MinimalSession = {
  id: string
  parentID?: string
}

export type ResolveTaskSessionIdArgs = {
  partId: string
  metadataSessionId: string | undefined
  cache: Map<string, string>
  partState: { time?: { start?: number } }
  syncDataSession: MinimalSession[]
  syncDataPart: Record<string, MinimalToolPart[]>
  parentSessionID: string
}

export function resolveTaskSessionId({
  partId,
  metadataSessionId,
  cache,
  partState,
  syncDataSession,
  syncDataPart,
  parentSessionID,
}: ResolveTaskSessionIdArgs): string | undefined {
  // Tier 1: authoritative metadata from backend
  if (metadataSessionId) {
    cache.set(partId, metadataSessionId)
    return metadataSessionId
  }

  // Tier 2: cached value survives component unmount/remount
  const cached = cache.get(partId)
  if (cached) return cached

  // Tier 3: time-ordered index fallback
  const startTime = partState.time?.start
  if (!startTime) return undefined

  const childSessions = syncDataSession
    .filter((x) => x.parentID === parentSessionID)
    .sort((a, b) => a.id.localeCompare(b.id))
  if (!childSessions.length) return undefined

  const taskParts = Object.values(syncDataPart)
    .flat()
    .filter((p) => p.type === "tool" && p.tool === "task" && p.sessionID === parentSessionID)
    .sort((a, b) => (a.state.time?.start ?? 0) - (b.state.time?.start ?? 0))

  const myIndex = taskParts.findIndex((p) => p.id === partId)
  if (myIndex === -1 || myIndex >= childSessions.length) return undefined

  const id = childSessions[myIndex].id
  cache.set(partId, id)
  return id
}
