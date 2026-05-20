import { type CommandOption } from "@tui/component/dialog-command"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { type DialogContext } from "@tui/ui/dialog"
import { type ToastContext } from "@tui/ui/toast"

export type GoalCommandDeps = {
  dialog: Pick<DialogContext, "clear" | "replace">
  sdk: {
    client: {
      session: {
        goal: (input: { sessionID: string; objective?: string; tokenBudget?: number }) => Promise<unknown>
      }
    }
  }
  toast: Pick<ToastContext, "show">
  route: {
    data: { type: string; sessionID?: string }
  }
}

export function createGoalCommand(deps: GoalCommandDeps): CommandOption {
  return {
    title: "Set goal",
    value: "session.goal",
    category: "Session",
    slash: {
      name: "goal",
    },
    onSelect: async () => {
      const session = deps.route.data
      if (session.type !== "session" || !session.sessionID) {
        deps.toast.show({ message: "No active session", variant: "warning" })
        deps.dialog.clear()
        return
      }
      const id = session.sessionID

      const objective = await DialogPrompt.show(deps.dialog, "Set goal", {
        placeholder: "Describe the objective...",
      })
      if (!objective?.trim()) {
        deps.dialog.clear()
        return
      }

      const raw = await DialogPrompt.show(deps.dialog, "Token budget (optional)", {
        placeholder: "e.g. 100000 (press enter to skip)",
      })
      deps.dialog.clear()

      const budget = raw?.trim() ? parseInt(raw.trim(), 10) : undefined
      const token = budget && !isNaN(budget) ? budget : undefined

      deps.sdk.client.session.goal({ sessionID: id, objective: objective.trim(), tokenBudget: token }).catch(() => {
        deps.toast.show({ message: "Failed to set goal", variant: "error" })
      })
      deps.toast.show({ message: "Goal set", variant: "success" })
    },
  }
}
