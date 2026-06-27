import { type CommandOption } from "@tui/component/dialog-command"
import { type DialogContext } from "@tui/ui/dialog"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { type ToastContext } from "@tui/ui/toast"

export type InsightsCommandDeps = {
  sdk: { url: string; fetch: typeof fetch }
  toast: Pick<ToastContext, "show">
  dialog: Pick<DialogContext, "clear" | "replace">
}

export function createInsightsCommand(deps: InsightsCommandDeps): CommandOption {
  return {
    title: "View insights in a browser, default: 7 days",
    value: "insights.generate",
    slash: { name: "insights" },
    category: "Tools",
    onSelect: async () => {
      const raw = await DialogPrompt.show(deps.dialog, "Days of history to analyze", {
        placeholder: "7 (press enter for default)",
      })

      const days = raw?.trim() ? parseInt(raw.trim(), 10) : undefined
      const parsedDays = days && !isNaN(days) && days > 0 && days <= 365 ? days : undefined

      deps.dialog.clear()
      deps.toast.show({
        variant: "info",
        message: "Generating insights report, will take a few mins...",
        duration: 5000,
      })

      try {
        const res = await deps.sdk.fetch(`${deps.sdk.url}/insights`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ days: parsedDays }),
        })
        if (!res.ok) {
          const body = await res.text().catch(() => "")
          throw new Error(body || `Failed: ${res.status}`)
        }
        const result = (await res.json()) as {
          reportPath: string
          sessionCount: number
          analyzedCount: number
          totalCost: number
        }
        deps.toast.show({
          variant: "success",
          message: `Report generated (${result.sessionCount} sessions, $${result.totalCost.toFixed(2)}). Opening...`,
          duration: 5000,
        })
      } catch (e: any) {
        deps.toast.show({ variant: "error", message: e.message || "Insights generation failed", duration: 5000 })
      }
    },
  }
}
