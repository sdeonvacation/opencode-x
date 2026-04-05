import type { ModelRef } from "./category-routing"

export function resolveModel(opts: { enabled?: boolean; ultraworkModel?: ModelRef }): ModelRef | null {
  if (opts.enabled !== true) return null
  if (!opts.ultraworkModel) return null
  return opts.ultraworkModel
}
