import { type CommandOption } from "@tui/component/dialog-command"
import { DialogProvider as DialogProviderList } from "@tui/component/dialog-provider"
import { DialogBtw } from "@tui/component/dialog-btw"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { type DialogContext } from "@tui/ui/dialog"
import { type ToastContext } from "@tui/ui/toast"
import { type JSX } from "solid-js"

export type BtwCommandDeps = {
  dialog: {
    clear: Pick<DialogContext, "clear">["clear"]
    replace: Pick<DialogContext, "replace">["replace"]
  }
  local: {
    model: {
      current: () => { providerID: string; modelID: string } | undefined
    }
  }
  toast: Pick<ToastContext, "show">
  sync: {
    data: {
      provider: Array<{ id: string }>
    }
  }
  sdk: {
    client: {
      session: {
        create: () => Promise<{ data?: { id?: string } }>
        fork: (input: { sessionID: string }) => Promise<{ data?: { id?: string } }>
        complete: (input: {
          sessionID: string
          contextSessionID?: string
          parts: { type: "text"; text: string }[]
          small?: boolean
        }) => Promise<unknown>
        abort: (input: { sessionID: string }) => Promise<unknown>
        delete: (input: { sessionID: string }) => Promise<unknown>
      }
    }
  }
  route: {
    data: { type: "session"; sessionID: string } | { type: string; sessionID?: string }
  }
}

export function createBtwCommand(deps: BtwCommandDeps): CommandOption {
  return {
    title: "By the way",
    value: "btw.ask",
    slash: {
      name: "btw",
    },
    onSelect: async () => {
      const q = await DialogPrompt.show(deps.dialog, "btw", {
        placeholder: "Ask a quick question...",
      })
      if (!q?.trim()) {
        deps.dialog.clear()
        return
      }

      const model = deps.local.model.current()
      if (!model) {
        deps.toast.show({
          variant: "warning",
          message: "Connect a provider to send prompts",
          duration: 3000,
        })
        if (deps.sync.data.provider.length === 0) {
          deps.dialog.replace(() => <DialogProviderList />)
          return
        }
        deps.dialog.clear()
        return
      }

      const contextSessionID = deps.route.data.type === "session" ? deps.route.data.sessionID : undefined
      const res = contextSessionID
        ? await deps.sdk.client.session.fork({ sessionID: contextSessionID })
        : await deps.sdk.client.session.create()
      const sessionID = res.data?.id
      if (!sessionID) {
        deps.toast.show({
          variant: "error",
          message: "Failed to create session",
        })
        deps.dialog.clear()
        return
      }

      deps.sdk.client.session
        .complete({
          sessionID,
          parts: [
            {
              type: "text",
              text: `Answer the following question concisely, in plain text, without using any markdown formatting.\n\n${q}`,
            },
          ],
          small: true,
        })
        .catch(() => {})

      deps.dialog.replace(
        () => <DialogBtw sessionID={sessionID} question={q} />,
        () => {
          deps.sdk.client.session.abort({ sessionID }).catch(() => {})
          deps.sdk.client.session.delete({ sessionID }).catch(() => {})
        },
      )
    },
    category: "Agent",
  }
}
