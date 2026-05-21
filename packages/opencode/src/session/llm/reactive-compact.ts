// [fork-perf] Phase 5: reactive compaction — detect 413/overflow and compact inline
import { Effect } from "effect"
import { SlidingWindow } from "@/session/sliding-window"
import type { Config } from "@/config/config"
import type { Provider } from "@/provider/provider"
import type { MessageV2 } from "@/session/message-v2"
import type { Agent } from "@/agent/agent"
import type { SessionID } from "@/session/schema"

export namespace ReactiveCompact {
  /**
   * Detects a provider 413 / context-overflow error.
   * Matches HTTP 413, "context length", "too large", or the upstream
   * MessageV2.ContextOverflowError shape.
   */
  export function isOverflow(err: unknown): boolean {
    if (!err) return false
    // [fork-perf] upstream ContextOverflowError or isOverflow flag
    if (typeof (err as any).isContextOverflow === "boolean" && (err as any).isContextOverflow) return true
    if ((err as any)._tag === "ContextOverflowError") return true
    const msg = String((err as any)?.message ?? err).toLowerCase()
    // [fork-perf] provider-level 413 / context-too-large signals
    if ((err as any)?.status === 413) return true
    if ((err as any)?.statusCode === 413) return true
    if (msg.includes("context length")) return true
    if (msg.includes("too large")) return true
    if (msg.includes("maximum context")) return true
    if (msg.includes("context window")) return true
    if (msg.includes("context_length_exceeded")) return true
    if (msg.includes("prompt is too long")) return true
    return false
  }

  export interface HandleInput {
    msgs: MessageV2.WithParts[]
    model: Provider.Model
    provider: Provider.Interface
    cfg: Config.Info
    sessionID: SessionID
    agent: Agent.Info
  }

  export interface HandleResult {
    messages: MessageV2.WithParts[]
    retry: true
  }

  /**
   * Compact the conversation history and return a retry plan.
   * Runs SlidingWindow.compact synchronously (awaited) with a hint that
   * forces the threshold.
   */
  export const handle = (input: HandleInput): Effect.Effect<HandleResult> =>
    Effect.gen(function* () {
      // [fork-perf] force compact by passing hint = threshold to bypass cheap-estimate check
      const opts = input.cfg.compaction?.sliding_window
      const threshold = opts?.threshold ?? 50_000
      const compacted = yield* SlidingWindow.compact({
        msgs: input.msgs,
        model: input.model,
        provider: input.provider,
        cfg: input.cfg,
        sessionID: input.sessionID,
        agent: { name: input.agent.name, mode: input.agent.mode ?? "primary" },
        hint: threshold + 1, // force past threshold check
      })
      return { messages: compacted, retry: true as const }
    })
}
