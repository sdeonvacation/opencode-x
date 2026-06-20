import type { SessionID, MessageID } from "../session/schema"
import type { ModelID, ProviderID } from "../provider/schema"
import type { SessionPrompt } from "../session/prompt"

export type ExecutionMode = "foreground" | "background"

export type ExecuteInput = {
  sessionID: SessionID
  messageID: MessageID
  model: { modelID: ModelID; providerID: ProviderID }
  variant?: string
  agent: string
  tools: Record<string, boolean>
  parts: SessionPrompt.PromptInput["parts"]
  timeout: number
  concurrency: { key: string; limit: number }
  guard: { sessionID: string; threshold: number }
  abort?: AbortSignal
  isolation?: boolean
  metadata: {
    parentSessionID: SessionID
    description: string
    agentName: string
  }
}

export type ExecuteResult =
  | { tag: "foreground"; text: string; sessionID: SessionID }
  | { tag: "background"; sessionID: SessionID }
  | { tag: "background_update"; sessionID: SessionID }

export interface TaskExecutor {
  execute(input: ExecuteInput): Promise<ExecuteResult>
}
