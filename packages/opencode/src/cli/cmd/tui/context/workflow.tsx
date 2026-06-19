import { createSignal, onCleanup } from "solid-js"
import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"

export type WorkflowStatus = {
  id: string
  name: string
  phase: string
  agent?: string
  prompt?: string
  status: "running" | "waiting" | "completed" | "failed" | "cancelled"
  error?: string
}

export const { use: useWorkflow, provider: WorkflowProvider } = createSimpleContext({
  name: "Workflow",
  init: () => {
    const [runs, setRuns] = createSignal<WorkflowStatus[]>([])
    const sdk = useSDK()

    const unsub = sdk.event.on("event", (event) => {
      const evt = event.payload as { type: string; properties: Record<string, any> }

      if (evt.type === "workflow.started") {
        setRuns((prev) => [
          ...prev.filter((r) => r.id !== evt.properties.runID),
          {
            id: evt.properties.runID,
            name: evt.properties.name,
            phase: "starting",
            status: "running",
          },
        ])
      }

      if (evt.type === "workflow.phase") {
        setRuns((prev) =>
          prev.map((r) =>
            r.id === evt.properties.runID
              ? { ...r, phase: evt.properties.phase, agent: undefined, prompt: undefined, status: "running" }
              : r,
          ),
        )
      }

      if (evt.type === "workflow.waiting") {
        setRuns((prev) => prev.map((r) => (r.id === evt.properties.runID ? { ...r, status: "waiting" } : r)))
      }

      if (evt.type === "workflow.agent-started") {
        setRuns((prev) =>
          prev.map((r) =>
            r.id === evt.properties.runID ? { ...r, agent: evt.properties.agent, prompt: evt.properties.prompt } : r,
          ),
        )
      }

      if (evt.type === "workflow.finished") {
        setRuns((prev) =>
          prev.map((r) =>
            r.id === evt.properties.runID ? { ...r, status: evt.properties.status, error: evt.properties.error } : r,
          ),
        )
        setTimeout(() => {
          setRuns((prev) => prev.filter((r) => r.id !== evt.properties.runID))
        }, 5000)
      }
    })

    onCleanup(unsub)

    return {
      get current() {
        const all = runs()
        return all.find((r) => r.status === "running") ?? all[0] ?? null
      },
      get all() {
        return runs()
      },
    }
  },
})
