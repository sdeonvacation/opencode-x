import { readdirSync, readFileSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import z from "zod"
import { isRecord } from "@/util/record"
import { createSimpleContext } from "./helper"
import { resolveZedDbPath, resolveZedSelection } from "./editor-zed"

const MCP_PROTOCOL_VERSION = "2025-11-25"

const JsonRpcMessageSchema = z.object({
  id: z.union([z.number(), z.string(), z.null()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number().optional(),
      message: z.string().optional(),
    })
    .optional(),
})

const PositionSchema = z.object({
  line: z.number(),
  character: z.number(),
})

const EditorSelectionSchema = z.object({
  text: z.string(),
  filePath: z.string(),
  selection: z.object({
    start: PositionSchema,
    end: PositionSchema,
  }),
})

const EditorMentionSchema = z.object({
  filePath: z.string(),
  lineStart: z.number(),
  lineEnd: z.number(),
})

const EditorServerInfoSchema = z.object({
  protocolVersion: z.string().optional(),
  serverInfo: z
    .object({
      name: z.string().optional(),
      version: z.string().optional(),
    })
    .optional(),
})

type JsonRpcMessage = z.infer<typeof JsonRpcMessageSchema>
export type EditorSelection = z.infer<typeof EditorSelectionSchema>
export type EditorMention = z.infer<typeof EditorMentionSchema>
type EditorServerInfo = z.infer<typeof EditorServerInfoSchema>

type EditorConnection = {
  url: string
  authToken?: string
  source: string
}

type EditorLockFile = {
  port: number
  authToken?: string
  transport?: string
  workspaceFolders: string[]
  mtimeMs: number
}

export const { use: useEditorContext, provider: EditorContextProvider } = createSimpleContext({
  name: "EditorContext",
  init: () => {
    const mentions = new Set<(mention: EditorMention) => void>()
    const [store, setStore] = createStore<{
      status: "disabled" | "connecting" | "connected"
      selection: EditorSelection | undefined
      server: EditorServerInfo | undefined
    }>({
      status: "disabled",
      selection: undefined,
      server: undefined,
    })

    onMount(() => {
      let socket: WebSocket | undefined
      let closed = false
      let reconnect: ReturnType<typeof setTimeout> | undefined
      let attempt = 0
      let requestID = 0
      let zed: Promise<void> | undefined
      let lastZed: string | undefined
      const pending = new Map<number, string>()

      const send = (payload: JsonRpcMessage) => {
        if (!socket || socket.readyState !== WebSocket.OPEN) return
        socket.send(JSON.stringify({ jsonrpc: "2.0", ...payload }))
      }

      const request = (method: string, params?: unknown) => {
        requestID += 1
        pending.set(requestID, method)
        send({ id: requestID, method, params })
      }

      const scheduleReconnect = () => {
        if (closed) return
        if (reconnect) clearTimeout(reconnect)
        attempt += 1
        const delay = Math.min(1000 * 2 ** (attempt - 1), 10_000)
        reconnect = setTimeout(connect, delay)
      }

      const connect = () => {
        if (closed) return

        const connection = resolveEditorConnection()
        if (!connection) {
          const dbPath = resolveZedDbPath()
          if (!dbPath) {
            setStore("status", "disabled")
            scheduleReconnect()
            return
          }
          zed ??= resolveZedSelection(dbPath)
            .then((selection) => {
              if (closed || socket) return
              const key = editorSelectionKey(selection)
              if (key !== lastZed) {
                lastZed = key
                setStore("selection", selection)
                setStore("status", selection ? "connected" : "disabled")
              }
            })
            .catch(() => {
              if (closed || socket) return
              setStore("status", "disabled")
            })
            .finally(() => {
              zed = undefined
            })
          scheduleReconnect()
          return
        }

        setStore("status", "connecting")
        const current = openEditorSocket(connection)
        socket = current

        current.addEventListener("open", () => {
          if (socket !== current) {
            current.close()
            return
          }

          attempt = 0
          setStore("status", "connected")
          request("initialize", {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "opencode", version: "0.0.0" },
          })
        })

        current.addEventListener("message", (event) => {
          const message = parseMessage(event.data)
          if (!message) return

          const selection =
            message.method === "selection_changed" ? EditorSelectionSchema.safeParse(message.params) : undefined
          if (selection?.success) {
            setStore("selection", selection.data)
            return
          }

          const mention = message.method === "at_mentioned" ? EditorMentionSchema.safeParse(message.params) : undefined
          if (mention?.success) {
            mentions.forEach((listener) => listener(mention.data))
            return
          }

          if (typeof message.id !== "number") return
          const method = pending.get(message.id)
          if (!method) return
          pending.delete(message.id)
          if (message.error) return

          const initialize = method === "initialize" ? EditorServerInfoSchema.safeParse(message.result) : undefined
          if (initialize?.success) {
            setStore("server", initialize.data)
            send({ method: "notifications/initialized" })
          }
        })

        current.addEventListener("close", () => {
          if (socket !== current) return

          socket = undefined
          pending.clear()
          if (closed) return

          setStore("status", "connecting")
          scheduleReconnect()
        })
      }

      connect()

      onCleanup(() => {
        closed = true
        if (reconnect) clearTimeout(reconnect)
        socket?.close()
      })
    })

    return {
      enabled() {
        return Boolean(resolveEditorConnection() || resolveZedDbPath())
      },
      connected() {
        return store.status === "connected"
      },
      selection() {
        return store.selection
      },
      clearSelection() {
        setStore("selection", undefined)
      },
      onMention(listener: (mention: EditorMention) => void) {
        mentions.add(listener)
        return () => mentions.delete(listener)
      },
      server() {
        return store.server
      },
    }
  },
})

