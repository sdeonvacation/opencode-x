import z from "zod"
import { Effect } from "effect"
import { MessageV2 } from "./message-v2"
import { Provider } from "../provider/provider"
import { Agent } from "../agent/agent"
import { MCP } from "../mcp"
import { Skill } from "../skill"
import { PersistentMemory } from "../memory/persistent"
import { Goal } from "../goal/goal"
import { HookContext } from "."
import { SystemPrompt } from "./system"
import { Instruction } from "./instruction"
import { ToolRegistry } from "../tool/registry"
import { CacheDebugLog } from "./cache-debug-log"
import { makeRuntime } from "@/effect/run-service"
import type { SessionID } from "./schema"

const { runPromise } = makeRuntime(Instruction.Service, Instruction.defaultLayer)

export namespace ContextUsage {
  function estimate(text: string): number {
    return Math.ceil(text.length / 4)
  }

  export const CategoryItem = z.object({
    name: z.string(),
    tokens: z.number(),
    source: z.string().optional(),
  })
  export type CategoryItem = z.infer<typeof CategoryItem>

  export const Category = z.object({
    name: z.string(),
    tokens: z.number(),
    items: z.array(CategoryItem).optional(),
  })
  export type Category = z.infer<typeof Category>

  export const Info = z.object({
    model: z.object({
      providerID: z.string(),
      modelID: z.string(),
      name: z.string(),
      contextLimit: z.number(),
    }),
    total: z.number(),
    free: z.number(),
    categories: z.array(Category),
  })
  export type Info = z.infer<typeof Info>

  async function resolveModel(sessionID: SessionID) {
    for (const item of MessageV2.stream(sessionID)) {
      if (item.info.role === "user" && item.info.model) return item.info.model
    }
    return Provider.defaultModel()
  }

  function makeCategory(name: string, items: CategoryItem[]): Category {
    const sorted = items.toSorted((a, b) => b.tokens - a.tokens)
    return {
      name,
      tokens: sorted.reduce((sum, i) => sum + i.tokens, 0),
      items: sorted.length > 0 ? sorted : undefined,
    }
  }

  export async function forSession(sessionID: SessionID): Promise<Info> {
    const ref = await resolveModel(sessionID)
    const model = await Provider.getModel(ref.providerID, ref.modelID)
    const agent = await Agent.get("build")

    const [env, instructionTexts, tools, mcpTools, agents, skillsText, msgs, memText, goal] = await Promise.all([
      SystemPrompt.environment(model),
      runPromise((svc) => svc.system()),
      ToolRegistry.tools({ providerID: ref.providerID, modelID: ref.modelID, agent }),
      MCP.tools(),
      Agent.list(),
      SystemPrompt.skills(agent),
      Promise.resolve(MessageV2.filterCompacted(MessageV2.stream(sessionID))),
      Promise.resolve(PersistentMemory.inject()),
      Promise.resolve(Goal.get(sessionID)),
    ])

    const categories: Category[] = []

    // System prompt
    const sysItems: CategoryItem[] = []
    const providerPrompt = SystemPrompt.provider(model)
    if (providerPrompt.length > 0) {
      sysItems.push({ name: "provider_prompt", tokens: estimate(providerPrompt.join("\n")) })
    }
    if (env.length > 0) {
      sysItems.push({ name: "environment", tokens: estimate(env.join("\n")) })
    }
    categories.push(makeCategory("system_prompt", sysItems))

    // Instructions
    const instrItems: CategoryItem[] = instructionTexts.map((text) => {
      const match = text.match(/^Instructions from: (.+)\n/)
      return { name: match?.[1] ?? "instruction", tokens: estimate(text) }
    })
    categories.push(makeCategory("instructions", instrItems))

    // Built-in tools
    const toolItems: CategoryItem[] = tools.map((t) => {
      const schema = JSON.stringify(z.toJSONSchema(t.parameters))
      return { name: t.id, tokens: estimate(t.description + schema) }
    })
    categories.push(makeCategory("tools", toolItems))

    // MCP tools (grouped by server)
    const mcpItems: CategoryItem[] = Object.entries(mcpTools).map(([key, tool]) => {
      const desc = (tool as any).description ?? ""
      const schema = (tool as any).inputSchema ? JSON.stringify((tool as any).inputSchema) : ""
      // mcp tool keys: mcp__servername__toolname — extract server
      const parts = key.split("__")
      const server = parts.length >= 2 ? parts[1] : undefined
      return { name: key, tokens: estimate(desc + schema), source: server }
    })
    categories.push(makeCategory("mcp_tools", mcpItems))

    // Agents: only the active agent's prompt is in context; others are just task tool routing targets
    const agentItems: CategoryItem[] = agents
      .filter((a) => a.prompt && a.name === agent.name)
      .map((a) => ({ name: a.name, tokens: estimate(a.prompt!) }))
    categories.push(makeCategory("agents", agentItems))

    // Persistent memory
    const memItems: CategoryItem[] = memText ? [{ name: "persistent_memory", tokens: estimate(memText) }] : []
    categories.push(makeCategory("memory", memItems))

    // Skills
    if (skillsText) {
      const activated = await Skill.activated(agent)
      const skillItems: CategoryItem[] = activated.map((s) => ({
        name: s.name,
        // per-skill metadata cost actually in context (matches verbose fmt lines), NOT full SKILL.md body
        tokens: estimate(Skill.fmt([s], { verbose: true })),
      }))
      categories.push({
        name: "skills",
        tokens: estimate(skillsText),
        items: skillItems.length > 0 ? skillItems.toSorted((a, b) => b.tokens - a.tokens) : undefined,
      })
    } else {
      categories.push(makeCategory("skills", []))
    }

    // Messages
    const msgTokens = CacheDebugLog.cheapTokenEstimate(msgs)
    categories.push(makeCategory("messages", [{ name: "conversation", tokens: msgTokens }]))

    // Goal (conditional)
    if (goal) {
      const text = Goal.addendum(goal)
      categories.push(makeCategory("goal", [{ name: goal.objective.slice(0, 60), tokens: estimate(text) }]))
    }

    // Hooks (conditional)
    const hookItems: CategoryItem[] = []
    const hookSession = HookContext.getSession(sessionID)
    if (hookSession) hookItems.push({ name: "session_hook", tokens: estimate(hookSession) })
    const hookTurn = HookContext.getTurn(sessionID)
    if (hookTurn) hookItems.push({ name: "turn_hook", tokens: estimate(hookTurn) })
    if (hookItems.length > 0) categories.push(makeCategory("hooks", hookItems))

    const total = categories.reduce((sum, c) => sum + c.tokens, 0)
    const contextLimit = model.limit.context
    const free = Math.max(0, contextLimit - total)

    return {
      model: {
        providerID: ref.providerID,
        modelID: ref.modelID,
        name: model.api.id,
        contextLimit,
      },
      total,
      free,
      categories,
    }
  }

  export const get = (sessionID: SessionID) => Effect.promise(() => forSession(sessionID))
}
