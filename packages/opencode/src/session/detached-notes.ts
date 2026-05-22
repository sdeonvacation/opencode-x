import type { SessionID } from "./schema"

// fork: background-detach (#FORK) — begin
export namespace DetachedNotes {
  export type Note = {
    state: "completed" | "error" | "cancelled"
    summary: string
  }

  const notes = new Map<string, Note[]>()

  export function queue(sessionID: SessionID, state: Note["state"], summary: string) {
    const existing = notes.get(sessionID) ?? []
    existing.push({ state, summary })
    notes.set(sessionID, existing)
  }

  export function drain(sessionID: SessionID): Note[] {
    const existing = notes.get(sessionID) ?? []
    notes.delete(sessionID)
    return existing
  }

  export function peek(sessionID: SessionID): readonly Note[] {
    return notes.get(sessionID) ?? []
  }

  // --- Protection: children immune to cancel cascade ---
  const protected_ = new Set<string>()

  export function protect(sessionID: SessionID) {
    protected_.add(sessionID)
  }

  export function unprotect(sessionID: SessionID) {
    protected_.delete(sessionID)
  }

  export function isProtected(sessionID: SessionID): boolean {
    return protected_.has(sessionID)
  }

  // --- Detaching flag: distinguishes bg detach from regular interrupt ---
  const detaching = new Set<string>()

  export function markDetaching(sessionID: SessionID) {
    detaching.add(sessionID)
  }

  export function clearDetaching(sessionID: SessionID) {
    detaching.delete(sessionID)
  }

  export function isDetaching(sessionID: SessionID): boolean {
    return detaching.has(sessionID)
  }

  // --- Parent → detached children tracking ---
  export type ChildResult = {
    childID: SessionID
    description: string
    result?: string
    error?: string
    state: "completed" | "error" | "cancelled"
  }

  type ParentState = {
    children: Map<string, { description: string; result?: ChildResult }>
    model: { providerID: string; modelID: string }
    agent: string
    pending: number
  }

  const parents = new Map<string, ParentState>()

  export function registerParent(
    parentID: SessionID,
    children: Array<{ childID: SessionID; description: string }>,
    model: { providerID: string; modelID: string },
    agent: string,
  ) {
    const map = new Map<string, { description: string; result?: ChildResult }>()
    for (const child of children) {
      map.set(child.childID, { description: child.description })
    }
    parents.set(parentID, { children: map, model, agent, pending: children.length })
  }

  export function childCompleted(
    parentID: SessionID,
    childID: SessionID,
    result: ChildResult,
  ): { allDone: boolean; results: ChildResult[] } | undefined {
    const parent = parents.get(parentID)
    if (!parent) return undefined
    const child = parent.children.get(childID)
    if (!child) return undefined
    child.result = result
    parent.pending--
    if (parent.pending <= 0) {
      const results = Array.from(parent.children.values())
        .filter((c) => c.result)
        .map((c) => c.result!)
      parents.delete(parentID)
      return { allDone: true, results }
    }
    return { allDone: false, results: [] }
  }

  export function getParent(parentID: SessionID): ParentState | undefined {
    return parents.get(parentID)
  }

  export function removeParent(parentID: SessionID): string[] {
    const parent = parents.get(parentID)
    if (!parent) return []
    const childIDs = Array.from(parent.children.keys())
    parents.delete(parentID)
    return childIDs
  }

  export function getDetachedChildren(parentID: SessionID): string[] {
    const parent = parents.get(parentID)
    if (!parent) return []
    return Array.from(parent.children.keys())
  }
}
// fork: background-detach (#FORK) — end
