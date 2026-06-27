import { DEFAULT_MODEL } from "./types"
import type { InsightsModel } from "./types"

export function parseModel(str?: string): InsightsModel {
  if (!str || str.trim().length === 0) return DEFAULT_MODEL
  const trimmed = str.trim()
  const slash = trimmed.indexOf("/")
  if (slash === -1) return { providerID: "anthropic", modelID: trimmed }
  return {
    providerID: trimmed.slice(0, slash),
    modelID: trimmed.slice(slash + 1),
  }
}

export function dateStamp(): string {
  return new Date().toISOString().slice(0, 10)
}
