import { type CommandOption } from "@tui/component/dialog-command"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { DialogSelect } from "@tui/ui/dialog-select"
import { type DialogContext } from "@tui/ui/dialog"
import { type ToastContext } from "@tui/ui/toast"
import { Keybind } from "@/util/keybind"

export type LoopCommandDeps = {
  dialog: Pick<DialogContext, "clear" | "replace">
  toast: Pick<ToastContext, "show">
  sdk: { url: string; fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response> }
  route: {
    data: { type: string; sessionID?: string }
    navigate: (route: { type: "session"; sessionID: string }) => void
  }
}

type LoopInfo = {
  id: string
  session_id: string
  prompt: string
  interval_ms: number
  status: string
  model: string | null
  token_budget: number | null
  tokens_used: number
  iteration_count: number
  next_run_at: number
  last_run_at: number | null
  last_subagent_session_id: string | null
  expires_at: number
  created_at: number
}

export function createLoopCommand(deps: LoopCommandDeps): CommandOption {
  return {
    title: "Loop",
    value: "session.loop",
    keybind: "loop_panel",
    category: "Session",
    slash: {
      name: "loop",
    },
    onSelect: async () => {
      const id = sid()
      if (!id) {
        deps.toast.show({ message: "No active session", variant: "warning" })
        deps.dialog.clear()
        return
      }
      return openPanel(id)
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

  function parseInterval(raw: string): number | null {
    const match = raw.match(/^(\d+)(s|m|h|ms)?$/)
    if (!match) return null
    const value = parseInt(match[1], 10)
    const unit = match[2] ?? "m"
    if (unit === "ms") return value
    if (unit === "s") return value * 1000
    if (unit === "m") return value * 60_000
    if (unit === "h") return value * 3_600_000
    return null
  }

  async function openPanel(sessionID: string) {
    let loops: LoopInfo[]
    try {
      loops = (await api(`/session/${sessionID}/loops`)) as LoopInfo[]
    } catch (e) {
      deps.toast.show({ message: `Failed to list loops: ${e instanceof Error ? e.message : e}`, variant: "error" })
      deps.dialog.clear()
      return
    }

    const active = loops.filter((l) => l.status === "active" || l.status === "paused")

    const options = [
      ...active.map((l) => ({
        title: `${statusIcon(l.status)} ${l.prompt.slice(0, 50)}`,
        value: l.id,
        description: formatLoopMeta(l),
        footer: `${l.status} · iter ${l.iteration_count} · ${formatTokens(l.tokens_used)} tokens`,
      })),
      {
        title: "+ Create new loop",
        value: "__create__",
        description: "Create a recurring loop",
      },
    ]

    deps.dialog.replace(() => (
      <DialogSelect
        title="Loops"
        options={options}
        keybind={[
          {
            title: "Pause/Resume",
            keybind: Keybind.parse("p")[0],
            onTrigger: (option) => {
              if (option.value === "__create__") return
              const loop = active.find((l) => l.id === option.value)
              if (!loop) return
              togglePause(sessionID, loop)
            },
          },
          {
            title: "Cancel",
            keybind: Keybind.parse("d")[0],
            onTrigger: (option) => {
              if (option.value === "__create__") return
              cancelLoop(sessionID, option.value)
            },
          },
        ]}
        onSelect={(option) => {
          if (option.value === "__create__") {
            createInteractive(sessionID)
            return
          }
          // Navigate to last subagent session
          const loop = active.find((l) => l.id === option.value)
          if (loop?.last_subagent_session_id) {
            deps.dialog.clear()
            deps.route.navigate({ type: "session", sessionID: loop.last_subagent_session_id })
          } else {
            deps.toast.show({ message: "No iteration session yet", variant: "info" })
          }
        }}
      />
    ))
  }

  async function createInteractive(sessionID: string) {
    const prompt = await DialogPrompt.show(deps.dialog, "Loop prompt", {
      placeholder: "What should the loop do each iteration?",
    })
    if (!prompt?.trim()) {
      deps.dialog.clear()
      return
    }

    const intervalRaw = await DialogPrompt.show(deps.dialog, "Interval (e.g. 5m, 1h, 300s)", {
      placeholder: "5m",
    })
    if (!intervalRaw?.trim()) {
      deps.dialog.clear()
      return
    }

    const intervalMs = parseInterval(intervalRaw.trim())
    if (!intervalMs || intervalMs < 60_000) {
      deps.toast.show({ message: "Interval must be >= 60s", variant: "warning" })
      deps.dialog.clear()
      return
    }

    deps.dialog.clear()
    try {
      await api(`/session/${sessionID}/loop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: prompt.trim(), interval_ms: intervalMs }),
      })
      deps.toast.show({ message: `Loop created (every ${intervalRaw.trim()})`, variant: "success" })
    } catch (e) {
      deps.toast.show({ message: `Failed: ${e instanceof Error ? e.message : e}`, variant: "error" })
    }
  }

  async function togglePause(sessionID: string, loop: LoopInfo) {
    const action = loop.status === "paused" ? "resume" : "pause"
    try {
      await api(`/session/${sessionID}/loop/${loop.id}/${action}`, { method: "POST" })
      deps.toast.show({ message: `Loop ${action}d`, variant: "success" })
      openPanel(sessionID)
    } catch (e) {
      deps.toast.show({ message: `Failed: ${e instanceof Error ? e.message : e}`, variant: "error" })
    }
  }

  async function cancelLoop(sessionID: string, loopID: string) {
    try {
      await api(`/session/${sessionID}/loop/${loopID}`, { method: "DELETE" })
      deps.toast.show({ message: "Loop cancelled", variant: "success" })
      openPanel(sessionID)
    } catch (e) {
      deps.toast.show({ message: `Failed: ${e instanceof Error ? e.message : e}`, variant: "error" })
    }
  }
}

function statusIcon(status: string): string {
  if (status === "active") return "▶"
  if (status === "paused") return "⏸"
  return "○"
}

function formatLoopMeta(loop: LoopInfo): string {
  const interval = formatDuration(loop.interval_ms)
  const next = loop.status === "active" ? `next: ${formatRelative(loop.next_run_at)}` : "paused"
  return `every ${interval} · ${next}`
}

function formatDuration(ms: number): string {
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)}h`
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 1000)}s`
}

function formatRelative(timestamp: number): string {
  const diff = timestamp - Date.now()
  if (diff <= 0) return "now"
  if (diff < 60_000) return `${Math.round(diff / 1000)}s`
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`
  return `${Math.round(diff / 3_600_000)}h`
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}
