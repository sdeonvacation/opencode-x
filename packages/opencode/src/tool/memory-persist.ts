import z from "zod"
import { Tool } from "./tool"
import { PersistentMemory } from "../memory/persistent"

export const MemoryPersistTool = Tool.define("memory_persist", {
  description:
    "Persist a memory across sessions. Use this to remember user preferences, project facts, or corrections that should survive session restarts.",
  parameters: z.object({
    name: z.string().describe("Short descriptive name for the memory (e.g., 'prefers-effect-ts', 'project-uses-bun')"),
    type: z
      .enum(["user", "project", "feedback"])
      .describe("Memory type: user (preferences), project (codebase facts), feedback (corrections)"),
    content: z.string().describe("The memory content to persist"),
  }),
  async execute(args) {
    PersistentMemory.write({
      name: args.name,
      type: args.type,
      content: args.content,
    })
    return {
      title: `Persisted memory: ${args.name}`,
      output: `Memory "${args.name}" (${args.type}) saved successfully. It will be available in future sessions.`,
      metadata: { name: args.name, type: args.type },
    }
  },
})