function parsePort(value: string | undefined) {
  if (!value) return
  const port = Number.parseInt(value, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return
  return port
}

function resolveEditorConnection(): EditorConnection | undefined {
  const port = parsePort(process.env.CLAUDE_CODE_SSE_PORT || process.env.OPENCODE_EDITOR_SSE_PORT)
  if (port) {
    return {
      url: `ws://127.0.0.1:${port}`,
      source: "env",
    }
  }

  const lock = resolveEditorLockFile()
  if (!lock) return
  return {
    url: `ws://127.0.0.1:${lock.port}`,
    authToken: lock.authToken,
    source: "lockfile",
  }
}

function resolveEditorLockFile() {
  const dir = path.join(os.homedir(), ".claude", "ide")
  try {
    return readdirSync(dir)
      .filter((entry) => entry.endsWith(".lock"))
      .flatMap((entry) => {
        const lock = readEditorLockFile(path.join(dir, entry))
        return lock ? [lock] : []
      })
      .sort((left, right) => scoreEditorLock(right, process.cwd()) - scoreEditorLock(left, process.cwd()))[0]
  } catch {
    return
  }
}

function readEditorLockFile(filePath: string): EditorLockFile | undefined {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown
    if (!isRecord(parsed)) return
    if (parsed.transport !== undefined && parsed.transport !== "ws") return

    const port = parsePort(
      typeof parsed.port === "string" ? parsed.port : typeof parsed.port === "number" ? String(parsed.port) : undefined,
    )
    if (!port) return

    return {
      port,
      authToken: typeof parsed.authToken === "string" ? parsed.authToken : undefined,
      transport: typeof parsed.transport === "string" ? parsed.transport : undefined,
      workspaceFolders: Array.isArray(parsed.workspaceFolders)
        ? parsed.workspaceFolders.filter((item): item is string => typeof item === "string")
        : [],
      mtimeMs: statSync(filePath).mtimeMs,
    }
  } catch {
    return
  }
}

function scoreEditorLock(lock: EditorLockFile, cwd: string) {
  const workspaceMatch = lock.workspaceFolders.reduce((score, item) => {
    if (pathContains(item, cwd)) return Math.max(score, 2)
    if (pathContains(cwd, item)) return Math.max(score, 1)
    return score
  }, 0)
  return workspaceMatch * 1_000_000_000_000 + lock.mtimeMs
}

function editorSelectionKey(selection: EditorSelection | undefined) {
  if (!selection) return ""
  return [
    selection.filePath,
    selection.selection.start.line,
    selection.selection.start.character,
    selection.selection.end.line,
    selection.selection.end.character,
    selection.text,
  ].join("\0")
}

function pathContains(parent: string, child: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function openEditorSocket(connection: EditorConnection) {
  const init = connection.authToken
    ? ({
        headers: { "x-claude-code-ide-authorization": connection.authToken },
      } as unknown as ConstructorParameters<typeof WebSocket>[1])
    : undefined
  return new WebSocket(connection.url, init)
}

function parseMessage(value: unknown) {
  if (typeof value !== "string") return
  try {
    return JsonRpcMessageSchema.parse(JSON.parse(value))
  } catch {
    return
  }
}
