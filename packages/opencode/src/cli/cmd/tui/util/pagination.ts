export type PaginationState = {
  cursor: string | null
  loading: boolean
  more: boolean
}

const initial: PaginationState = { cursor: null, loading: false, more: false }

export function Pagination() {
  const map = new Map<string, PaginationState>()

  return {
    get(id: string): PaginationState {
      return map.get(id) ?? initial
    },
    set(id: string, state: Partial<PaginationState>) {
      const prev = map.get(id) ?? { ...initial }
      map.set(id, { ...prev, ...state })
    },
    delete(id: string) {
      map.delete(id)
    },
    clear() {
      map.clear()
    },
  }
}

export type PaginationType = ReturnType<typeof Pagination>
