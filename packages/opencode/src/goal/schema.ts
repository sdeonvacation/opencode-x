import z from "zod"

export type GoalID = string & { readonly __tag: "GoalID" }
export const GoalID = {
  generate: (): GoalID => `goal_${crypto.randomUUID()}` as GoalID,
  make: (id: string): GoalID => id as GoalID,
  zod: z
    .string()
    .startsWith("goal_")
    .transform((s) => s as GoalID),
}
