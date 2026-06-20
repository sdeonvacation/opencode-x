import type { TaskExecutor, ExecuteInput, ExecuteResult } from "../executor"
import { SessionPrompt } from "../../session/prompt"
import { withTimeout } from "@/util/timeout"
import { extractResultText } from "../result"

export class ForegroundExecutor implements TaskExecutor {
  async execute(input: ExecuteInput): Promise<ExecuteResult> {
    const timeout = input.timeout
    const result = await withTimeout(
      SessionPrompt.prompt({
        messageID: input.messageID,
        sessionID: input.sessionID,
        model: input.model,
        variant: input.variant,
        agent: input.agent,
        tools: input.tools,
        parts: input.parts,
      }),
      timeout,
    ).catch((err) => {
      if (err instanceof Error && err.message.includes("Operation timed out")) {
        SessionPrompt.cancel(input.sessionID)
        throw new Error(`Subagent timed out after ${timeout}ms`)
      }
      throw err
    })
    return { tag: "foreground", text: extractResultText(result.parts), sessionID: input.sessionID }
  }
}
