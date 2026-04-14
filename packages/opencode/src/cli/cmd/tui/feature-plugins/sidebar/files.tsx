import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, For, Show, createSignal } from "solid-js"

const id = "internal:sidebar-files"

function sessions(api: TuiPluginApi, sessionID: string) {
  const seen = new Set<string>()
  const walk = (id: string): string[] => {
    if (seen.has(id)) return []
    seen.add(id)
    return [id, ...api.state.session.children(id).flatMap((item) => walk(item.id))]
  }
  return walk(sessionID)
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const files = createMemo(() => {
    const seen = new Set<string>()
    return sessions(props.api, props.session_id)
      .flatMap((id) => props.api.state.session.messages(id))
      .flatMap((msg) => props.api.state.part(msg.id))
      .filter((part) => part.type === "patch")
      .flatMap((part) => part.files)
      .filter((file) => {
        if (seen.has(file)) return false
        seen.add(file)
        return true
      })
      .map((file) => ({
        file,
        additions: 0,
        deletions: 0,
      }))
  })
  const list = createMemo(() => {
    const vcs = props.api.state.vcs?.files
    if (!vcs) return files()
    const modified = new Set(vcs.map((f) => f.file))
    return files().filter((f) => modified.has(f.file))
  })

  return (
    <Show when={list().length > 0}>
      <box>
        <box flexDirection="row" gap={1} onMouseDown={() => list().length > 2 && setOpen((x) => !x)}>
          <Show when={list().length > 2}>
            <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
          </Show>
          <text fg={theme().text}>
            <b>Modified Files</b>
          </text>
        </box>
        <Show when={list().length <= 2 || open()}>
          <For each={list()}>
            {(item) => (
              <box flexDirection="row" gap={1} justifyContent="space-between">
                <text fg={theme().textMuted} wrapMode="word" flexGrow={1}>
                  {item.file}
                </text>
                <box flexDirection="row" gap={1} flexShrink={0}>
                  <Show when={item.additions}>
                    <text fg={theme().diffAdded}>+{item.additions}</text>
                  </Show>
                  <Show when={item.deletions}>
                    <text fg={theme().diffRemoved}>-{item.deletions}</text>
                  </Show>
                </box>
              </box>
            )}
          </For>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 500,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
