import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useRouteData } from "@tui/context/route"
import { Loop } from "@/loop/loop"
import type { SessionID } from "@/session/schema"

export function LoopStatus() {
  const { theme } = useTheme()
  const route = useRouteData("session")

  const [count, setCount] = createSignal(0)

  const poll = () => {
    const loops = Loop.list(route.sessionID as SessionID)
    setCount(loops.filter((l) => l.status === "active").length)
  }

  onMount(() => {
    poll()
    const id = setInterval(poll, 5000)
    onCleanup(() => clearInterval(id))
  })

  return (
    <Show when={count() > 0}>
      <box flexDirection="row" flexShrink={0}>
        <text fg={theme.textMuted}>
          🔄 {count()} loop{count() > 1 ? "s" : ""}
        </text>
      </box>
    </Show>
  )
}
