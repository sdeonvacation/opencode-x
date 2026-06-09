import { type CommandOption } from "@tui/component/dialog-command"
import { type DialogContext } from "@tui/ui/dialog"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { DialogSelect } from "@tui/ui/dialog-select"
import { type ToastContext } from "@tui/ui/toast"

export type WorktreeCommandDeps = {
  dialog: Pick<DialogContext, "clear" | "replace">
  sdk: {
    client: {
      worktree: {
        create: (input?: {
          worktreeCreateInput?: { name?: string }
        }) => Promise<{ data?: { name: string; branch: string; directory: string } }>
        list: () => Promise<{ data?: string[] }>
        remove: (input?: { worktreeRemoveInput?: { directory: string } }) => Promise<{ data?: boolean }>
      }
      project: {
        current: () => Promise<{ data?: { worktree: string } }>
      }
    }
    changeDirectory: (path: string) => Promise<void>
  }
  toast: Pick<ToastContext, "show">
  sync: {
    path: {
      worktree: string
      directory: string
    }
  }
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
            { title: "Create", value: "create" },
            { title: "List", value: "list" },
            { title: "Remove", value: "remove" },
            { title: "Switch to base", value: "base" },
          ]}
          onSelect={async (option) => {
            if (option.value === "create") return create()
            if (option.value === "list") return list()
            if (option.value === "remove") return remove()
            if (option.value === "base") return base()
          }}
        />
      ))
    },
  }

  async function create() {
    const name = await DialogPrompt.show(deps.dialog, "Create worktree", {
      placeholder: "Branch name...",
    })
    if (!name?.trim()) {
      deps.dialog.clear()
      return
    }
    deps.dialog.clear()
    try {
      const result = await deps.sdk.client.worktree.create({ worktreeCreateInput: { name: name.trim() } })
      if (!result.data) {
        deps.toast.show({ variant: "error", message: "Failed to create worktree" })
        return
      }
      deps.toast.show({
        variant: "success",
        message: `Created worktree: ${result.data.branch}`,
      })
      await deps.sdk.changeDirectory(result.data.directory)
    } catch (e) {
      deps.toast.show({ variant: "error", message: `Failed: ${e instanceof Error ? e.message : e}` })
    }
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
                options={[
                  { title: "Switch to", value: "switch" },
                  { title: "Remove", value: "remove" },
                ]}
                onSelect={async (action) => {
                  deps.dialog.clear()
                  if (action.value === "switch") {
                    try {
                      await deps.sdk.changeDirectory(dir)
                      deps.toast.show({ variant: "info", message: `Switched to ${dir}` })
                    } catch (e) {
                      deps.toast.show({ variant: "error", message: `Failed: ${e instanceof Error ? e.message : e}` })
                    }
                    return
                  }
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

  async function base() {
    deps.dialog.clear()
    try {
      const project = await deps.sdk.client.project.current()
      const root = project.data?.worktree
      if (!root || root === "/" || root === deps.sync.path.directory) {
        deps.toast.show({ variant: "warning", message: "Already at base" })
        return
      }
      await deps.sdk.changeDirectory(root)
      deps.toast.show({ variant: "info", message: `Switched to base: ${root}` })
    } catch (e) {
      deps.toast.show({ variant: "error", message: `Failed: ${e instanceof Error ? e.message : e}` })
    }
  }
}
