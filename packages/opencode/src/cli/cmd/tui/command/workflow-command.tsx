import { type CommandOption } from "@tui/component/dialog-command"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { DialogSelect } from "@tui/ui/dialog-select"
import { type DialogContext } from "@tui/ui/dialog"
import { type ToastContext } from "@tui/ui/toast"

export type WorkflowCommandDeps = {
  dialog: Pick<DialogContext, "clear" | "replace">
  toast: Pick<ToastContext, "show">
  sdk: { url: string; fetch: typeof fetch }
  route: {
    data: { type: string; sessionID?: string }
  }
}

export function createWorkflowCommand(deps: WorkflowCommandDeps): CommandOption {
  return {
    title: "Workflow",
    value: "workflow.manage",
    category: "System",
    slash: {
      name: "workflow",
      aliases: ["wf"],
    },
    onSelect: async () => {
      deps.dialog.replace(() => (
        <DialogSelect
          title="Workflow"
          options={[
            { title: "Create", value: "create" },
            { title: "Start", value: "start" },
            { title: "Stop", value: "stop" },
            { title: "List runs", value: "list" },
          ]}
          onSelect={async (option) => {
            if (option.value === "create") return create()
            if (option.value === "start") return start()
            if (option.value === "stop") return stop()
            if (option.value === "list") return list()
          }}
        />
      ))
    },
  }

  function sid() {
    const session = deps.route.data
    if (session.type !== "session" || !session.sessionID) return undefined
    return session.sessionID
  }

  async function api(path: string, opts?: RequestInit) {
    const res = await deps.sdk.fetch(`${deps.sdk.url}${path}`, opts)
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? body.message ?? `HTTP ${res.status}`)
    return body
  }

  async function start() {
    const id = sid()
    if (!id) {
      deps.toast.show({ message: "No active session", variant: "warning" })
      deps.dialog.clear()
      return
    }
    const scripts = (await api("/workflow/scripts")) as string[]
    if (!scripts.length) {
      deps.toast.show({ message: "No workflows found. Create one first.", variant: "warning" })
      deps.dialog.clear()
      return
    }
    deps.dialog.replace(() => (
      <DialogSelect
        title="Start workflow"
        options={scripts.map((s) => ({ title: s, value: s }))}
        onSelect={async (option) => {
          deps.dialog.clear()
          try {
            const res = (await api(`/session/${id}/workflow/start`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name: option.value }),
            })) as { id: string }
            deps.toast.show({ message: `Started: ${res.id}`, variant: "success" })
          } catch (e) {
            deps.toast.show({ message: `Failed: ${e instanceof Error ? e.message : e}`, variant: "error" })
          }
        }}
      />
    ))
  }

  async function stop() {
    const id = sid()
    if (!id) {
      deps.toast.show({ message: "No active session", variant: "warning" })
      deps.dialog.clear()
      return
    }
    const runs = (await api(`/session/${id}/workflow/list`)) as { id: string; name: string; status: string }[]
    const active = runs.filter((r) => r.status === "running")
    if (!active.length) {
      deps.toast.show({ message: "No running workflows", variant: "info" })
      deps.dialog.clear()
      return
    }
    deps.dialog.replace(() => (
      <DialogSelect
        title="Stop workflow"
        options={active.map((r) => ({ title: `${r.name} (${r.id.slice(-8)})`, value: r.id }))}
        onSelect={async (option) => {
          deps.dialog.clear()
          try {
            await api(`/session/${id}/workflow/${option.value}/cancel`, { method: "POST" })
            deps.toast.show({ message: "Stopped", variant: "success" })
          } catch (e) {
            deps.toast.show({ message: `Failed: ${e instanceof Error ? e.message : e}`, variant: "error" })
          }
        }}
      />
    ))
  }

  async function list() {
    const id = sid()
    if (!id) {
      deps.toast.show({ message: "No active session", variant: "warning" })
      deps.dialog.clear()
      return
    }
    const runs = (await api(`/session/${id}/workflow/list`)) as {
      id: string
      name: string
      status: string
      error?: string | null
    }[]
    if (!runs.length) {
      deps.toast.show({ message: "No workflow runs", variant: "info" })
      deps.dialog.clear()
      return
    }
    deps.dialog.replace(() => (
      <DialogSelect
        title="Workflow runs"
        options={runs.map((r) => ({
          title: `${r.name} [${r.status}]`,
          value: r.id,
          description: r.error ? r.error.slice(0, 60) : r.id.slice(-8),
        }))}
        onSelect={(option) => {
          deps.toast.show({ message: `Run: ${option.value}`, variant: "info" })
          deps.dialog.clear()
        }}
      />
    ))
  }

  async function create() {
    const name = await DialogPrompt.show(deps.dialog, "Workflow name", {
      placeholder: "e.g. review-and-fix, deploy, test-suite",
    })
    if (!name?.trim()) {
      deps.dialog.clear()
      return
    }

    const prompt = await DialogPrompt.show(deps.dialog, "What should this workflow do?", {
      placeholder: "e.g. Run tests, debug failures, then run tests again until they pass",
    })
    if (!prompt?.trim()) {
      deps.dialog.clear()
      return
    }

    deps.dialog.clear()
    deps.toast.show({ message: "Generating workflow...", variant: "info" })

    try {
      await api("/workflow/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), prompt: prompt.trim() }),
      })
      deps.toast.show({ message: `Created: ${name.trim()}.js`, variant: "success" })
    } catch (e) {
      deps.toast.show({ message: `Failed: ${e instanceof Error ? e.message : e}`, variant: "error" })
    }
  }
}
