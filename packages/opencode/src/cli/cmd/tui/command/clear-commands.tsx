import { type CommandOption } from "@tui/component/dialog-command"
import { type KVContext } from "@tui/context/kv"
import { type ToastContext } from "@tui/ui/toast"

type Message = {
  info: {
    id: string
    role: string
    cost?: number
    summary?: unknown
  }
}

export type ClearCommandsDeps = {
  sdk: {
    client: {
      session: {
        messages: (input: { sessionID: string }) => Promise<{ data?: Array<{ info: Message["info"] }> }>
        deleteMessage: (input: { sessionID: string; messageID: string }) => Promise<unknown>
        summarize: (input: {
          sessionID: string
          providerID: string
          modelID: string
          auto: boolean
        }) => Promise<unknown>
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
  local: {
    model: {
      current: () => { providerID: string; modelID: string } | undefined
    }
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
    {
      title: "Compact and clear conversation",
      value: "session.compact_clear",
      category: "Session",
      slash: {
        name: "clear-compact",
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
              message: "No messages to compact",
            })
            return
          }

          deps.toast.show({
            variant: "info",
            message: "Creating summary...",
            duration: 8000,
          })

          const currentModel = deps.local.model.current()
          if (!currentModel) {
            deps.toast.show({
              variant: "error",
              message: "No model selected. Please select a model first.",
            })
            return
          }

          await deps.sdk.client.session.summarize({
            sessionID,
            providerID: currentModel.providerID,
            modelID: currentModel.modelID,
            auto: false,
          })

          const updatedResponse = await deps.sdk.client.session.messages({ sessionID })
          const updatedMessages = updatedResponse.data || []
          const summaryMessage = updatedMessages.findLast((m) => m.info.role === "assistant" && Boolean(m.info.summary))

          if (!summaryMessage) {
            deps.toast.show({
              variant: "error",
              message: "Failed to create summary. Use /clear instead.",
            })
            return
          }

          let deletedCount = 0
          let deletedCost = 0
          for (const msg of messages) {
            if (msg.info.id === summaryMessage.info.id) continue
            if (msg.info.role === "assistant") {
              deletedCost += msg.info.cost ?? 0
            }
            await deps.sdk.client.session.deleteMessage({
              sessionID,
              messageID: msg.info.id,
            })
            deletedCount++
          }

          const existingClearedCost = deps.kv.get<number>(`cleared_cost_${sessionID}`, 0)
          deps.kv.set(`cleared_cost_${sessionID}`, existingClearedCost + deletedCost)

          await deps.sync.session.sync(sessionID, { force: true })

          deps.toast.show({
            variant: "info",
            message: `Compacted: created summary and cleared ${deletedCount} message(s)`,
          })
        } catch (error) {
          deps.toast.show({
            variant: "error",
            message: `Failed to compact: ${error instanceof Error ? error.message : String(error)}`,
          })
        }
      },
    },
  ]
}
