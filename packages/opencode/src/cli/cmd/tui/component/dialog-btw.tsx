import { TextAttributes } from "@opentui/core"
import { useDialog } from "@tui/ui/dialog"
import { useTheme } from "@tui/context/theme"
import { useSync } from "@tui/context/sync"
import { createMemo, Match, Show, Switch, onMount } from "solid-js"
import { Spinner } from "./spinner"

export function DialogBtw(props: { sessionID: string; question: string }) {
  const dialog = useDialog()
  const sync = useSync()
  const { theme, syntax } = useTheme()

  onMount(() => {
    dialog.setSize("large")
  })

  const msg = createMemo(() => {
    const list = sync.data.message[props.sessionID] ?? []
    return list.findLast((x) => x.role === "assistant")
  })

  const text = createMemo(() => {
    const info = msg()
    if (!info) return ""
    const parts = sync.data.part[info.id] ?? []
    return parts
      .filter((x) => x.type === "text")
      .map((x) => x.text)
      .join("\n\n")
  })

  const loading = createMemo(() => {
    if (!msg()) return true
    if (text().trim()) return false
    return true
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          btw
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>

      <box>
        <text fg={theme.textMuted}>Question</text>
      </box>
      <box>
        <text fg={theme.text} wrapMode="word">
          {props.question}
        </text>
      </box>

      <box>
        <text fg={theme.textMuted}>Answer</text>
      </box>
      <scrollbox paddingRight={1} scrollbarOptions={{ visible: false }} maxHeight={24}>
        <Switch>
          <Match when={loading()}>
            <Spinner color={theme.textMuted}>Thinking...</Spinner>
          </Match>
          <Match when={!loading()}>
            <Show
              when={text().trim()}
              fallback={
                <text fg={theme.textMuted} wrapMode="word">
                  No response.
                </text>
              }
            >
              <code
                filetype="markdown"
                drawUnstyledText={false}
                streaming={true}
                syntaxStyle={syntax()}
                content={text().trim()}
                fg={theme.text}
              />
            </Show>
          </Match>
        </Switch>
      </scrollbox>
    </box>
  )
}
