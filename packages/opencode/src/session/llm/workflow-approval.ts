import type { Tool } from "ai"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { Instance } from "@/project/instance"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { Bus } from "@/bus"
import { Wildcard } from "@/util/wildcard"
import { SessionID } from "@/session/schema"
import type { ModelMessage } from "ai"

export namespace WorkflowApproval {
  // Wire up toolExecutor + approvalHandler for DWS workflow models so that tool calls
  // from the workflow service are executed via opencode's tool system
  // and results sent back over the WebSocket. Keeps fork-local hybrid-routing v4 behavior
  // identical while isolating the surface area from upstream session/llm/* refactors.
  export function wire(input: {
    language: any
    sessionID: string
    system: string[]
    messages: ModelMessage[]
    tools: Record<string, Tool>
    abort?: AbortSignal
    agentPermission?: Permission.Ruleset
    sessionPermission?: Permission.Ruleset
  }) {
    if (!(input.language instanceof GitLabWorkflowLanguageModel)) return
    const workflowModel = input.language as GitLabWorkflowLanguageModel & {
      sessionID?: string
      sessionPreapprovedTools?: string[]
      approvalHandler?: (approvalTools: { name: string; args: string }[]) => Promise<{ approved: boolean }>
    }
    workflowModel.sessionID = input.sessionID
    workflowModel.systemPrompt = input.system.join("\n")
    workflowModel.toolExecutor = async (toolName, argsJson, _requestID) => {
      const t = input.tools[toolName]
      if (!t || !t.execute) {
        return { result: "", error: `Unknown tool: ${toolName}` }
      }
      try {
        const result = await t.execute!(JSON.parse(argsJson), {
          toolCallId: _requestID,
          messages: input.messages,
          abortSignal: input.abort,
        })
        const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
        return {
          result: output,
          metadata: typeof result === "object" ? result?.metadata : undefined,
          title: typeof result === "object" ? result?.title : undefined,
        }
      } catch (e: any) {
        return { result: "", error: e.message ?? String(e) }
      }
    }

    const ruleset = Permission.effective(input.agentPermission ?? [], input.sessionPermission ?? [])
    workflowModel.sessionPreapprovedTools = Object.keys(input.tools).filter((name) => {
      const match = ruleset.findLast((rule) => Wildcard.match(name, rule.permission))
      return !match || match.action !== "ask"
    })

    const approvedToolsForSession = new Set<string>()
    workflowModel.approvalHandler = Instance.bind(async (approvalTools) => {
      const uniqueNames = [...new Set(approvalTools.map((t: { name: string }) => t.name))] as string[]
      // Auto-approve tools that were already approved in this session
      // (prevents infinite approval loops for server-side MCP tools)
      if (uniqueNames.every((name) => approvedToolsForSession.has(name))) {
        return { approved: true }
      }

      const id = PermissionID.ascending()
      let reply: Permission.Reply | undefined
      let unsub: (() => void) | undefined
      try {
        unsub = Bus.subscribe(Permission.Event.Replied, (evt) => {
          if (evt.properties.requestID === id) reply = evt.properties.reply
        })
        const toolPatterns = approvalTools.map((t: { name: string; args: string }) => {
          try {
            const parsed = JSON.parse(t.args) as Record<string, unknown>
            const title = (parsed?.title ?? parsed?.name ?? "") as string
            return title ? `${t.name}: ${title}` : t.name
          } catch {
            return t.name
          }
        })
        const uniquePatterns = [...new Set(toolPatterns)] as string[]
        await Permission.ask({
          id,
          sessionID: SessionID.make(input.sessionID),
          permission: "workflow_tool_approval",
          patterns: uniquePatterns,
          metadata: { tools: approvalTools },
          always: uniquePatterns,
          ruleset,
        })
        for (const name of uniqueNames) approvedToolsForSession.add(name)
        workflowModel.sessionPreapprovedTools = [...(workflowModel.sessionPreapprovedTools ?? []), ...uniqueNames]
        return { approved: true }
      } catch {
        return { approved: false }
      } finally {
        unsub?.()
      }
    })
  }
}
