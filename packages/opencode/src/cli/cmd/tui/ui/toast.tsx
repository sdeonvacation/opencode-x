import { createContext, useContext, createSignal, onCleanup, type ParentProps, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useTheme } from "@tui/context/theme"
import { useTerminalDimensions } from "@opentui/solid"
import { SplitBorder } from "../component/border"
import { TextAttributes } from "@opentui/core"
import z from "zod"
import { TuiEvent } from "../event"

export type ToastOptions = z.infer<typeof TuiEvent.ToastShow.properties>

interface ToastItem {
  id: string
  title?: string
  message: string
  variant: "info" | "success" | "warning" | "error"
  duration: number
  created: number
}

const MAX_QUEUE = 5

export function Toast() {
  const toast = useToast()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const [tick, setTick] = createSignal(Date.now())

  const interval = setInterval(() => setTick(Date.now()), 100)
  onCleanup(() => clearInterval(interval))

  const remaining = () => {
    const item = toast.currentToast
    if (!item) return 0
    const elapsed = tick() - item.created
    const ratio = 1 - elapsed / item.duration
    return Math.max(0, Math.min(1, ratio))
  }

  return (
    <Show when={toast.currentToast}>
      {(current) => (
        <box
          position="absolute"
          justifyContent="center"
          alignItems="flex-start"
          top={2}
          right={2}
          maxWidth={Math.min(60, dimensions().width - 6)}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          backgroundColor={theme.backgroundPanel}
          borderColor={theme[current().variant]}
          border={["left", "right"]}
          customBorderChars={SplitBorder.customBorderChars}
        >
          <Show when={current().title}>
            <text attributes={TextAttributes.BOLD} marginBottom={1} fg={theme.text}>
              {current().title}
            </text>
          </Show>
          <text fg={theme.text} wrapMode="word" width="100%">
            {current().message}
          </text>
          <box
            width={`${Math.round(remaining() * 100)}%`}
            height={1}
            backgroundColor={theme[current().variant]}
            marginTop={1}
          />
          <Show when={toast.depth > 1}>
            <text fg={theme.textMuted} marginTop={0}>
              [+{toast.depth - 1}]
            </text>
          </Show>
        </box>
      )}
    </Show>
  )
}

let counter = 0

/** @internal exported for unit tests */
export function init() {
  const [store, setStore] = createStore({ queue: [] as ToastItem[] })

  const interval = setInterval(() => {
    const head = store.queue[0]
    if (!head) return
    if (head.created + head.duration < Date.now()) {
      setStore(
        produce((s) => {
          s.queue.shift()
          if (s.queue[0]) s.queue[0].created = Date.now()
        }),
      )
    }
  }, 100)
  if (typeof interval === "object" && "unref" in interval) (interval as NodeJS.Timeout).unref()

  const toast = {
    show(options: ToastOptions) {
      const parsed = TuiEvent.ToastShow.properties.parse(options)
      const item: ToastItem = {
        id: String(Date.now()) + "-" + counter++,
        title: parsed.title,
        message: parsed.message,
        variant: parsed.variant,
        duration: parsed.duration ?? 5000,
        created: Date.now(),
      }
      setStore(
        produce((s) => {
          if (s.queue.length >= MAX_QUEUE) s.queue.shift()
          s.queue.push(item)
        }),
      )
    },
    error(err: any) {
      if (err instanceof Error) return toast.show({ variant: "error", message: err.message })
      toast.show({ variant: "error", message: "An unknown error has occurred" })
    },
    dismissAll() {
      setStore("queue", [])
    },
    get currentToast(): ToastItem | null {
      return store.queue[0] ?? null
    },
    get depth(): number {
      return store.queue.length
    },
  }
  return toast
}

export type ToastContext = ReturnType<typeof init>

const ctx = createContext<ToastContext>()

export function ToastProvider(props: ParentProps) {
  const value = init()
  return <ctx.Provider value={value}>{props.children}</ctx.Provider>
}

export function useToast() {
  const value = useContext(ctx)
  if (!value) {
    throw new Error("useToast must be used within a ToastProvider")
  }
  return value
}
