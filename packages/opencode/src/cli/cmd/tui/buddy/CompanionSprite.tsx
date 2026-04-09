import { createSignal, createEffect, createMemo, onCleanup, Show, For } from "solid-js"
import type { JSX } from "@opentui/solid"
import { useTerminalDimensions } from "@opentui/solid"
import type { Accessor, Setter } from "solid-js"
import { useTheme } from "@tui/context/theme"
import type { Config } from "@/config/config"
import { getCompanion } from "./companion"
import { renderSprite, renderFace, spriteFrameCount } from "./sprites"
import { SpeechBubble } from "./SpeechBubble"
import { RARITY_COLOR_KEY, type Rarity } from "./types"
import type { RGBA } from "@opentui/core"

export const MIN_COLS_FOR_FULL_SPRITE = 100

// Returns the number of terminal columns the companion UI reserves.
// When speaking (bubble visible), the speech bubble adds ~36 cols.
export function companionReservedColumns(cols: number, speaking: boolean): number {
  if (cols < MIN_COLS_FOR_FULL_SPRITE) return 14 // narrow: face + name
  return speaking ? 50 : 14 // wide: sprite col + optional bubble
}

const TICK_MS = 500
const BUBBLE_SHOW = 20 // ticks → ~10s at 500ms
const FADE_WINDOW = 6 // last ~3s the bubble dims

// Idle sequence: mostly rest (frame 0), occasional fidget (frames 1-2), rare blink (-1).
const IDLE_SEQUENCE = [0, 0, 0, 0, 1, 0, 0, 0, -1, 0, 0, 2, 0, 0, 0]

const PET_BURST_MS = 2500

// Hearts float up-and-out over 5 ticks (~2.5s). Each frame is an array of 3 strings.
const PET_HEARTS = [
  ["   ♥    ♥   ", "  ♥  ♥   ♥  ", " ·   ·   ·  "],
  ["    ♥   ♥   ", " ♥  ♥  ♥    ", "  ·   ·  ·  "],
  ["  ♥    ♥    ", "   ♥  ♥  ♥  ", "   ·  ·   · "],
  ["    ♥  ♥    ", "  ♥    ♥  ♥ ", "    ·   ·   "],
  [" ♥     ♥   ", "   ♥    ♥   ", "  ·    ·  · "],
]

export type CompanionSpriteProps = {
  reaction: Accessor<string | undefined>
  setReaction: Setter<string | undefined>
  petAt: Accessor<number | undefined>
  config: Config.Info
}

function rarityColor(rarity: Rarity, theme: ReturnType<typeof useTheme>["theme"]): RGBA {
  return theme[RARITY_COLOR_KEY[rarity]] as RGBA
}

export function CompanionSprite(props: CompanionSpriteProps): JSX.Element {
  const { theme } = useTheme()
  const dims = useTerminalDimensions()

  const [tick, setTick] = createSignal(0)
  const timer = setInterval(() => setTick((t) => t + 1), TICK_MS)
  onCleanup(() => clearInterval(timer))

  // Track when the bubble started showing
  const [lastSpokeTick, setLastSpokeTick] = createSignal(0)

  // Track pet animation start tick
  const [petStartTick, setPetStartTick] = createSignal(0)

  // Auto-clear reaction after BUBBLE_SHOW ticks and track lastSpokeTick
  createEffect(() => {
    const r = props.reaction()
    if (r === undefined) return
    setLastSpokeTick(tick())
    const timer = setTimeout(() => {
      props.setReaction(undefined)
    }, BUBBLE_SHOW * TICK_MS)
    onCleanup(() => clearTimeout(timer))
  })

  // Sync pet start tick when petAt changes
  createEffect(() => {
    const pa = props.petAt()
    if (pa !== undefined) {
      setPetStartTick(tick())
    }
  })

  // Reactive: re-derives companion whenever config.companion changes (e.g. after /buddy hatch)
  const companion = createMemo(() => {
    if (!props.config.experimental?.buddy || props.config.companion_muted) return undefined
    return getCompanion(props.config)
  })

  return (
    <Show when={companion()}>
      {(c) => {
        const color = rarityColor(c().rarity, theme)
        const reaction = () => props.reaction()
        const bubbleAge = () => (reaction() ? tick() - lastSpokeTick() : 0)
        const fading = () => reaction() !== undefined && bubbleAge() >= BUBBLE_SHOW - FADE_WINDOW

        const petAge = () => (props.petAt() ? tick() - petStartTick() : Infinity)
        const petting = () => petAge() * TICK_MS < PET_BURST_MS

        const cols = () => dims().width

        // Narrow terminal: one-line face
        return (
          <Show
            when={cols() >= MIN_COLS_FOR_FULL_SPRITE}
            fallback={(() => {
              const NARROW_QUIP_CAP = 24
              const r = reaction()
              const quip = r && r.length > NARROW_QUIP_CAP ? r.slice(0, NARROW_QUIP_CAP - 1) + "…" : r
              const label = quip ? `"${quip}"` : c().name

              return (
                <box paddingLeft={1} paddingRight={1}>
                  <text>
                    <Show when={petting()}>
                      <span style={{ fg: theme.warning }}>♥ </span>
                    </Show>
                    <span style={{ fg: color }}>{renderFace(c())}</span>{" "}
                    <span style={{ fg: reaction() ? (fading() ? theme.textMuted : color) : theme.textMuted }}>
                      {label}
                    </span>
                  </text>
                </box>
              )
            })()}
          >
            {(() => {
              // Full sprite
              const frameCount = spriteFrameCount(c().species)
              const heartFrameIdx = () => (petting() ? Math.floor(petAge() % PET_HEARTS.length) : -1)
              const heartFrame = () => (heartFrameIdx() >= 0 ? PET_HEARTS[heartFrameIdx()]! : null)

              const spriteFrame = () => {
                if (reaction() || petting()) return tick() % frameCount
                const step = IDLE_SEQUENCE[tick() % IDLE_SEQUENCE.length]!
                return step === -1 ? 0 : step % frameCount
              }
              const blink = () => {
                if (reaction() || petting()) return false
                return IDLE_SEQUENCE[tick() % IDLE_SEQUENCE.length] === -1
              }

              const body = () =>
                renderSprite(c(), spriteFrame()).map((line) => (blink() ? line.replaceAll(c().eye, "-") : line))
              const spriteLines = () => {
                const hf = heartFrame()
                return hf ? [...hf, ...body()] : body()
              }

              const nameWidth = c().name.length
              const colWidth = Math.max(12, nameWidth + 2)

              const spriteColumn = (
                <box flexDirection="column" flexShrink={0} alignItems="center" width={colWidth}>
                  <For each={spriteLines()}>
                    {(line, i) => <text fg={i() === 0 && heartFrame() ? theme.warning : color}>{line}</text>}
                  </For>
                  <text fg={color}>
                    <span style={{ italic: true }}>{c().name}</span>
                  </text>
                </box>
              )

              return (
                <Show
                  when={reaction()}
                  fallback={
                    <box paddingLeft={1} paddingRight={1}>
                      {spriteColumn}
                    </box>
                  }
                >
                  {(r) => (
                    <box flexDirection="row" alignItems="flex-end" paddingLeft={1} paddingRight={1} flexShrink={0}>
                      <SpeechBubble text={r()} color={color} fading={fading()} tail="right" />
                      {spriteColumn}
                    </box>
                  )}
                </Show>
              )
            })()}
          </Show>
        )
      }}
    </Show>
  )
}
