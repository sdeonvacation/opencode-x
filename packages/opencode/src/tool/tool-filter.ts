import { ProviderID, type ModelID } from "../provider/schema"
import { Flag } from "../flag/flag"
import { Env } from "../env"
import { WebSearchTool } from "./websearch"
import { ApplyPatchTool } from "./apply_patch"
import { EditTool } from "./edit"
import { WriteTool } from "./write"
import type { Tool } from "./tool"
import { LOCAL_ONLY_TOOLS, type Route } from "@/session/route-classifier"
import type { Tool as ModelTool } from "ai"

export type ToolFilterInput = {
  providerID: ProviderID
  modelID: ModelID
}

/**
 * Filter a flat list of Tool.Info entries according to provider/model/feature-flag rules:
 *
 * - WebSearch is only included for the `opencode` provider or when
 *   the `OPENCODE_ENABLE_EXA` flag is set.
 * - ApplyPatch replaces Edit/Write for GPT-4.1-class models (non-oss, non-gpt-4) and
 *   when the `OPENCODE_E2E_LLM_URL` env var is set.
 */
export function filterTools(tools: Tool.Info[], input: ToolFilterInput): Tool.Info[] {
  const modelID = String(input.modelID)
  const usePatch =
    !!Env.get("OPENCODE_E2E_LLM_URL") || (modelID.includes("gpt-") && !modelID.includes("oss") && modelID !== "gpt-4")

  return tools.filter((tool) => {
    if (tool.id === WebSearchTool.id) {
      return input.providerID === ProviderID.opencode || Flag.OPENCODE_ENABLE_EXA
    }
    if (tool.id === ApplyPatchTool.id) return usePatch
    if (tool.id === EditTool.id || tool.id === WriteTool.id) return !usePatch
    return true
  })
}

export function filterForRoute(tools: Tool.Info[], route: Route): Tool.Info[]
export function filterForRoute<T extends ModelTool>(tools: Record<string, T>, route: Route): Record<string, T>
export function filterForRoute<T extends ModelTool>(tools: Tool.Info[] | Record<string, T>, route: Route) {
  if (route === "cloud") return tools
  // Local route no longer filters tools (local model doesn't get tools)
  return Array.isArray(tools) ? [] : ({} as Record<string, T>)
}
