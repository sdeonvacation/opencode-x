import { type CommandOption } from "@tui/component/dialog-command"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { type DialogContext } from "@tui/ui/dialog"
import { type ToastContext } from "@tui/ui/toast"

export type ResearchCommandDeps = {
  dialog: Pick<DialogContext, "clear" | "replace">
  toast: Pick<ToastContext, "show">
  route: { data: { type: string; sessionID?: string } }
  sdk: {
    client: {
      session: {
        complete: (input: { sessionID: string; parts: { type: "text"; text: string }[] }) => Promise<unknown>
      }
    }
  }
}

export function createResearchCommand(deps: ResearchCommandDeps): CommandOption {
  return {
    title: "Deep research",
    value: "session.research",
    category: "Session",
    slash: {
      name: "research",
    },
    onSelect: async () => {
      const session = deps.route.data
      if (session.type !== "session" || !session.sessionID) {
        deps.toast.show({ message: "No active session", variant: "warning" })
        deps.dialog.clear()
        return
      }

      const question = await DialogPrompt.show(deps.dialog, "Research question", {
        placeholder: "What do you want to research?",
      })
      if (!question?.trim()) {
        deps.dialog.clear()
        return
      }

      deps.dialog.clear()
      deps.sdk.client.session
        .complete({
          sessionID: session.sessionID,
          parts: [{ type: "text", text: `Use the research tool to investigate: ${question.trim()}` }],
        })
        .catch(() => {
          deps.toast.show({ message: "Failed to start research", variant: "error" })
        })
    },
  }
}
