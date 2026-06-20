import { SyncEvent } from "@/sync"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { ulid } from "ulid"

export namespace WorkflowSessionWriter {
  let current: { sessionID: SessionID; messageID: typeof MessageID.Type } | undefined
  let cwd = "."

  export function setCwd(dir: string) {
    cwd = dir
  }

  function createMessage(sessionID: SessionID, agent: string, completed = false) {
    const id = MessageID.ascending()
    const now = Date.now()
    const msg: MessageV2.Assistant = {
      id,
      sessionID,
      role: "assistant",
      time: { created: now, ...(completed && { completed: now }) },
      parentID: MessageID.make("00000000000000000000000000"),
      modelID: ModelID.make("workflow"),
      providerID: ProviderID.make("workflow"),
      mode: "workflow",
      agent,
      path: { cwd, root: cwd },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    SyncEvent.run(MessageV2.Event.Updated, { sessionID, info: msg })
    current = { sessionID, messageID: id }
    return id
  }

  export function writePhase(sessionID: SessionID, phase: string, agent = "build") {
    const msgID = createMessage(sessionID, agent)
    const part: MessageV2.TextPart = {
      id: PartID.ascending(),
      sessionID,
      messageID: msgID,
      type: "text",
      text: `## Phase: ${phase}`,
    }
    SyncEvent.run(MessageV2.Event.PartUpdated, { sessionID, part, time: Date.now() })
  }

  export function appendLog(sessionID: SessionID, level: string, message: string, agent = "build") {
    if (!current || current.sessionID !== sessionID) {
      createMessage(sessionID, agent)
    }
    const part: MessageV2.TextPart = {
      id: PartID.ascending(),
      sessionID,
      messageID: current!.messageID,
      type: "text",
      text: `[${level}] ${message}`,
    }
    SyncEvent.run(MessageV2.Event.PartUpdated, { sessionID, part, time: Date.now() })
  }

  export function writeTool(
    sessionID: SessionID,
    input: {
      tool: string
      args: Record<string, unknown>
      output: string
      title: string
      duration: number
    },
    agent = "build",
  ) {
    if (!current || current.sessionID !== sessionID) {
      createMessage(sessionID, agent)
    }
    const now = Date.now()
    const part: MessageV2.ToolPart = {
      id: PartID.ascending(),
      sessionID,
      messageID: current!.messageID,
      type: "tool",
      callID: ulid(),
      tool: input.tool,
      state: {
        status: "completed",
        input: input.args,
        output: input.output,
        title: input.title,
        metadata: {},
        time: { start: now - input.duration, end: now },
      },
    }
    SyncEvent.run(MessageV2.Event.PartUpdated, { sessionID, part, time: Date.now() })
  }

  export function writeStatus(sessionID: SessionID, status: "completed" | "failed", error?: string, agent = "build") {
    const msgID = createMessage(sessionID, agent, true)
    const text =
      status === "completed" ? "Workflow completed successfully" : `Workflow failed: ${error ?? "unknown error"}`
    const part: MessageV2.TextPart = {
      id: PartID.ascending(),
      sessionID,
      messageID: msgID,
      type: "text",
      text,
    }
    SyncEvent.run(MessageV2.Event.PartUpdated, { sessionID, part, time: Date.now() })
  }

  export function writeAgentRunning(
    sessionID: SessionID,
    input: { childSessionID: string; name: string; prompt: string },
    agent = "build",
  ) {
    if (!current || current.sessionID !== sessionID) {
      createMessage(sessionID, agent)
    }
    const id = PartID.ascending()
    const callId = ulid()
    const part: MessageV2.ToolPart = {
      id,
      sessionID,
      messageID: current!.messageID,
      type: "tool",
      callID: callId,
      tool: "task",
      state: {
        status: "running",
        input: { prompt: input.prompt, description: `workflow:${input.name}`, subagent_type: input.name },
        title: `${input.name} agent`,
        metadata: { sessionId: input.childSessionID, background: false },
        time: { start: Date.now() },
      },
    }
    SyncEvent.run(MessageV2.Event.PartUpdated, { sessionID, part, time: Date.now() })
    return { partID: id, callID: callId }
  }

  export function writeAgentTask(
    sessionID: SessionID,
    input: {
      partID?: typeof PartID.Type
      callID?: string
      childSessionID: string
      name: string
      prompt: string
      output: string
      status: "completed" | "error"
      duration: number
    },
    agent = "build",
  ) {
    if (!current || current.sessionID !== sessionID) {
      createMessage(sessionID, agent)
    }
    const now = Date.now()
    const status = input.status === "completed" ? ("completed" as const) : ("error" as const)
    const part: MessageV2.ToolPart = {
      id: input.partID ?? PartID.ascending(),
      sessionID,
      messageID: current!.messageID,
      type: "tool",
      callID: input.callID ?? ulid(),
      tool: "task",
      state:
        status === "completed"
          ? {
              status,
              input: { prompt: input.prompt, description: `workflow:${input.name}`, subagent_type: input.name },
              output: input.output,
              title: `${input.name} agent`,
              metadata: { sessionId: input.childSessionID, background: false },
              time: { start: now - input.duration, end: now },
            }
          : {
              status,
              input: { prompt: input.prompt, description: `workflow:${input.name}`, subagent_type: input.name },
              error: input.output,
              metadata: { sessionId: input.childSessionID, background: false },
              time: { start: now - input.duration, end: now },
            },
    }
    SyncEvent.run(MessageV2.Event.PartUpdated, { sessionID, part, time: Date.now() })
  }

  export function reset() {
    current = undefined
  }
}
