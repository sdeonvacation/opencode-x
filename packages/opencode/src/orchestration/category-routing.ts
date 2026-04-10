export type ModelRef = {
  providerID: string
  modelID: string
}

export function resolve(opts: {
  category?: string
  categories: Record<string, ModelRef>
  fallback: ModelRef
}): ModelRef {
  if (!opts.category) return opts.fallback
  return opts.categories[opts.category] ?? opts.fallback
}
