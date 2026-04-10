import semver from "semver"
import { TuiEvent } from "@tui/event"
import { type KVContext } from "@tui/context/kv"
import { DialogAlert } from "@tui/ui/dialog-alert"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { type DialogContext } from "@tui/ui/dialog"
import { type ToastContext } from "@tui/ui/toast"
import { FormatError, FormatUnknownError } from "@/cli/error"

type AppEvent =
  | {
      type: typeof TuiEvent.CommandExecute.type
      properties: {
        command: string
      }
    }
  | {
      type: typeof TuiEvent.ToastShow.type
      properties: {
        title?: string
        message: string
        variant: "info" | "success" | "warning" | "error"
        duration?: number
      }
    }
  | {
      type: typeof TuiEvent.SessionSelect.type
      properties: {
        sessionID: string
      }
    }
  | {
      type: "session.deleted"
      properties: {
        info: {
          id: string
        }
      }
    }
  | {
      type: "session.error"
      properties: {
        error?: unknown
      }
    }
  | {
      type: "installation.update-available"
      properties: {
        version: string
      }
    }

function errorMessage(error: unknown) {
  const formatted = FormatError(error)
  if (formatted !== undefined) return formatted
  if (
    typeof error === "object" &&
    error !== null &&
    "data" in error &&
    typeof error.data === "object" &&
    error.data !== null &&
    "message" in error.data &&
    typeof error.data.message === "string"
  ) {
    return error.data.message
  }
  return FormatUnknownError(error)
}

export type AppEventListenersDeps = {
  sdk: {
    event: {
      on: <T extends AppEvent["type"]>(
        type: T,
        handler: (evt: Extract<AppEvent, { type: T }>) => void | Promise<void>,
      ) => () => void
    }
    client: {
      global: {
        upgrade: (input: { target: string }) => Promise<{ data?: unknown; error?: unknown }>
      }
    }
  }
  route: {
    data: { type: "home" } | { type: "session"; sessionID: string } | { type: string; sessionID?: string }
    navigate: (route: { type: "home" } | { type: "session"; sessionID: string }) => void
  }
  command: {
    trigger: (command: string) => void
  }
  toast: Pick<ToastContext, "show">
  dialog: DialogContext
  kv: Pick<KVContext, "get" | "set">
  exit: () => void | Promise<void>
}

export function setupAppEventListeners(deps: AppEventListenersDeps): (() => void)[] {
  return [
    deps.sdk.event.on(TuiEvent.CommandExecute.type, (evt) => {
      deps.command.trigger(evt.properties.command)
    }),

    deps.sdk.event.on(TuiEvent.ToastShow.type, (evt) => {
      deps.toast.show({
        title: evt.properties.title,
        message: evt.properties.message,
        variant: evt.properties.variant,
        duration: evt.properties.duration,
      })
    }),

    deps.sdk.event.on(TuiEvent.SessionSelect.type, (evt) => {
      deps.route.navigate({
        type: "session",
        sessionID: evt.properties.sessionID,
      })
    }),

    deps.sdk.event.on("session.deleted", (evt) => {
      if (deps.route.data.type === "session" && deps.route.data.sessionID === evt.properties.info.id) {
        deps.route.navigate({ type: "home" })
        deps.toast.show({
          variant: "info",
          message: "The current session was deleted",
        })
      }
    }),

    deps.sdk.event.on("session.error", (evt) => {
      const error = evt.properties.error
      if (error && typeof error === "object" && "name" in error && error.name === "MessageAbortedError") return
      const message = errorMessage(error)

      deps.toast.show({
        variant: "error",
        message,
        duration: 5000,
      })
    }),

    deps.sdk.event.on("installation.update-available", async (evt) => {
      const version = evt.properties.version

      const skipped = deps.kv.get<string>("skipped_version")
      if (typeof skipped === "string" && !semver.gt(version, skipped)) return

      const choice = await DialogConfirm.show(
        deps.dialog,
        `Update Available`,
        `A new release v${version} is available. Would you like to update now?`,
        "skip",
      )

      if (choice === false) {
        deps.kv.set("skipped_version", version)
        return
      }

      if (choice !== true) return

      deps.toast.show({
        variant: "info",
        message: `Updating to v${version}...`,
        duration: 30000,
      })

      const result = await deps.sdk.client.global.upgrade({ target: version })
      const data = result.data

      if (result.error || !data || typeof data !== "object" || !("success" in data) || data.success !== true) {
        deps.toast.show({
          variant: "error",
          title: "Update Failed",
          message: "Update failed",
          duration: 10000,
        })
        return
      }

      await DialogAlert.show(
        deps.dialog,
        "Update Complete",
        `Successfully updated to OpenCode v${"version" in data && typeof data.version === "string" ? data.version : version}. Please restart the application.`,
      )

      deps.exit()
    }),
  ]
}
