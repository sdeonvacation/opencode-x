import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import type { ScrollBoxRenderable } from "@opentui/core"
import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2"
import { useTheme } from "@tui/context/theme"
import { SearchText, type SearchMatch } from "./extract"

export interface SearchProps {
  messages: () => Array<UserMessage | AssistantMessage>
  parts: (messageID: string) => Part[]
  onClose: () => void
  onMatch?: (messageID: string | null) => void
  scroll: ScrollBoxRenderable
  width: number
}

export function SearchOverlay(props: SearchProps) {
  const { theme } = useTheme()
  const [query, setQuery] = createSignal("")
  const [current, setCurrent] = createSignal(0)
  const [debouncedQuery, setDebouncedQuery] = createSignal("")
  // editing: typing into query. confirmed: n/N navigate.
  const [confirmed, setConfirmed] = createSignal(false)

  let timer: ReturnType<typeof setTimeout> | undefined
  createEffect(
    on(query, (q) => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setDebouncedQuery(q), 150)
    }),
  )
  onCleanup(() => {
    if (timer) clearTimeout(timer)
  })

  const matches = createMemo<SearchMatch[]>(() => {
    const q = debouncedQuery()
    if (!q) return []
    const all: SearchMatch[] = []
    for (const msg of props.messages()) {
      if (!("completed" in msg.time) || !msg.time.completed) continue
      const parts = props.parts(msg.id)
      const corpus = SearchText.extract(parts)
      const found = SearchText.find(corpus, q, msg.id)
      all.push(...found)
    }
    return all
  })

  // Reset current index when matches change
  createEffect(
    on(matches, () => {
      setCurrent(0)
    }),
  )

  // Scroll to current match AND highlight it imperatively
  let lit: { renderable: any; color: unknown; bg: unknown } | null = null

  function highlight(idx: number) {
    const m = matches()
    if (!m.length) {
      if (lit) {
        lit.renderable.borderColor = lit.color
        lit.renderable.backgroundColor = lit.bg
        lit = null
      }
      props.onMatch?.(null)
      return
    }
    const match = m[idx]
    if (!match) return
    const children = props.scroll.getChildren()
    const child = children.find((c) => c.id === match.messageID)
    if (!child) return
    if (lit && lit.renderable !== child) {
      lit.renderable.borderColor = lit.color
      lit.renderable.backgroundColor = lit.bg
    }
    props.scroll.scrollBy(child.y - props.scroll.y - 1)
    if (!lit || lit.renderable !== child) {
      lit = { renderable: child, color: (child as any).borderColor, bg: (child as any).backgroundColor }
    }
    ;(child as any).borderColor = "#f5c542"
    ;(child as any).backgroundColor = "#f5c54220"
    props.onMatch?.(match.messageID)
  }

  createEffect(on(current, (idx) => highlight(idx)))
  createEffect(on(matches, () => highlight(current())))

  onCleanup(() => {
    if (lit) {
      lit.renderable.borderColor = lit.color
      lit.renderable.backgroundColor = lit.bg
      lit = null
    }
  })

  function next() {
    const m = matches()
    if (!m.length) return
    setCurrent((c) => (c + 1) % m.length)
  }

  function prev() {
    const m = matches()
    if (!m.length) return
    setCurrent((c) => (c - 1 + m.length) % m.length)
  }

  useKeyboard((evt) => {
    if (evt.name === "escape") {
      evt.preventDefault()
      if (lit) {
        lit.renderable.borderColor = lit.color
        lit.renderable.backgroundColor = lit.bg
        lit = null
      }
      props.onMatch?.(null)
      props.onClose()
      return
    }

    // Enter confirms query and navigates forward; Shift+Enter navigates backward
    if (evt.name === "return") {
      evt.preventDefault()
      setConfirmed(true)
      if (evt.shift) prev()
      else next()
      return
    }

    // n/N navigate only when query is confirmed (not during editing)
    if (confirmed() && evt.name === "n" && !evt.ctrl && !evt.meta) {
      evt.preventDefault()
      if (evt.shift) prev()
      else next()
      return
    }

    // Any editing key reverts to editing mode
    if (evt.name === "backspace" || evt.name === "delete") {
      evt.preventDefault()
      setConfirmed(false)
      setQuery((q) => q.slice(0, -1))
      return
    }

    // Ctrl+U clears the query
    if (evt.name === "u" && evt.ctrl) {
      evt.preventDefault()
      setConfirmed(false)
      setQuery("")
      return
    }

    // Printable character
    if (evt.name && evt.name.length === 1 && !evt.ctrl && !evt.meta) {
      evt.preventDefault()
      setConfirmed(false)
      setQuery((q) => q + evt.name)
      return
    }
  })

  const count = createMemo(() => matches().length)
  const display = createMemo(() => {
    if (!debouncedQuery()) return ""
    if (!count()) return "0 of 0"
    return `${current() + 1} of ${count()}`
  })

  const barWidth = createMemo(() => Math.min(props.width - 4, 50))

  return (
    <box
      position="absolute"
      top={0}
      right={2}
      width={barWidth()}
      height={1}
      flexDirection="row"
      backgroundColor={theme.backgroundElement}
    >
      <text fg={theme.textMuted}>{"🔍 "}</text>
      <text fg={theme.text} flexGrow={1}>
        {query() || " "}
      </text>
      <text fg={theme.textMuted}>{display() ? ` ${display()} ` : " "}</text>
      <text fg={theme.textMuted}>{confirmed() ? "n/N Esc" : "Enter Esc"}</text>
    </box>
  )
}
