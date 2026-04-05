import { Session } from "../session"
import type { SessionID } from "../session/schema"

export class SpawnLimitError extends Error {
  constructor(
    public readonly reason: "max_depth" | "max_descendants",
    public readonly limit: number,
    public readonly current: number,
  ) {
    super(
      reason === "max_depth"
        ? `Subagent depth limit reached: current depth ${current} >= max ${limit}`
        : `Subagent descendant limit reached: current count ${current} >= max ${limit}`,
    )
    this.name = "SpawnLimitError"
  }
}

const descendants = new Map<string, number>()

type SpawnReservation = {
  depth: number
  rootSessionID: string
  release: () => void
}

async function getRootSessionID(sessionID: SessionID) {
  let current = sessionID
  while (true) {
    const session = await Session.get(current)
    if (!session.parentID) return String(session.id)
    current = session.parentID
  }
}

async function getSpawnInfo(opts: { sessionID: SessionID; parentID?: SessionID }) {
  const rootSessionID = opts.parentID ? await getRootSessionID(opts.parentID) : String(opts.sessionID)
  const parentDepth = opts.parentID ? await getDepth(opts.parentID) : 0
  return {
    depth: opts.parentID ? parentDepth + 1 : 0,
    parentDepth,
    rootSessionID,
  }
}

export async function getDepth(sessionID: SessionID): Promise<number> {
  let depth = 0
  let current = sessionID

  while (true) {
    const session = await Session.get(current)
    if (!session.parentID) return depth
    current = session.parentID
    depth++
  }
}

export async function assertCanSpawn(opts: {
  sessionID: SessionID
  parentID?: SessionID
  maxDepth: number
  maxDescendants: number
}): Promise<{ depth: number; rootSessionID: string }> {
  const info = await getSpawnInfo(opts)

  if (opts.parentID && info.parentDepth >= opts.maxDepth) {
    throw new SpawnLimitError("max_depth", opts.maxDepth, info.parentDepth)
  }

  const current = descendants.get(info.rootSessionID) ?? 0
  if (current >= opts.maxDescendants) {
    throw new SpawnLimitError("max_descendants", opts.maxDescendants, current)
  }

  return {
    depth: info.depth,
    rootSessionID: info.rootSessionID,
  }
}

export async function reserveSpawn(opts: {
  sessionID: SessionID
  parentID?: SessionID
  maxDepth: number
  maxDescendants: number
}): Promise<SpawnReservation> {
  const info = await getSpawnInfo(opts)

  if (opts.parentID && info.parentDepth >= opts.maxDepth) {
    throw new SpawnLimitError("max_depth", opts.maxDepth, info.parentDepth)
  }

  const current = descendants.get(info.rootSessionID) ?? 0
  if (current >= opts.maxDescendants) {
    throw new SpawnLimitError("max_descendants", opts.maxDescendants, current)
  }

  descendants.set(info.rootSessionID, current + 1)

  let released = false
  return {
    ...info,
    release() {
      if (released) return
      released = true
      releaseSpawn(info.rootSessionID)
    },
  }
}

export function registerSpawn(rootSessionID: string): void {
  descendants.set(rootSessionID, (descendants.get(rootSessionID) ?? 0) + 1)
}

export function releaseSpawn(rootSessionID: string): void {
  const current = descendants.get(rootSessionID)
  if (!current) return
  if (current === 1) {
    descendants.delete(rootSessionID)
    return
  }
  descendants.set(rootSessionID, current - 1)
}
