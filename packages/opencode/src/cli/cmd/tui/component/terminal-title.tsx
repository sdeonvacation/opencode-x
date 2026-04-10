import { createEffect } from "solid-js"
import { Flag } from "@/flag/flag"
import { Session } from "@/session"

export type TerminalTitleDeps = {
  terminalTitleEnabled: () => boolean
  route: {
    data: { type: "home" } | { type: "session"; sessionID: string } | { type: "plugin"; id: string }
  }
  sync: {
    session: {
      get: (sessionID: string) => { title: string } | undefined
    }
  }
  renderer: {
    setTerminalTitle: (value: string) => void
  }
}

export function useTerminalTitle(deps: TerminalTitleDeps): void {
  createEffect(() => {
    if (!deps.terminalTitleEnabled() || Flag.OPENCODE_DISABLE_TERMINAL_TITLE) return

    if (deps.route.data.type === "home") {
      deps.renderer.setTerminalTitle("OpenCode")
      return
    }

    if (deps.route.data.type === "session") {
      const session = deps.sync.session.get(deps.route.data.sessionID)
      if (!session || Session.isDefaultTitle(session.title)) {
        deps.renderer.setTerminalTitle("OpenCode")
        return
      }

      const title = session.title.length > 40 ? session.title.slice(0, 37) + "..." : session.title
      deps.renderer.setTerminalTitle(`OC | ${title}`)
      return
    }

    if (deps.route.data.type === "plugin") {
      deps.renderer.setTerminalTitle(`OC | ${deps.route.data.id}`)
    }
  })
}
