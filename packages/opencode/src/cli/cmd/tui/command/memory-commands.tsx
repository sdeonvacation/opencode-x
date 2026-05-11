import { type CommandOption } from "@tui/component/dialog-command"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { DialogSelect } from "@tui/ui/dialog-select"
import { type DialogContext } from "@tui/ui/dialog"
import { type ToastContext } from "@tui/ui/toast"

type MemoryEntry = { id: string; content: string; position: number }

export type MemoryCommandsDeps = {
  dialog: {
    clear: Pick<DialogContext, "clear">["clear"]
    replace: Pick<DialogContext, "replace">["replace"]
  }
  toast: Pick<ToastContext, "show">
  sdk: {
    url: string
    fetch: typeof fetch
  }
  route: {
    data: { type: "session"; sessionID: string } | { type: string; sessionID?: string }
  }
}

export function createMemoryCommands(deps: MemoryCommandsDeps): CommandOption[] {
  function sessionID() {
    if (deps.route.data.type !== "session") return null
    return deps.route.data.sessionID
  }

  function noSession() {
    deps.toast.show({ variant: "warning", message: "No active session", duration: 3000 })
    deps.dialog.clear()
  }

  async function memoryList(id: string): Promise<MemoryEntry[]> {
    const res = await deps.sdk.fetch(`${deps.sdk.url}/session/${id}/memory`)
    if (!res.ok) throw new Error(`memory list failed: ${res.status}`)
    return res.json()
  }

  async function memoryCreate(id: string, content: string): Promise<MemoryEntry> {
    const res = await deps.sdk.fetch(`${deps.sdk.url}/session/${id}/memory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    })
    if (!res.ok) throw new Error(`memory create failed: ${res.status}`)
    return res.json()
  }

  async function memoryUpdate(id: string, memoryID: string, content: string): Promise<MemoryEntry> {
    const res = await deps.sdk.fetch(`${deps.sdk.url}/session/${id}/memory/${memoryID}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    })
    if (!res.ok) throw new Error(`memory update failed: ${res.status}`)
    return res.json()
  }

  async function memoryDelete(id: string, memoryID: string): Promise<void> {
    const res = await deps.sdk.fetch(`${deps.sdk.url}/session/${id}/memory/${memoryID}`, {
      method: "DELETE",
    })
    if (!res.ok) throw new Error(`memory delete failed: ${res.status}`)
  }

  return [
    {
      title: "Add to memory",
      value: "memory.add",
      slash: { name: "memory_add" },
      onSelect: async () => {
        const id = sessionID()
        if (!id) {
          noSession()
          return
        }

        const content = await DialogPrompt.show(deps.dialog, "Add Memory", {
          placeholder: "Add a note to session memory...",
        })
        if (!content?.trim()) return

        await memoryCreate(id, content.trim())
        deps.toast.show({ variant: "success", message: "Memory saved", duration: 3000 })
        deps.dialog.clear()
      },
      category: "Agent",
    },
    {
      title: "Edit memory",
      value: "memory.edit",
      slash: { name: "memory_edit" },
      onSelect: async () => {
        const id = sessionID()
        if (!id) {
          noSession()
          return
        }

        const entries = await memoryList(id)
        if (entries.length === 0) {
          deps.toast.show({ variant: "warning", message: "No memory entries", duration: 3000 })
          deps.dialog.clear()
          return
        }

        deps.dialog.replace(() => (
          <DialogSelect
            title="Select entry to edit"
            options={entries.map((e) => ({
              title: e.content.slice(0, 80),
              value: e,
            }))}
            onSelect={async (option) => {
              const entry = option.value as MemoryEntry
              const updated = await DialogPrompt.show(deps.dialog, "Edit Memory", {
                placeholder: "Edit memory content...",
                value: entry.content,
              })
              if (!updated?.trim()) {
                deps.dialog.clear()
                return
              }

              await memoryUpdate(id, entry.id, updated.trim())
              deps.toast.show({ variant: "success", message: "Memory updated", duration: 3000 })
              deps.dialog.clear()
            }}
          />
        ))
      },
      category: "Agent",
    },
    {
      title: "Delete memory",
      value: "memory.delete",
      slash: { name: "memory_delete" },
      onSelect: async () => {
        const id = sessionID()
        if (!id) {
          noSession()
          return
        }

        const entries = await memoryList(id)
        if (entries.length === 0) {
          deps.toast.show({ variant: "warning", message: "No memory entries", duration: 3000 })
          deps.dialog.clear()
          return
        }

        deps.dialog.replace(() => (
          <DialogSelect
            title="Select entry to delete"
            options={entries.map((e) => ({
              title: e.content.slice(0, 80),
              value: e,
            }))}
            onSelect={async (option) => {
              const entry = option.value as MemoryEntry
              await memoryDelete(id, entry.id)
              deps.toast.show({ variant: "success", message: "Memory deleted", duration: 3000 })
              deps.dialog.clear()
            }}
          />
        ))
      },
      category: "Agent",
    },
  ]
}
