import z from "zod"

export type WorkflowRunID = string & { readonly __tag: "WorkflowRunID" }
export const WorkflowRunID = {
  generate: (): WorkflowRunID => `wfrun_${crypto.randomUUID()}` as WorkflowRunID,
  make: (id: string): WorkflowRunID => id as WorkflowRunID,
  zod: z
    .string()
    .startsWith("wfrun_")
    .transform((s) => s as WorkflowRunID),
}
