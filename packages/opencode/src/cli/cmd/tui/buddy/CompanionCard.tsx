import { For } from "solid-js"
import type { JSX } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { renderSprite } from "./sprites"
import { RARITY_COLOR_KEY, RARITY_STARS, STAT_NAMES, type Companion, type Rarity } from "./types"
import type { RGBA } from "@opentui/core"

const CARD_WIDTH = 40

function rarityColor(rarity: Rarity, theme: ReturnType<typeof useTheme>["theme"]): RGBA {
  return theme[RARITY_COLOR_KEY[rarity]] as RGBA
}

function statBar(value: number): string {
  const filled = Math.round((Math.max(0, Math.min(100, value)) / 100) * 10)
  return "█".repeat(filled) + "░".repeat(10 - filled)
}

export type CompanionCardProps = {
  companion: Companion
  lastReaction?: string
  onDone?: () => void
}

export function CompanionCard(props: CompanionCardProps): JSX.Element {
  const { theme } = useTheme()
  const color = () => rarityColor(props.companion.rarity, theme)
  const stars = () => RARITY_STARS[props.companion.rarity]
  const sprite = () => renderSprite(props.companion, 0)

  return (
    <box
      flexDirection="column"
      border={["top", "right", "bottom", "left"]}
      borderColor={color()}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      width={CARD_WIDTH}
      flexShrink={0}
    >
      {/* Header: rarity + species */}
      <box flexDirection="row" justifyContent="space-between">
        <text fg={color()}>
          <span style={{ bold: true }}>
            {stars()} {props.companion.rarity.toUpperCase()}
          </span>
        </text>
        <text fg={color()}>{props.companion.species.toUpperCase()}</text>
      </box>

      {/* Shiny indicator */}
      <For each={props.companion.shiny ? ["shiny"] : []}>
        {() => (
          <text fg={theme.warning}>
            <span style={{ bold: true }}>✨ SHINY ✨</span>
          </text>
        )}
      </For>

      {/* Sprite */}
      <box flexDirection="column" marginTop={1} marginBottom={1}>
        <For each={sprite()}>{(line) => <text fg={color()}>{line}</text>}</For>
      </box>

      {/* Name */}
      <text fg={theme.text}>
        <span style={{ bold: true }}>{props.companion.name}</span>
      </text>

      {/* Personality */}
      <box marginTop={1} marginBottom={1}>
        <text fg={theme.textMuted}>
          <span style={{ italic: true }}>&quot;{props.companion.personality}&quot;</span>
        </text>
      </box>

      {/* Stats */}
      <box flexDirection="column">
        <For each={STAT_NAMES}>
          {(name) => (
            <text fg={theme.text}>
              {name.padEnd(10)} {statBar(props.companion.stats[name] ?? 0)}{" "}
              {String(props.companion.stats[name] ?? 0).padStart(3)}
            </text>
          )}
        </For>
      </box>

      {/* Last reaction */}
      <For each={props.lastReaction ? [props.lastReaction] : []}>
        {(reaction) => (
          <box flexDirection="column" marginTop={1}>
            <text fg={theme.textMuted}>last said</text>
            <box
              border={["top", "right", "bottom", "left"]}
              borderColor={theme.border}
              paddingLeft={1}
              paddingRight={1}
            >
              <text fg={theme.textMuted}>
                <span style={{ italic: true }}>{reaction}</span>
              </text>
            </box>
          </box>
        )}
      </For>

      {/* Dismiss hint */}
      <For each={props.onDone ? ["hint"] : []}>
        {() => (
          <box marginTop={1}>
            <text fg={theme.textMuted}>Press any key to close</text>
          </box>
        )}
      </For>
    </box>
  )
}
