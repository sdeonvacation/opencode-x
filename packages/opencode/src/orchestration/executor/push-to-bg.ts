import type { SessionID } from "../../session/schema"
import type { ModelID, ProviderID } from "../../provider/schema"
import { SessionPrompt } from "../../session/prompt"
import { DetachedNotes } from "../../session/detached-notes"
import { Bus } from "../../bus"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { Instance } from "@/project/instance"
import { BackgroundJob } from "@/background/job"
import { makeRuntime } from "@/effect/run-service"
import { Cause, Effect } from "effect"

const bgRuntime = makeRuntime(BackgroundJob.Service, BackgroundJob.defaultLayer)

export type PushChild = {
  childID: SessionID
  description: string
  /** Bare Effect that resolves to the child's text output */
  run: Effect.Effect<string, unknown>
}

export type PushToBackgroundInput = {
  parentSessionID: SessionID
  children: PushChild[]
  model: { providerID: ProviderID; modelID: ModelID }
  agent: string
  variant?: string
  cancelParent: () => Promise<void>
}

export type PushToBackgroundResult = {
  tag: "push_to_background"
  count: number
}

export async function executePushToBackground(input: PushToBackgroundInput): Promise<PushToBackgroundResult> {
  if (input.children.length === 0) return { tag: "push_to_background", count: 0 }

  // Protect all children from cancel cascade
  for (const child of input.children) {
    DetachedNotes.protect(child.childID)
  }

  // Register parent state for tracking
  DetachedNotes.registerParent(
    input.parentSessionID,
    input.children.map((c) => ({ childID: c.childID, description: c.description })),
    input.model,
    input.agent,
    input.variant,
  )

  // Auto-resume callback bound to parent Instance context
  const autoResume = Instance.bind(
    async (parentID: SessionID, childID: SessionID, result: DetachedNotes.ChildResult) => {
      DetachedNotes.unprotect(childID)
      await Bus.publish(TuiEvent.BackgroundTaskUpdate, {
        sessionID: parentID,
        taskID: childID,
        title: result.description,
        state: result.state,
      })
      const outcome = DetachedNotes.childCompleted(parentID, childID, result)
      if (!outcome) return
      if (!outcome.allDone) return

      const lines: string[] = ["[Background subagents completed]", ""]
      for (const r of outcome.results) {
        const tag = r.state === "completed" ? "completed" : r.state === "cancelled" ? "cancelled" : "error"
        const content = r.result ?? r.error ?? "(no output)"
        lines.push(`Task "${r.description}" (${tag}):`)
        lines.push(content)
        lines.push("")
      }
      lines.push("The above are results from subagents that were pushed to background. Process them and continue.")
      const text = lines.join("\n")

      await Bus.publish(TuiEvent.ToastShow, {
        title: "Background subagents complete",
        message: `${outcome.results.length} subagent(s) finished.`,
        variant: "success",
        duration: 5000,
      })

      try {
        await SessionPrompt.prompt({
          sessionID: parentID,
          model: { providerID: input.model.providerID, modelID: input.model.modelID },
          variant: input.variant,
          agent: input.agent,
          parts: [{ type: "text", text, synthetic: true }],
        })
      } catch {
        DetachedNotes.queue(parentID, "completed", text)
      }
    },
  )

  // Wrap each child's bare run with autoResume tap/catchCause and start BackgroundJob
  for (const child of input.children) {
    const wrapped = child.run.pipe(
      Effect.tap((summary: string) =>
        Effect.promise(() =>
          autoResume(input.parentSessionID, child.childID, {
            childID: child.childID,
            description: child.description,
            result: summary,
            state: "completed",
          }),
        ),
      ),
      Effect.catchCause((cause: Cause.Cause<any>) => {
        const squashed = Cause.squash(cause)
        const cancelled = squashed && (squashed as any)._tag === "RunnerCancelled"
        return Effect.promise(() =>
          autoResume(input.parentSessionID, child.childID, {
            childID: child.childID,
            description: child.description,
            error: cancelled ? "cancelled" : String(squashed),
            state: cancelled ? "cancelled" : "error",
          }),
        ).pipe(Effect.as(""))
      }),
    )

    await bgRuntime.runPromise((svc) =>
      svc.start({
        id: child.childID,
        type: "session.background",
        title: child.description,
        metadata: { sessionID: input.parentSessionID, childID: child.childID },
        run: wrapped,
      }),
    )
  }

  // Publish "running" events for badge counter
  for (const child of input.children) {
    await Bus.publish(TuiEvent.BackgroundTaskUpdate, {
      sessionID: input.parentSessionID,
      taskID: child.childID,
      title: child.description,
      state: "running",
    })
  }

  // Cancel parent's run (children are protected)
  await input.cancelParent()

  await Bus.publish(TuiEvent.ToastShow, {
    title: "Detached to background",
    message: `${input.children.length} subagent(s) running in background.`,
    variant: "info",
    duration: 5000,
  })

  return { tag: "push_to_background", count: input.children.length }
}
