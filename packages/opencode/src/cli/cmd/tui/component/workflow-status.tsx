import { Show } from "solid-js"
import { useWorkflow } from "../context/workflow"
import { useTheme } from "../context/theme"

export function WorkflowStatus() {
  const workflow = useWorkflow()
  const { theme } = useTheme()

  return (
    <Show when={workflow.current}>
      {(s) => (
        <box flexDirection="row" gap={1} flexShrink={0}>
          <text fg={theme.textMuted}>
            <span style={{ fg: theme.accent }}>⚡</span> {s().name}
            {s().agent ? `: running "${s().agent}"` : s().status === "waiting" ? ": waiting…" : `: ${s().phase}`}
            {s().prompt ? ` — ${s().prompt!.slice(0, 50)}${s().prompt!.length > 50 ? "…" : ""}` : ""}
            {s().status !== "running" ? ` [${s().status}]` : ""}
            <Show when={s().error}>
              <span style={{ fg: theme.error }}> — {s().error}</span>
            </Show>
          </text>
        </box>
      )}
    </Show>
  )
}
