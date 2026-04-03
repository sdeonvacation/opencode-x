import { Show, createSignal, onCleanup } from "solid-js"
import { useTheme } from "../context/theme"
import { useKV } from "../context/kv"
import type { JSX } from "@opentui/solid"
import type { RGBA } from "@opentui/core"
import type { ColorGenerator } from "opentui-spinner"

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export function Spinner(props: { children?: JSX.Element; color?: RGBA | ColorGenerator }) {
  const { theme } = useTheme()
  const kv = useKV()
  const color = () => props.color ?? theme.textMuted
  const [index, setIndex] = createSignal(0)
  const frameColor = () => {
    const value = color()
    return typeof value === "function" ? value(index(), 0, frames.length, 1) : value
  }
  const textColor = () => {
    const value = color()
    return typeof value === "function" ? theme.textMuted : value
  }

  const timer = setInterval(() => {
    setIndex((value) => (value + 1) % frames.length)
  }, 80)

  onCleanup(() => clearInterval(timer))

  return (
    <Show when={kv.get("animations_enabled", true)} fallback={<text fg={textColor()}>⋯ {props.children}</text>}>
      <box flexDirection="row" gap={1}>
        <text fg={frameColor()}>{frames[index()]}</text>
        <Show when={props.children}>
          <text fg={textColor()}>{props.children}</text>
        </Show>
      </box>
    </Show>
  )
}
