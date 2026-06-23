import { type CommandOption } from "@tui/component/dialog-command"
import { type KVContext } from "@tui/context/kv"
import { type ToastContext } from "@tui/ui/toast"

type Message = {
  info: {
    id: string
    role: string
    cost?: number
    summary?: unknown
    error?: unknown
  }
}

export type ClearCommandsDeps = {
  sdk: {
    client: {
      session: {
        messages: (input: { sessionID: string }) => Promise<{ data?: Array<{ info: Message["info"] }> }>
        deleteMessage: (input: { sessionID: string; messageID: string }) => Promise<unknown>
        clearTodo: (input: { sessionID: string }) => Promise<unknown>
        delete: (input: { sessionID: string }) => Promise<unknown>
        children: (input: { sessionID: string }) => Promise<{ data?: Array<{ id: string }> }>
      }
    }
  }
  sync: {
    session: {
      sync: (sessionID: string, input: { force: boolean }) => Promise<unknown>
    }
  }
  kv: Pick<KVContext, "get" | "set">
  toast: Pick<ToastContext, "show">
  route: {
    data: { type: "session"; sessionID: string } | { type: string; sessionID?: string }
  }
}

export function createClearCommands(deps: ClearCommandsDeps): CommandOption[] {
  return [
    {
      title: "Clear conversation",
      value: "session.clear",
      category: "Session",
      slash: {
        name: "clear",
      },
      onSelect: async () => {
        const sessionID = deps.route.data.type === "session" ? deps.route.data.sessionID : undefined
        if (!sessionID) return

        try {
          const response = await deps.sdk.client.session.messages({ sessionID })
          const messages = response.data || []

          if (messages.length === 0) {
            deps.toast.show({
              variant: "info",
              message: "No messages to clear",
            })
            return
          }

          const currentCost = messages.reduce(
            (sum, msg) => sum + (msg.info.role === "assistant" ? (msg.info.cost ?? 0) : 0),
            0,
          )
          const existingClearedCost = deps.kv.get<number>(`cleared_cost_${sessionID}`, 0)
          deps.kv.set(`cleared_cost_${sessionID}`, existingClearedCost + currentCost)

          for (const msg of messages) {
            await deps.sdk.client.session.deleteMessage({
              sessionID,
              messageID: msg.info.id,
            })
          }

          const kidsResponse = await deps.sdk.client.session.children({ sessionID })
          for (const kid of kidsResponse.data ?? []) {
            await deps.sdk.client.session.delete({ sessionID: kid.id })
          }

          await deps.sdk.client.session.clearTodo({ sessionID })
          await deps.sync.session.sync(sessionID, { force: true })

          deps.toast.show({
            variant: "info",
            message: `Cleared ${messages.length} message(s)`,
          })
        } catch (error) {
          deps.toast.show({
            variant: "error",
            message: `Failed to clear conversation: ${error instanceof Error ? error.message : String(error)}`,
          })
        }
      },
    },
  ]
}
