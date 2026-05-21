/**
 * CacheDebugLog — per-session, per-turn cache-behavior debug logger.
 *
 * Writes JSONL to ~/.local/share/opencode/cache-debug/<sessionID>-<unix-ts>.jsonl
 * Gated behind experimental.cache_debug_log config flag (default false).
 * Fire-and-forget: never throws, never blocks the stream loop.
 */
import fs from "fs/promises"
import path from "path"
import { Global } from "../global"
import type { Config } from "../config/config"

export namespace CacheDebugLog {
  /** Token counts for one LLM call (from streamText.usage). */
  export interface TokenCounts {
    input: number
    cacheRead: number
    cacheWrite: number
    output: number
  }

  /** Delta of token counts vs the prior turn (positive = added, negative = pruned). */
  export interface TokenDelta {
    input: number
    cacheRead: number
    cacheWrite: number
    output: number
  }

  /** Active feature flags relevant to caching. */
  export interface CacheFlags {
    history_cache?: boolean
    transform_cache?: boolean
    cache_sliding_window?: boolean
    prompt_split_caching?: boolean
    proactive_prune?: boolean
    microcompact?: boolean
    context_collapse?: boolean
    tool_result_budget?: boolean | number
  }

  /** One LLM call event logged before each llm.stream() invocation. */
  export interface TurnEvent {
    type: "turn"
    sessionID: string
    turn: number
    tokens: TokenCounts
    tokenDelta: TokenDelta
    /** First 8 chars of djb2 hash of joined system messages. Logged only when changed. */
    systemHash?: string
    /** First 8 chars of djb2 hash of sorted tool ids. Logged only when changed. */
    toolsHash?: string
    /** djb2 hash of MessageV2.msgsFingerprint(msgs). Logged only when changed. */
    msgsHash?: string
    flags: CacheFlags
    provider: string
    model: string
    ts: number
  }

  /** One pruning/compaction event. */
  export interface PruneEvent {
    type: "prune"
    sessionID: string
    /** Name of the compaction activity. */
    event:
      | "prune"
      | "sliding-window-compact"
      | "microcompact"
      | "context-collapse"
      | "tool-budget"
      | "compaction-process"
    msgsLenBefore: number
    msgsLenAfter: number
    msgsFingerprintBefore: string
    msgsFingerprintAfter: string
    /** Whether a history-cache invalidation was fired. */
    historyCacheInvalidated: boolean
    /** Cheap token estimate: sum of all text/tool content lengths. */
    tokenEstimate: number
    ts: number
  }

  export type Event = TurnEvent | PruneEvent

  /** Returns true when cache_debug_log flag is enabled. */
  export function enabled(cfg: Config.Info): boolean {
    return cfg.experimental?.cache_debug_log === true
  }

  /** Open a debug log handle for a session. Returns undefined when disabled. */
  export function open(sessionID: string, cfg: Config.Info): Handle | undefined {
    if (!enabled(cfg)) return undefined
    return new HandleImpl(sessionID)
  }

  export interface Handle {
    /** Fire-and-forget: appends a JSONL line asynchronously. Never throws. */
    log(event: Event): void
    close(): void
  }

  class HandleImpl implements Handle {
    private readonly filePath: string
    private _closed = false
    private _errorLogged = false
    private _dirReady: Promise<void>

    constructor(sessionID: string) {
      const ts = Math.floor(Date.now() / 1000)
      const dir = path.join(Global.Path.data, "cache-debug")
      this.filePath = path.join(dir, `${sessionID}-${ts}.jsonl`)
      this._dirReady = fs.mkdir(dir, { recursive: true }).then(() => undefined)
    }

    log(event: Event): void {
      if (this._closed || this._errorLogged) return
      // Fire-and-forget: chain onto the dir-ready promise so mkdir completes first.
      this._dirReady
        .then(() => {
          if (this._closed || this._errorLogged) return
          return fs.appendFile(this.filePath, JSON.stringify(event) + "\n")
        })
        .catch((err: unknown) => {
          if (!this._errorLogged) {
            this._errorLogged = true
            console.error("[cache-debug-log] write error (silencing further errors):", err)
          }
        })
    }

    close(): void {
      this._closed = true
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /**
   * djb2 hash of an arbitrary string. Returns first `len` hex characters.
   * Pure function, no deps.
   */
  export function djb2(s: string, len = 8): string {
    let h = 5381
    for (let i = 0; i < s.length; i++) {
      h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0
    }
    return h.toString(16).padStart(8, "0").slice(0, len)
  }

  /** Compute system prompt hash from array of system strings. */
  export function systemHash(system: string[]): string {
    return djb2(system.join(""))
  }

  /** Compute tools hash from sorted tool ids. */
  export function toolsHash(toolIds: string[]): string {
    return djb2([...toolIds].sort().join(","))
  }

  /** Cheap token estimate: total char length of all text/tool content. */
  export function cheapTokenEstimate(msgs: Array<{ parts: Array<{ type: string; [k: string]: unknown }> }>): number {
    let total = 0
    for (const msg of msgs) {
      for (const part of msg.parts) {
        if (part.type === "text" && typeof (part as any).text === "string") {
          total += ((part as any).text as string).length
        } else if (part.type === "tool") {
          const state = (part as any).state
          if (state && typeof state.output === "string") total += state.output.length
          if (state && typeof state.input === "object") total += JSON.stringify(state.input).length
        }
      }
    }
    // rough approximation: 4 chars per token
    return Math.ceil(total / 4)
  }

  /** Extract CacheFlags from a config object. */
  export function extractFlags(cfg: Config.Info): CacheFlags {
    const e = cfg.experimental ?? {}
    return {
      history_cache: e.history_cache,
      transform_cache: e.transform_cache,
      cache_sliding_window: (e as any).cache_sliding_window,
      prompt_split_caching: (e as any).prompt_split_caching,
      proactive_prune: e.proactive_prune,
      microcompact: e.microcompact,
      context_collapse: e.context_collapse,
      tool_result_budget: e.tool_result_budget,
    }
  }
}
