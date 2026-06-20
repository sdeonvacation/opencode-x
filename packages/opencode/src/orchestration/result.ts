import type { MessageV2 } from "../session/message-v2"
import type { IsolationResult } from "./isolation"

export function extractResultText(parts: MessageV2.WithParts["parts"]): string {
  return parts.findLast((item) => item.type === "text")?.text ?? ""
}

export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function formatIsolation(result: IsolationResult): string {
  if (result.patch.status === "applied") return result.output + "\n\n[ISOLATION] Changes applied to parent worktree."
  if (result.patch.status === "conflict")
    return result.output + `\n\n[ISOLATION] Patch conflict on branch ${result.patch.branch}: ${result.patch.message}`
  return result.output
}
