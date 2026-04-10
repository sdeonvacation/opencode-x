import { resolve as resolveCategory, type ModelRef } from "./category-routing"
import { detect as detectUltrawork } from "./ultrawork"
import { resolveModel as resolveUltrawork } from "./ultrawork-hook"

export type { ModelRef }

export type ResolveTaskModelInput = {
  prompt: string
  subagentType: string
  taskCategory?: string
  useUltrawork?: boolean
  categories: Record<string, ModelRef>
  ultraworkModel?: ModelRef
  fallback: ModelRef
}

/**
 * Compose the final model reference for a task invocation.
 *
 * Resolution order (highest priority first):
 * 1. Ultrawork keyword detected in prompt (`ulw` / `ultrawork`)
 * 2. Explicit `use_ultrawork: true` flag
 * 3. Category routing (`task_category` → `subagent_type` → fallback)
 *
 * Always returns a valid `ModelRef` — falls back to `input.fallback` when
 * no overrides apply.
 */
export function resolveTaskModel(input: ResolveTaskModelInput): ModelRef {
  const categoryModel = resolveCategory({
    category: input.taskCategory ?? input.subagentType,
    categories: input.categories,
    fallback: input.fallback,
  })

  const ultraworkModel =
    detectUltrawork(input.prompt, input.ultraworkModel) ??
    resolveUltrawork({
      enabled: input.useUltrawork === true,
      ultraworkModel: input.ultraworkModel,
    })

  return ultraworkModel ?? categoryModel
}
