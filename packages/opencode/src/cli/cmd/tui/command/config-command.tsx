import { type CommandOption } from "@tui/component/dialog-command"
import { type DialogContext } from "@tui/ui/dialog"
import { type ToastContext } from "@tui/ui/toast"
import { DialogSelect } from "@tui/ui/dialog-select"
import { DialogPrompt } from "@tui/ui/dialog-prompt"

type Entry = { key: string; value: string }

const REDACTED = "[REDACTED]"

function setPath(obj: Record<string, any>, path: string, value: unknown) {
  const parts = path.replace(/\[(\d+)]/g, ".$1").split(".")
  let current = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]
    if (current[key] === undefined || current[key] === null) {
      current[key] = /^\d+$/.test(parts[i + 1]) ? [] : {}
    }
    current = current[key]
  }
  const last = parts[parts.length - 1]
  current[last] = value
}

function coerce(value: string, original: string): unknown {
  if (original === "true" || original === "false") return value === "true"
  if (/^\d+$/.test(original)) return parseInt(value, 10)
  if (/^\d+\.\d+$/.test(original)) return parseFloat(value)
  return value
}

export type ConfigCommandDeps = {
  sdk: { url: string; fetch: typeof fetch }
  toast: Pick<ToastContext, "show">
  dialog: {
    clear: DialogContext["clear"]
    replace: DialogContext["replace"]
  }
}

export function createConfigCommand(deps: ConfigCommandDeps): CommandOption {
  return {
    title: "Show config",
    value: "config.flat",
    slash: { name: "config" },
    category: "System",
    onSelect: async () => {
      try {
        const res = await deps.sdk.fetch(`${deps.sdk.url}/config/flat`)
        if (!res.ok) throw new Error(`Failed: ${res.status}`)
        const data = (await res.json()) as { entries: Entry[] }
        const editable = data.entries.filter((e) => e.value !== REDACTED && !e.key.includes("["))
        deps.dialog.replace(() => (
          <DialogSelect
            title="Configuration"
            options={editable.map((e) => ({
              title: e.key,
              description: e.value,
              value: e,
            }))}
            onSelect={async (option) => {
              const entry = option.value as Entry
              const updated = await DialogPrompt.show(deps.dialog, `Edit: ${entry.key}`, {
                placeholder: "Enter new value...",
                value: entry.value,
              })
              if (updated === null || updated === undefined) {
                deps.dialog.clear()
                return
              }
              try {
                const full = await deps.sdk.fetch(`${deps.sdk.url}/config`).then((r) => r.json())
                setPath(full, entry.key, coerce(updated, entry.value))
                const patch = await deps.sdk.fetch(`${deps.sdk.url}/config`, {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(full),
                })
                if (!patch.ok) throw new Error(`Update failed: ${patch.status}`)
                deps.toast.show({ variant: "success", message: `Updated ${entry.key}`, duration: 3000 })
              } catch (e: any) {
                deps.toast.show({ variant: "error", message: e.message || "Update failed", duration: 5000 })
              }
              deps.dialog.clear()
            }}
          />
        ))
      } catch (e: any) {
        deps.toast.show({ variant: "error", message: e.message || "Failed to load config", duration: 5000 })
        deps.dialog.clear()
      }
    },
  }
}
