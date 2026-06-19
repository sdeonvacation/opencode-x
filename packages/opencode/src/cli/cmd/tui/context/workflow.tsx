import { createSignal, onCleanup } from "solid-js"
import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"

export type WorkflowStatus = {
  id: string
  name: string
  phase: string
  status: "running" | "completed" | "failed" | "cancelled"
  error?: string
}

export const { use: useWorkflow, provider: WorkflowProvider } = createSimpleContext({
  name: "Workflow",
  init: () => {
    const [status, setStatus] = createSignal<WorkflowStatus | null>(null)
    const sdk = useSDK()
    let timer: Timer | undefined

    // Subscribe to raw event stream — workflow events aren't in the SDK Event union yet
    const unsub = sdk.event.on("event", (event) => {
      const evt = event.payload as { type: string; properties: Record<string, any> }

      if (evt.type === "workflow.started") {
        if (timer) clearTimeout(timer)
        timer = undefined
        setStatus({
          id: evt.properties.runID,
          name: evt.properties.name,
          phase: "starting",
          status: "running",
        })
      }

      if (evt.type === "workflow.phase") {
        setStatus((prev) => {
          if (!prev || prev.id !== evt.properties.runID) return prev
          return { ...prev, phase: evt.properties.phase }
        })
      }

      if (evt.type === "workflow.finished") {
        setStatus((prev) => {
          if (!prev || prev.id !== evt.properties.runID) return prev
          return { ...prev, status: evt.properties.status, error: evt.properties.error }
        })
        timer = setTimeout(() => setStatus(null), 5000)
      }
    })

    onCleanup(() => {
      unsub()
      if (timer) clearTimeout(timer)
    })

    return {
      get current() {
        return status()
      },
    }
  },
})
