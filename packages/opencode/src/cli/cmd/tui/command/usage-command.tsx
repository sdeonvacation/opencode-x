import { TextAttributes } from "@opentui/core"
import { For, Show } from "solid-js"
import { type CommandOption } from "@tui/component/dialog-command"
import { type DialogContext } from "@tui/ui/dialog"
import { type ToastContext } from "@tui/ui/toast"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"

type UsageData = {
  total: {
    cost: number
    tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
    duration: number
    wall: number
  }
  primary: {
    cost: number
  }
  byModel: Array<{
    providerID: string
    modelID: string
    cost: number
    tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
    duration: number
  }>
  subagents: {
    cost: number
    tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
    count: number
    sessions: Array<{ title: string; cost: number }>
  }
}

function shortTitle(title: string): string {
  return title.length > 40 ? title.slice(0, 37) + "..." : title
}

function DialogUsage(props: { usage: UsageData }) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const u = props.usage

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      {/* Header */}
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Session Usage
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>

      {/* Totals */}
      <box>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text}>Total cost</text>
          <text fg={theme.accent} attributes={TextAttributes.BOLD}>
            {formatCost(u.total.cost)}
          </text>
        </box>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.textMuted}>API duration</text>
          <text fg={theme.text}>{formatDuration(u.total.duration)}</text>
        </box>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.textMuted}>Wall duration</text>
          <text fg={theme.text}>{formatDuration(u.total.wall)}</text>
        </box>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.textMuted}>Total tokens</text>
          <text fg={theme.text}>
            {formatTokens(u.total.tokens.input + u.total.tokens.output + u.total.tokens.reasoning)}
          </text>
        </box>
      </box>

      {/* Models */}
      <box>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Primary Agent
          </text>
          <text fg={theme.success}>{formatCost(u.primary.cost)}</text>
        </box>
        <For each={u.byModel}>
          {(m) => (
            <box paddingLeft={1}>
              <box flexDirection="row" justifyContent="space-between">
                <text fg={theme.text}>{m.modelID}</text>
                <text fg={theme.textMuted}>{formatCost(m.cost)}</text>
              </box>
              <box flexDirection="row" gap={2} paddingLeft={1}>
                <text fg={theme.textMuted}>{formatTokens(m.tokens.input)} in</text>
                <text fg={theme.textMuted}>{formatTokens(m.tokens.output)} out</text>
                <Show when={m.tokens.cache.read > 0}>
                  <text fg={theme.textMuted}>{formatTokens(m.tokens.cache.read)} cached</text>
                </Show>
              </box>
            </box>
          )}
        </For>
      </box>

      {/* Subagents */}
      <Show when={u.subagents.count > 0}>
        <box>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              Subagents
            </text>
            <text fg={theme.textMuted}>{u.subagents.count} sessions</text>
          </box>
          <For each={u.subagents.sessions.slice(0, 15)}>
            {(s) => (
              <box flexDirection="row" justifyContent="space-between" paddingLeft={1}>
                <text fg={theme.textMuted}>{shortTitle(s.title)}</text>
                <text fg={theme.success} flexShrink={0}>
                  {formatCost(s.cost)}
                </text>
              </box>
            )}
          </For>
          <Show when={u.subagents.sessions.length > 15}>
            <text fg={theme.textMuted} paddingLeft={1}>
              (+{u.subagents.sessions.length - 15} more)
            </text>
          </Show>
        </box>
      </Show>
    </box>
  )
}

export type UsageCommandDeps = {
  sdk: { url: string; fetch: typeof fetch }
  toast: Pick<ToastContext, "show">
  dialog: Pick<DialogContext, "clear" | "replace">
  route: { data: { type: string; sessionID?: string } }
}

export function createUsageCommand(deps: UsageCommandDeps): CommandOption {
  return {
    title: "Show usage",
    value: "session.usage",
    slash: { name: "usage" },
    category: "Session",
    onSelect: async () => {
      const id = deps.route.data.type === "session" ? deps.route.data.sessionID : undefined
      if (!id) {
        deps.toast.show({ variant: "warning", message: "No active session", duration: 3000 })
        deps.dialog.clear()
        return
      }
      try {
        const res = await deps.sdk.fetch(`${deps.sdk.url}/session/${id}/usage`)
        if (!res.ok) throw new Error(`Failed: ${res.status}`)
        const usage = (await res.json()) as UsageData
        deps.dialog.replace(() => <DialogUsage usage={usage} />)
      } catch (e: any) {
        deps.toast.show({ variant: "error", message: e.message || "Failed to load usage", duration: 5000 })
        deps.dialog.clear()
      }
    },
  }
}

function formatCost(n: number): string {
  return `$${n.toFixed(4)}`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return `${n}`
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "0s"
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}
