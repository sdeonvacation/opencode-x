import z from "zod"
import { Tool } from "./tool"
import { Goal } from "../goal/goal"
import { GoalID } from "../goal/schema"

export const GoalCompleteTool = Tool.define("goal_complete", {
  description:
    "Mark the current goal as complete. Call this when you have fully achieved the objective. Provide evidence of completion.",
  parameters: z.object({
    evidence: z.string().describe("Evidence that the goal has been achieved (what was done, verification results)"),
  }),
  async execute(args, ctx) {
    const goal = Goal.get(ctx.sessionID)
    if (!goal) {
      return {
        title: "No active goal",
        output: "Error: No active goal found for this session.",
        metadata: {} as Record<string, string>,
      }
    }
    Goal.complete({ id: GoalID.make(goal.id), evidence: args.evidence })
    return {
      title: `Goal completed: ${goal.objective}`,
      output: `Goal "${goal.objective}" marked as complete.\nEvidence: ${args.evidence}`,
      metadata: {} as Record<string, string>,
    }
  },
})
