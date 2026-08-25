import z from "zod"
import { Tool } from "./tool"
import { PersistentMemory } from "../memory/persistent"
import { Instance } from "../project/instance"

export const MemoryPersistTool = Tool.define("memory_persist", {
  description:
    "Persist a memory across sessions. Memories are repo-scoped by default when called inside a git project; pass global: true to make one visible in every project. Use this to remember user preferences, project facts, or corrections that should survive session restarts.",
  parameters: z.object({
    name: z.string().describe("Short descriptive name for the memory (e.g., 'prefers-effect-ts', 'project-uses-bun')"),
    type: z
      .enum(["user", "project", "feedback"])
      .describe("Memory type: user (preferences), project (codebase facts), feedback (corrections)"),
    content: z.string().describe("The memory content to persist"),
    global: z
      .boolean()
      .optional()
      .describe("Force the memory to be global (visible in every project) instead of scoped to the current repository"),
  }),
  async execute(args) {
    // Non-git projects report worktree "/" - never tag memories with it
    const worktree = Instance.project.worktree
    const project = args.global === true || worktree === "/" ? undefined : worktree
    PersistentMemory.write({
      name: args.name,
      type: args.type,
      content: args.content,
      project,
    })
    return {
      title: `Persisted memory: ${args.name}`,
      output: `Memory "${args.name}" (${args.type}) saved successfully (${project ? `repo-scoped: ${project}` : "global"}). It will be available in future sessions.`,
      metadata: { name: args.name, type: args.type, ...(args.global === true && { global: true }) },
    }
  },
})
