import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "./dialog"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"

export type DialogAlertProps = {
  title: string
  message: string
  markdown?: boolean
  onConfirm?: () => void
}

export function DialogAlert(props: DialogAlertProps) {
  const dialog = useDialog()
  const { theme, syntax } = useTheme()
  const dimensions = useTerminalDimensions()

  useKeyboard((evt) => {
    if (evt.name === "return") {
      props.onConfirm?.()
      dialog.clear()
    }
  })
  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box paddingBottom={1}>
        {props.markdown ? (
          <scrollbox height={Math.min(dimensions().height - 8, 9999)}>
            <markdown
              content={props.message}
              syntaxStyle={syntax()}
              tableOptions={{ style: "grid" }}
              fg={theme.markdownText}
              bg={theme.background}
            />
          </scrollbox>
        ) : (
          <text fg={theme.textMuted}>{props.message}</text>
        )}
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <box
          paddingLeft={3}
          paddingRight={3}
          backgroundColor={theme.primary}
          onMouseUp={() => {
            props.onConfirm?.()
            dialog.clear()
          }}
        >
          <text fg={theme.selectedListItemText}>ok</text>
        </box>
      </box>
    </box>
  )
}

DialogAlert.show = (dialog: DialogContext, title: string, message: string, markdown?: boolean) => {
  return new Promise<void>((resolve) => {
    dialog.replace(
      () => <DialogAlert title={title} message={message} markdown={markdown} onConfirm={() => resolve()} />,
      () => resolve(),
    )
  })
}
