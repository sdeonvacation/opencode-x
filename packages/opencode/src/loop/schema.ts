import z from "zod"

export type LoopID = string & { readonly __tag: "LoopID" }
export const LoopID = {
  generate: (): LoopID => `loop_${crypto.randomUUID()}` as LoopID,
  make: (id: string): LoopID => id as LoopID,
  zod: z
    .string()
    .startsWith("loop_")
    .transform((s) => s as LoopID),
}
