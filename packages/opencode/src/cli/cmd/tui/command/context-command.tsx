import { TextAttributes } from "@opentui/core"
import { createMemo, For, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { type CommandOption } from "@tui/component/dialog-command"
import { type DialogContext } from "@tui/ui/dialog"
import { type ToastContext } from "@tui/ui/toast"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"

type ContextData = {
  model: { providerID: string; modelID: string; name: string; contextLimit: number }
  total: number
  free: number
  categories: Array<{
    name: string
    tokens: number
    items?: Array<{ name: string; tokens: number; source?: string }>
  }>
}

function DialogContext_(props: { data: ContextData }) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  const maxHeight = createMemo(() => Math.floor(dimensions().height * 0.8))
  const d = props.data
  const pct = d.model.contextLimit > 0 ? Math.round((d.total / d.model.contextLimit) * 100) : 0

  return (
    <scrollbox
      maxHeight={maxHeight()}
      scrollbarOptions={{ visible: false }}
      paddingLeft={2}
      paddingRight={2}
      paddingBottom={1}
    >
      {/* Header */}
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Context Usage
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>

      {/* Model info */}
      <box>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text}>{d.model.name}</text>
          <text fg={theme.accent} attributes={TextAttributes.BOLD}>
            {formatTokens(d.total)}/{formatTokens(d.model.contextLimit)} tokens ({pct}%)
          </text>
        </box>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.textMuted}>Free</text>
          <text fg={theme.text}>{d.model.contextLimit > 0 ? formatTokens(d.free) : "unknown"}</text>
        </box>
      </box>

      {/* Categories */}
      <box>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Breakdown
        </text>
        <For each={d.categories}>
          {(cat) => {
            const catPct = d.model.contextLimit > 0 ? Math.round((cat.tokens / d.model.contextLimit) * 100) : 0
            const grouped = groupBySource(cat.items)
            return (
              <box>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.text}>{cat.name}</text>
                  <text fg={theme.textMuted}>
                    {formatTokens(cat.tokens)}
                    <Show when={catPct > 0}>{` (${catPct}%)`}</Show>
                  </text>
                </box>
                <Show when={cat.items && cat.items.length > 0}>
                  <For each={grouped}>
                    {(group) => (
                      <box paddingLeft={1}>
                        <Show when={group.label}>
                          <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
                            {group.label}
                          </text>
                        </Show>
                        <For each={group.items.slice(0, 20)}>
                          {(item, idx) => {
                            const prefix = idx() === group.items.length - 1 || idx() === 19 ? "└─" : "├─"
                            return (
                              <box flexDirection="row" justifyContent="space-between" paddingLeft={1}>
                                <text fg={theme.textMuted}>
                                  {prefix} {item.name}
                                </text>
                                <text fg={theme.textMuted} flexShrink={0}>
                                  {formatTokens(item.tokens)}
                                </text>
                              </box>
                            )
                          }}
                        </For>
                        <Show when={group.items.length > 20}>
                          <text fg={theme.textMuted} paddingLeft={2}>
                            (+{group.items.length - 20} more)
                          </text>
                        </Show>
                      </box>
                    )}
                  </For>
                </Show>
              </box>
            )
          }}
        </For>
      </box>
    </scrollbox>
  )
}

type ItemGroup = {
  label: string
  items: Array<{ name: string; tokens: number; source?: string }>
}

function groupBySource(items?: Array<{ name: string; tokens: number; source?: string }>): ItemGroup[] {
  if (!items || items.length === 0) return []
  const hasSource = items.some((i) => i.source)
  if (!hasSource) return [{ label: "", items }]
  const map = new Map<string, Array<{ name: string; tokens: number; source?: string }>>()
  for (const item of items) {
    const key = item.source || "Other"
    const arr = map.get(key)
    if (arr) arr.push(item)
    else map.set(key, [item])
  }
  return Array.from(map.entries()).map(([label, grouped]) => ({ label, items: grouped }))
}

export type ContextCommandDeps = {
  sdk: { url: string; fetch: typeof fetch }
  toast: Pick<ToastContext, "show">
  dialog: Pick<DialogContext, "clear" | "replace">
  route: { data: { type: string; sessionID?: string } }
}

export function createContextCommand(deps: ContextCommandDeps): CommandOption {
  return {
    title: "Show context usage",
    value: "session.context",
    slash: { name: "context" },
    category: "Session",
    onSelect: async () => {
      const id = deps.route.data.type === "session" ? deps.route.data.sessionID : undefined
      if (!id) {
        deps.toast.show({ variant: "warning", message: "No active session", duration: 3000 })
        deps.dialog.clear()
        return
      }
      try {
        const res = await deps.sdk.fetch(`${deps.sdk.url}/session/${id}/context`)
        if (!res.ok) throw new Error(`Failed: ${res.status}`)
        const data = (await res.json()) as ContextData
        deps.dialog.replace(() => <DialogContext_ data={data} />)
      } catch (e: any) {
        deps.toast.show({ variant: "error", message: e.message || "Failed to load context", duration: 5000 })
        deps.dialog.clear()
      }
    },
  }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return `${n}`
}
