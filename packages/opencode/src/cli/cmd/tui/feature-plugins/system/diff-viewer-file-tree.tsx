import { createMemo, For, Show } from "solid-js"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { type FileEntry, type TreeNode, status, flatten, filename } from "./diff-viewer-file-tree-utils"

export function FileTree(props: {
  api: TuiPluginApi
  tree: TreeNode
  files: FileEntry[]
  selected: number
  focused: boolean
  width: number
}) {
  const theme = () => props.api.theme.current
  const flat = createMemo(() => flatten(props.tree))

  return (
    <box
      width={props.width}
      borderStyle="single"
      borderColor={props.focused ? theme().borderActive : theme().borderSubtle}
      flexShrink={0}
    >
      <box paddingLeft={1} paddingRight={1}>
        <text fg={theme().text}>
          <b>Files</b> <span style={{ fg: theme().textMuted }}>({props.files.length})</span>
        </text>
      </box>
      <scrollbox height="100%">
        <For each={flat()}>
          {(entry, idx) => {
            const active = () => idx() === props.selected
            const st = status(entry)
            const color = () => (st === "A" ? theme().diffAdded : st === "D" ? theme().diffRemoved : theme().text)
            return (
              <box
                flexDirection="row"
                gap={1}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={active() ? theme().backgroundElement : undefined}
              >
                <text fg={color()} flexShrink={0}>
                  {st}
                </text>
                <text fg={active() ? theme().text : theme().textMuted} flexGrow={1} wrapMode="char">
                  {filename(entry.file)}
                </text>
                <Show when={entry.additions > 0}>
                  <text fg={theme().diffAdded} flexShrink={0}>
                    +{entry.additions}
                  </text>
                </Show>
                <Show when={entry.deletions > 0}>
                  <text fg={theme().diffRemoved} flexShrink={0}>
                    -{entry.deletions}
                  </text>
                </Show>
              </box>
            )
          }}
        </For>
      </scrollbox>
    </box>
  )
}
