import { For } from "solid-js"
import type { JSX } from "@opentui/solid"
import type { RGBA } from "@opentui/core"

export type SpeechBubbleProps = {
  text: string
  color: RGBA
  fading: boolean
  tail?: "right" | "down"
}

function wrapText(text: string, width: number): string[] {
  const words = text.split(" ")
  const lines: string[] = []
  let line = ""
  for (const word of words) {
    if (line.length + word.length + (line ? 1 : 0) <= width) {
      line += (line ? " " : "") + word
    } else {
      if (line) lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  return lines
}

export function SpeechBubble(props: SpeechBubbleProps): JSX.Element {
  const lines = () => wrapText(props.text, 30)
  const color = () => (props.fading ? undefined : props.color)

  const bubble = (
    <box
      flexDirection="column"
      border={["top", "right", "bottom", "left"]}
      borderColor={color()}
      paddingLeft={1}
      paddingRight={1}
      width={34}
    >
      <For each={lines()}>
        {(line) => (
          <text fg={color()}>
            <span style={{ italic: true }}>{line}</span>
          </text>
        )}
      </For>
    </box>
  )

  if (props.tail === "right") {
    return (
      <box flexDirection="row" alignItems="center">
        {bubble}
        <text fg={color()}>─</text>
      </box>
    )
  }

  // tail === "down" (default)
  return (
    <box flexDirection="column" alignItems="flex-end" marginRight={1}>
      {bubble}
      <box flexDirection="column" alignItems="flex-end" paddingRight={6}>
        <text fg={color()}>╲ </text>
        <text fg={color()}>╲</text>
      </box>
    </box>
  )
}
