export const Tunables = {
  JURY_SIZE: 3,
  REJECT_QUORUM: 2,
  SOURCE_BUDGET: 15,
  FACT_CAP: 25,
  PHASE_TIMEOUT_MS: 60_000,
  MAX_QUERIES: 6,
} as const

export type Resolved = {
  JURY_SIZE: number
  REJECT_QUORUM: number
  SOURCE_BUDGET: number
  FACT_CAP: number
  PHASE_TIMEOUT_MS: number
  MAX_QUERIES: number
}

export function resolve(overrides?: Partial<Resolved>): Resolved {
  if (!overrides) return { ...Tunables }
  return {
    JURY_SIZE: overrides.JURY_SIZE ?? Tunables.JURY_SIZE,
    REJECT_QUORUM: overrides.REJECT_QUORUM ?? Tunables.REJECT_QUORUM,
    SOURCE_BUDGET: overrides.SOURCE_BUDGET ?? Tunables.SOURCE_BUDGET,
    FACT_CAP: overrides.FACT_CAP ?? Tunables.FACT_CAP,
    PHASE_TIMEOUT_MS: overrides.PHASE_TIMEOUT_MS ?? Tunables.PHASE_TIMEOUT_MS,
    MAX_QUERIES: overrides.MAX_QUERIES ?? Tunables.MAX_QUERIES,
  }
}
