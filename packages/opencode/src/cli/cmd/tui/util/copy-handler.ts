import { Clipboard } from "@tui/util/clipboard"
import { Selection } from "@tui/util/selection"
import { type ToastContext } from "@tui/ui/toast"
import { MouseButton } from "@opentui/core"
import { Flag } from "@/flag/flag"

export type CopyHandlerDeps = {
  renderer: {
    console: {
      onCopySelection?: (text: string) => Promise<void> | void
    }
    getSelection: () =>
      | {
          selectedRenderables: unknown[]
        }
      | null
      | undefined
    currentFocusedRenderable?: {
      hasSelection: () => boolean
    } | null
    clearSelection: () => void
  }
  toast: Pick<ToastContext, "show" | "error">
}

export function setupCopySelectionHandlers(
  deps: CopyHandlerDeps,
  register: (
    handler: (evt: { ctrl?: boolean; name: string; preventDefault: () => void; stopPropagation: () => void }) => void,
  ) => void,
) {
  const { renderer, toast } = deps
  register((evt) => {
    if (!Flag.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) return
    const sel = renderer.getSelection()
    if (!sel) return

    if (evt.ctrl && evt.name === "c") {
      if (!Selection.copy(renderer as never, toast)) {
        renderer.clearSelection()
        return
      }

      evt.preventDefault()
      evt.stopPropagation()
      return
    }

    if (evt.name === "escape") {
      renderer.clearSelection()
      evt.preventDefault()
      evt.stopPropagation()
      return
    }

    const focus = renderer.currentFocusedRenderable
    if (focus?.hasSelection() && sel.selectedRenderables.includes(focus)) {
      return
    }

    renderer.clearSelection()
  })

  return {
    onMouseDown(evt: { button: number; preventDefault: () => void; stopPropagation: () => void }) {
      if (!Flag.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT) return
      if (evt.button !== MouseButton.RIGHT) return
      if (!Selection.copy(renderer as never, toast)) return
      evt.preventDefault()
      evt.stopPropagation()
    },
    onMouseUp: Flag.OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT
      ? undefined
      : () => Selection.copy(renderer as never, toast),
  }
}

export function setupConsoleCopyHandler(deps: CopyHandlerDeps): void {
  const { renderer, toast } = deps
  renderer.console.onCopySelection = async (text: string) => {
    if (!text || text.length === 0) return

    await Clipboard.copy(text)
      .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
      .catch(toast.error)

    renderer.clearSelection()
  }
}
