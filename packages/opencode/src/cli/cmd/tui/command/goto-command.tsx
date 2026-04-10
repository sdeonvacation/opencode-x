import { type CommandOption } from "@tui/component/dialog-command"
import { type DialogContext } from "@tui/ui/dialog"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { type ToastContext } from "@tui/ui/toast"
import { Filesystem } from "@/util/filesystem"

export type GotoCommandDeps = {
  dialog: Pick<DialogContext, "clear" | "replace">
  sdk: {
    directory?: string
    changeDirectory: (path: string) => Promise<void>
  }
  toast: Pick<ToastContext, "show">
  sync: {
    data: {
      path: {
        directory?: string
      }
    }
  }
}

export function createGotoCommand(deps: GotoCommandDeps): CommandOption {
  return {
    title: "Change directory",
    value: "app.goto",
    slash: {
      name: "goto",
      aliases: ["cd"],
    },
    onSelect: async () => {
      const path = await DialogPrompt.show(deps.dialog, "Change directory", {
        placeholder: "Enter path...",
        value: deps.sync.data.path.directory || process.cwd(),
      })
      deps.dialog.clear()
      if (!path) return

      const resolved = path.startsWith("~") ? path.replace("~", process.env.HOME || "") : path
      const valid = await Filesystem.isDir(resolved)

      if (!valid) {
        deps.toast.show({
          variant: "error",
          message: `Invalid directory: ${path}`,
        })
        return
      }

      try {
        await deps.sdk.changeDirectory(resolved)
        deps.toast.show({
          variant: "info",
          message: `Changed to ${path}`,
        })
      } catch (e) {
        deps.toast.show({
          variant: "error",
          message: `Failed: ${e instanceof Error ? e.message : e}`,
        })
      }
    },
    category: "System",
  }
}
