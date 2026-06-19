import type { SessionID } from "./schema"

export type WriterContext = {
  titles: string[]
  revisions: number
}

const store = new Map<SessionID, WriterContext>()

export function getContext(session: SessionID): WriterContext | undefined {
  return store.get(session)
}

export function setContext(session: SessionID, ctx: WriterContext): void {
  store.set(session, ctx)
}

export function clearContext(session: SessionID): void {
  store.delete(session)
}
