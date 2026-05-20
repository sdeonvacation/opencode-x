import type { Goal } from "./goal"

const MAX_TURNS = 200

export namespace GoalLoop {
  export function shouldContinue(input: { goal: Goal.Info | null; step: number }): boolean {
    if (!input.goal) return false
    if (input.goal.status !== "active") return false
    if (input.goal.turns_used >= MAX_TURNS) return false
    if (input.goal.token_budget && input.goal.tokens_used >= input.goal.token_budget) return false
    return true
  }

  export function continuation(goal: Goal.Info): string {
    return `Continue working on the goal: "${goal.objective}". You have used ${goal.turns_used}/${MAX_TURNS} turns. When complete, call goal_complete with evidence.`
  }
}
