/**
 * WireDiagnostics — per-session request profiling logger.
 *
 * Writes JSONL to ~/.local/share/opencode/wire-diagnostics/<sessionID>-<unix-ts>.jsonl
 * Gated behind experimental.wire_diagnostics config flag (default false).
 * Fire-and-forget: never throws, never blocks the stream loop.
 */
import fs from "fs/promises"
import path from "path"
import { Global } from "../global"
import type { Config } from "../config/config"

export namespace WireDiagnostics {
  export interface RequestEvent {
    ts: number
    sessionID: string
    modelID: string
    messages: {
      count: number
      byRole: { system: number; user: number; assistant: number; tool: number }
      totalBytes: number
    }
    tools: {
      count: number
      schemaBytes: number
    }
    providerOptions: {
      bytes: number
    }
    response: {
      inputTokens: number
      outputTokens: number
      cacheRead: number
      cacheWrite: number
      durationMs: number
      toolCalls: number
    }
  }

  /** Returns true when wire_diagnostics flag is enabled. */
  export function enabled(cfg: Config.Info): boolean {
    return cfg.experimental?.wire_diagnostics === true
  }

  /** Open a diagnostics handle for a session. Returns undefined when disabled. */
  export function open(sessionID: string, cfg: Config.Info): Handle | undefined {
    if (!enabled(cfg)) return undefined
    return new HandleImpl(sessionID)
  }

  export interface Handle {
    /** Fire-and-forget: appends a JSONL line asynchronously. Never throws. */
    log(event: RequestEvent): void
    close(): void
  }

  class HandleImpl implements Handle {
    private readonly filePath: string
    private _closed = false
    private _errorLogged = false
    private _chain: Promise<void>

    constructor(sessionID: string) {
      const ts = Math.floor(Date.now() / 1000)
      const dir = path.join(Global.Path.data, "wire-diagnostics")
      this.filePath = path.join(dir, `${sessionID}-${ts}.jsonl`)
      this._chain = fs.mkdir(dir, { recursive: true }).then(() => undefined)
    }

    log(event: RequestEvent): void {
      if (this._closed || this._errorLogged) return
      // Chain sequentially so writes preserve call order.
      this._chain = this._chain
        .then(() => {
          if (this._closed || this._errorLogged) return
          return fs.appendFile(this.filePath, JSON.stringify(event) + "\n")
        })
        .catch((err: unknown) => {
          if (!this._errorLogged) {
            this._errorLogged = true
            console.error("[wire-diagnostics] write error (silencing further errors):", err)
          }
        })
    }

    close(): void {
      this._closed = true
    }
  }
}
