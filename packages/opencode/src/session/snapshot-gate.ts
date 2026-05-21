// [fork-perf] Phase 4: snapshot gate — skip track/patch when no FS-mutating tool fired
import { Effect } from "effect"
import type { Snapshot } from "@/snapshot"

export namespace SnapshotGate {
  /** Tools that mutate the filesystem and therefore require a snapshot diff. */
  export const FS_TOOLS = new Set(["edit", "write", "bash", "patch", "multiedit"])

  /**
   * Minimal context shape required by the gate. Processor passes its full
   * ProcessorContext; tests may pass a plain object.
   */
  export interface RunStateLike {
    /** Set to true the first time an FS-mutating tool fires in this step. */
    fsToolFired: boolean
    /** Snapshot hash recorded by the last successful track() call. */
    lastSnapshotAt?: string
    /** Current snapshot hash (set by processor from snapshot.track()). */
    snapshot: string | undefined
  }

  /**
   * Call this in `case "tool-call"` for every tool invocation.
   * Sets fsToolFired if the tool name is in FS_TOOLS.
   */
  export const onToolCall = (ctx: RunStateLike, toolName: string): void => {
    // [fork-perf] mark FS mutation so track/patch fire on this step
    if (FS_TOOLS.has(toolName)) {
      ctx.fsToolFired = true
    }
  }

  /**
   * Gated snapshot.track().
   * When enabled: only call track() if an FS tool fired since last track, or
   * if no snapshot exists yet (first track in a session).
   * When disabled (flag=false): always delegate to snapshot.track().
   */
  export const track = (
    ctx: RunStateLike,
    snapshot: Snapshot.Interface,
    enabled: boolean,
  ): Effect.Effect<string | undefined> => {
    // [fork-perf] identity fall-through when flag is off
    if (!enabled) return snapshot.track()
    // Always track if no snapshot exists yet (first step of session)
    if (!ctx.snapshot) return snapshot.track()
    // Skip if no FS tool has fired since last snapshot
    if (!ctx.fsToolFired) return Effect.succeed(ctx.snapshot)
    return snapshot.track()
  }

  /**
   * Gated snapshot.patch().
   * When enabled: return undefined (skip patch) if no FS tool fired since the
   * last successful patch. Resets fsToolFired after a successful patch.
   * When disabled (flag=false): always delegate to snapshot.patch().
   */
  export const patch = (
    ctx: RunStateLike,
    snapshot: Snapshot.Interface,
    enabled: boolean,
  ): Effect.Effect<Snapshot.Patch | undefined> => {
    // [fork-perf] identity fall-through when flag is off
    if (!enabled) {
      if (!ctx.snapshot) return Effect.succeed(undefined)
      return snapshot.patch(ctx.snapshot)
    }
    // Skip patch when no FS mutation happened
    if (!ctx.fsToolFired) return Effect.succeed(undefined)
    if (!ctx.snapshot) return Effect.succeed(undefined)
    const snap = ctx.snapshot
    return snapshot.patch(snap).pipe(
      Effect.map((result) => {
        // [fork-perf] reset so next step starts clean
        ctx.fsToolFired = false
        return result
      }),
    )
  }
}
