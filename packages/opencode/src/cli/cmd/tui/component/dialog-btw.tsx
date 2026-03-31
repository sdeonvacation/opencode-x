import { TextAttributes } from "@opentui/core"
import { useDialog } from "@tui/ui/dialog"
import { useTheme } from "@tui/context/theme"
import { useSync } from "@tui/context/sync"
import { createMemo, For, Show, onMount } from "solid-js"
import { Spinner } from "./spinner"

export function DialogBtw(props: { sessionID: string; question: string }) {
  const dialog = useDialog()
  const sync = useSync()
  const { theme, syntax } = useTheme()

  onMount(() => {
    dialog.setSize("large")
  })

  const id = createMemo(() => {
    const list = sync.data.message[props.sessionID] ?? []
    const found = list.findLast((x) => x.role === "assistant")
    if (found) return found.id
    for (const key in sync.data.part) {
      const parts = sync.data.part[key]
      if (parts?.length && parts[0].sessionID === props.sessionID) return key
    }
    return undefined
  })

  // Access the store array directly — no memo indirection — so each
  // element stays a store proxy with fine-grained .text tracking.
  const parts = () => {
    const mid = id()
    if (!mid) return []
    return sync.data.part[mid] ?? []
  }

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
        <Show when={parts().length > 0} fallback={<Spinner color={theme.textMuted}>Thinking...</Spinner>}>
          <For each={parts()}>
            {(part) => (
              <Show when={part.type === "text"}>
                <BtwText part={part as any} />
              </Show>
            )}
          </For>
        </Show>
      </scrollbox>
    </box>
  )
}

// Separate component so `part` is a store proxy prop — exactly like
// the session view's TextPart. Property-level `.text` tracking works
// because the prop is never unwrapped through a memo.
function BtwText(props: { part: { text: string } }) {
  const { theme } = useTheme()
  return (
    <Show when={props.part.text.trim()}>
      <text fg={theme.text} wrapMode={"word"}>
        {props.part.text.trim()}
      </text>
    </Show>
  )
}
