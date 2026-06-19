import { type CommandOption } from "@tui/component/dialog-command"
import { type DialogContext } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { type ToastContext } from "@tui/ui/toast"

export type WorktreeCommandDeps = {
  dialog: Pick<DialogContext, "clear" | "replace">
  sdk: {
    client: {
      worktree: {
        list: () => Promise<{ data?: string[] }>
        remove: (input?: { worktreeRemoveInput?: { directory: string } }) => Promise<{ data?: boolean }>
      }
    }
  }
  toast: Pick<ToastContext, "show">
}

export function createWorktreeCommand(deps: WorktreeCommandDeps): CommandOption {
  return {
    title: "Worktree",
    value: "worktree.manage",
    slash: {
      name: "worktree",
      aliases: ["wt"],
    },
    category: "System",
    onSelect: async () => {
      deps.dialog.replace(() => (
        <DialogSelect
          title="Worktree"
          options={[
            { title: "List", value: "list" },
            { title: "Remove", value: "remove" },
          ]}
          onSelect={async (option) => {
            if (option.value === "list") return list()
            if (option.value === "remove") return remove()
          }}
        />
      ))
    },
  }

  async function list() {
    try {
      const result = await deps.sdk.client.worktree.list()
      const entries = result.data
      if (!entries || entries.length === 0) {
        deps.toast.show({ variant: "info", message: "No worktrees" })
        deps.dialog.clear()
        return
      }
      deps.dialog.replace(() => (
        <DialogSelect
          title="Worktrees"
          options={entries.map((dir) => ({ title: dir, value: dir }))}
          onSelect={async (option) => {
            const dir = option.value as string
            deps.dialog.replace(() => (
              <DialogSelect
                title={dir}
                options={[{ title: "Remove", value: "remove" }]}
                onSelect={async (action) => {
                  deps.dialog.clear()
                  if (action.value === "remove") {
                    try {
                      await deps.sdk.client.worktree.remove({ worktreeRemoveInput: { directory: dir } })
                      deps.toast.show({ variant: "success", message: `Removed: ${dir}` })
                    } catch (e) {
                      deps.toast.show({ variant: "error", message: `Failed: ${e instanceof Error ? e.message : e}` })
                    }
                  }
                }}
              />
            ))
          }}
        />
      ))
    } catch (e) {
      deps.toast.show({ variant: "error", message: `Failed to list: ${e instanceof Error ? e.message : e}` })
      deps.dialog.clear()
    }
  }

  async function remove() {
    try {
      const result = await deps.sdk.client.worktree.list()
      const entries = result.data
      if (!entries || entries.length === 0) {
        deps.toast.show({ variant: "info", message: "No worktrees to remove" })
        deps.dialog.clear()
        return
      }
      deps.dialog.replace(() => (
        <DialogSelect
          title="Remove worktree"
          options={entries.map((dir) => ({ title: dir, value: dir }))}
          onSelect={async (option) => {
            const dir = option.value as string
            deps.dialog.clear()
            try {
              await deps.sdk.client.worktree.remove({ worktreeRemoveInput: { directory: dir } })
              deps.toast.show({ variant: "success", message: `Removed: ${dir}` })
            } catch (e) {
              deps.toast.show({ variant: "error", message: `Failed: ${e instanceof Error ? e.message : e}` })
            }
          }}
        />
      ))
    } catch (e) {
      deps.toast.show({ variant: "error", message: `Failed to list: ${e instanceof Error ? e.message : e}` })
      deps.dialog.clear()
    }
  }
}
