import { createSignal, createMemo, createResource, Show, Switch, Match } from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiKeybindSet } from "@opencode-ai/plugin/tui"
import { FileTree } from "./diff-viewer-file-tree"
import { type FileEntry, build, flatten } from "./diff-viewer-file-tree-utils"

const id = "internal:diff-viewer"

const KV_TREE = "diff-viewer.tree-visible"
const KV_SOURCE = "diff-viewer.source"

type Source = "working" | "session"

function Viewer(props: { api: TuiPluginApi; keys: TuiKeybindSet; params?: Record<string, unknown> }) {
  const theme = () => props.api.theme.current
  const size = useTerminalDimensions()
  const returnTo = props.params?._returnTo as { name: string; params?: Record<string, unknown> } | undefined

  const [source, setSource] = createSignal<Source>(props.api.kv.get(KV_SOURCE, "working") as Source)
  const [tree, setTree] = createSignal(props.api.kv.get(KV_TREE, true) as boolean)
  const [selected, setSelected] = createSignal(0)
  const [focus, setFocus] = createSignal<"tree" | "diff">("tree")

  const sessionID = () => props.params?.sessionID as string | undefined
  const messageID = () => props.params?.messageID as string | undefined

  const [files] = createResource(source, async (src) => {
    if (src === "session") {
      const sid = sessionID()
      if (!sid) return []
      const res = await props.api.client.session.diff({ sessionID: sid, messageID: messageID() })
      if (!res.data) return []
      return (res.data as FileEntry[]).map((f) => ({
        ...f,
        status: f.status ?? "modified",
      }))
    }
    const res = await props.api.client.vcs.diff({ mode: "git" })
    if (!res.data) return []
    return (res.data as FileEntry[]).map((f) => ({
      ...f,
      status: f.status ?? "modified",
    }))
  })

  const entries = createMemo(() => files() ?? [])
  const treeData = createMemo(() => build(entries()))
  const flat = createMemo(() => flatten(treeData()))
  const current = createMemo(() => flat()[selected()])
  const patch = createMemo(() => current()?.patch ?? "")
  const treeWidth = () => Math.min(Math.max(Math.floor(size().width * 0.25), 24), 40)

  const clamp = (idx: number) => Math.max(0, Math.min(idx, flat().length - 1))

  const toggle = () => {
    const next = !tree()
    setTree(next)
    props.api.kv.set(KV_TREE, next)
  }

  const swap = () => {
    const next: Source = source() === "working" ? "session" : "working"
    setSource(next)
    setSelected(0)
    props.api.kv.set(KV_SOURCE, next)
  }

  useKeyboard((evt) => {
    if (props.api.route.current.name !== "diff-viewer") return

    if (props.keys.match("close", evt)) {
      evt.preventDefault()
      evt.stopPropagation()
      if (returnTo) props.api.route.navigate(returnTo.name, returnTo.params)
      else props.api.route.navigate("home", {})
      return
    }

    if (props.keys.match("toggle_tree", evt)) {
      evt.preventDefault()
      toggle()
      return
    }

    if (props.keys.match("switch_source", evt)) {
      evt.preventDefault()
      swap()
      return
    }

    if (props.keys.match("switch_focus", evt)) {
      evt.preventDefault()
      setFocus((f) => (f === "tree" ? "diff" : "tree"))
      return
    }

    if (props.keys.match("next_file", evt)) {
      evt.preventDefault()
      setSelected((i) => clamp(i + 1))
      return
    }

    if (props.keys.match("prev_file", evt)) {
      evt.preventDefault()
      setSelected((i) => clamp(i - 1))
      return
    }

    if (focus() === "tree") {
      if (props.keys.match("down", evt)) {
        evt.preventDefault()
        setSelected((i) => clamp(i + 1))
        return
      }
      if (props.keys.match("up", evt)) {
        evt.preventDefault()
        setSelected((i) => clamp(i - 1))
        return
      }
    }
  })

  return (
    <box width="100%" height="100%" flexDirection="column">
      {/* Header */}
      <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
        <text fg={theme().text}>
          <b>Diff Viewer</b>{" "}
          <span style={{ fg: theme().textMuted }}>[{source() === "working" ? "Working Tree" : "Session"}]</span>
        </text>
        <text fg={theme().textMuted}>
          {props.keys.print("switch_source")}:source {props.keys.print("toggle_tree")}:tree {props.keys.print("close")}
          :close
        </text>
      </box>

      {/* Body */}
      <box flexDirection="row" flexGrow={1} height="100%">
        <Show when={tree() && entries().length > 0}>
          <FileTree
            api={props.api}
            tree={treeData()}
            files={entries()}
            selected={selected()}
            focused={focus() === "tree"}
            width={treeWidth()}
          />
        </Show>

        {/* Diff pane */}
        <box
          flexGrow={1}
          borderStyle="single"
          borderColor={focus() === "diff" ? theme().borderActive : theme().borderSubtle}
        >
          <Switch>
            <Match when={files.loading}>
              <box paddingLeft={1}>
                <text fg={theme().textMuted}>Loading diff...</text>
              </box>
            </Match>
            <Match when={entries().length === 0}>
              <box paddingLeft={1}>
                <text fg={theme().textMuted}>No changes found.</text>
              </box>
            </Match>
            <Match when={patch()}>
              <box paddingLeft={1} flexGrow={1}>
                <box flexDirection="row" gap={1} paddingBottom={0}>
                  <text fg={theme().text}>
                    <b>{current()?.file}</b>
                  </text>
                </box>
                <scrollbox height="100%" flexGrow={1}>
                  <diff
                    diff={patch()}
                    view="unified"
                    showLineNumbers={true}
                    width="100%"
                    fg={theme().text}
                    addedBg={theme().diffAddedBg}
                    removedBg={theme().diffRemovedBg}
                    contextBg={theme().diffContextBg}
                    addedSignColor={theme().diffHighlightAdded}
                    removedSignColor={theme().diffHighlightRemoved}
                    lineNumberFg={theme().diffLineNumber}
                    lineNumberBg={theme().diffContextBg}
                    addedLineNumberBg={theme().diffAddedLineNumberBg}
                    removedLineNumberBg={theme().diffRemovedLineNumberBg}
                  />
                </scrollbox>
              </box>
            </Match>
          </Switch>
        </box>
      </box>

      {/* Footer */}
      <box flexDirection="row" gap={2} paddingLeft={1}>
        <text fg={theme().textMuted}>
          {props.keys.print("down")}/{props.keys.print("up")}:navigate {props.keys.print("next_file")}/
          {props.keys.print("prev_file")}:file {props.keys.print("switch_focus")}:focus
        </text>
      </box>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  const keys = api.keybind.create({
    close: "q,escape",
    down: "j,down",
    up: "k,up",
    page_down: "ctrl+f,pagedown",
    page_up: "ctrl+b,pageup",
    next_file: "n,]",
    prev_file: "shift+n,[",
    toggle_tree: "t",
    switch_focus: "tab",
    switch_source: "s",
  })

  api.route.register([
    {
      name: "diff-viewer",
      render: (input) => <Viewer api={api} keys={keys} params={input.params} />,
    },
  ])

  api.command.register(() => [
    {
      title: "Open Diff Viewer",
      value: "diff-viewer.open",
      category: "System",
      onSelect() {
        const current = api.route.current
        const returnTo =
          current.name !== "diff-viewer"
            ? { name: current.name, params: "params" in current ? current.params : undefined }
            : undefined
        api.route.navigate("diff-viewer", { ...(returnTo ? { _returnTo: returnTo } : {}) })
      },
    },
  ])
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
