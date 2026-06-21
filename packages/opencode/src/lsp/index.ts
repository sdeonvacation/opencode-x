import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Log } from "../util/log"
import { LSPClient } from "./client"
import path from "path"
import { pathToFileURL, fileURLToPath } from "url"
import { LSPServer } from "./server"
import z from "zod"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { Flag } from "@/flag/flag"
import { Process } from "../util/process"
import { spawn as lspspawn } from "./launch"
import { Effect, Layer, ScopedCache, ServiceMap } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { SessionStatus } from "@/session/status"
import { Global } from "../global"
import fs from "fs/promises"
import { writeFileSync } from "node:fs"

export namespace LSP {
  const log = Log.create({ service: "lsp" })

  // Backstop: track all spawned LSP PIDs for emergency cleanup
  const pids = new Set<number>()

  // PID file for cross-session cleanup of orphaned LSP processes
  const pidFile = path.join(Global.Path.state, "lsp-pids.json")

  async function persistPids() {
    try {
      await fs.writeFile(pidFile, JSON.stringify([...pids]))
    } catch {}
  }

  function isProcessAlive(pid: number) {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  /** Kill orphaned LSP processes from prior sessions */
  export async function killOrphans() {
    try {
      const data = await fs.readFile(pidFile, "utf-8")
      const stale: number[] = JSON.parse(data)
      for (const pid of stale) {
        if (pids.has(pid)) continue
        if (!isProcessAlive(pid)) continue
        log.info("killing orphaned LSP process", { pid })
        try {
          process.kill(-pid, "SIGKILL")
        } catch {
          try {
            process.kill(pid, "SIGKILL")
          } catch {}
        }
      }
    } catch {}
    await persistPids()

    // Clean up legacy temp dirs from prior versions that used mkdtemp
    try {
      const { tmpdir } = await import("os")
      const tmp = tmpdir()
      const entries = await fs.readdir(tmp)
      for (const entry of entries) {
        if (!entry.startsWith("opencode-jdtls-data")) continue
        await fs.rm(path.join(tmp, entry), { recursive: true, force: true }).catch(() => {})
      }
    } catch {}
  }

  export function killAll() {
    for (const pid of pids) {
      try {
        process.kill(-pid, "SIGKILL")
      } catch {
        try {
          process.kill(pid, "SIGKILL")
        } catch {}
      }
    }
    pids.clear()
    // Best-effort sync clear of PID file
    try {
      writeFileSync(pidFile, "[]")
    } catch {}
  }

  export const Event = {
    Updated: BusEvent.define("lsp.updated", z.object({})),
  }

  export const Range = z
    .object({
      start: z.object({
        line: z.number(),
        character: z.number(),
      }),
      end: z.object({
        line: z.number(),
        character: z.number(),
      }),
    })
    .meta({
      ref: "Range",
    })
  export type Range = z.infer<typeof Range>

  export const Symbol = z
    .object({
      name: z.string(),
      kind: z.number(),
      location: z.object({
        uri: z.string(),
        range: Range,
      }),
    })
    .meta({
      ref: "Symbol",
    })
  export type Symbol = z.infer<typeof Symbol>

  export const DocumentSymbol = z
    .object({
      name: z.string(),
      detail: z.string().optional(),
      kind: z.number(),
      range: Range,
      selectionRange: Range,
    })
    .meta({
      ref: "DocumentSymbol",
    })
  export type DocumentSymbol = z.infer<typeof DocumentSymbol>

  export const Status = z
    .object({
      id: z.string(),
      name: z.string(),
      root: z.string(),
      status: z.union([z.literal("connected"), z.literal("error")]),
    })
    .meta({
      ref: "LSPStatus",
    })
  export type Status = z.infer<typeof Status>

  enum SymbolKind {
    File = 1,
    Module = 2,
    Namespace = 3,
    Package = 4,
    Class = 5,
    Method = 6,
    Property = 7,
    Field = 8,
    Constructor = 9,
    Enum = 10,
    Interface = 11,
    Function = 12,
    Variable = 13,
    Constant = 14,
    String = 15,
    Number = 16,
    Boolean = 17,
    Array = 18,
    Object = 19,
    Key = 20,
    Null = 21,
    EnumMember = 22,
    Struct = 23,
    Event = 24,
    Operator = 25,
    TypeParameter = 26,
  }

  const kinds = [
    SymbolKind.Class,
    SymbolKind.Function,
    SymbolKind.Method,
    SymbolKind.Interface,
    SymbolKind.Variable,
    SymbolKind.Constant,
    SymbolKind.Struct,
    SymbolKind.Enum,
  ]

  const filterExperimentalServers = (servers: Record<string, LSPServer.Info>) => {
    if (Flag.OPENCODE_EXPERIMENTAL_LSP_TY) {
      if (servers["pyright"]) {
        log.info("LSP server pyright is disabled because OPENCODE_EXPERIMENTAL_LSP_TY is enabled")
        delete servers["pyright"]
      }
    } else {
      if (servers["ty"]) {
        delete servers["ty"]
      }
    }
  }

  type LocInput = { file: string; line: number; character: number }

  interface State {
    clients: LSPClient.Info[]
    servers: Record<string, LSPServer.Info>
    broken: Set<string>
    spawning: Map<string, Promise<LSPClient.Info | undefined>>
    disposing: boolean
  }

  export interface Interface {
    readonly init: () => Effect.Effect<void>
    readonly status: () => Effect.Effect<Status[]>
    readonly hasClients: (file: string) => Effect.Effect<boolean>
    readonly touchFile: (input: string, diagnostics?: "document" | "full") => Effect.Effect<void>
    readonly diagnostics: () => Effect.Effect<Record<string, LSPClient.Diagnostic[]>>
    readonly hover: (input: LocInput) => Effect.Effect<any>
    readonly definition: (input: LocInput) => Effect.Effect<any[]>
    readonly references: (input: LocInput) => Effect.Effect<any[]>
    readonly implementation: (input: LocInput) => Effect.Effect<any[]>
    readonly documentSymbol: (uri: string) => Effect.Effect<(LSP.DocumentSymbol | LSP.Symbol)[]>
    readonly workspaceSymbol: (query: string) => Effect.Effect<LSP.Symbol[]>
    readonly prepareCallHierarchy: (input: LocInput) => Effect.Effect<any[]>
    readonly incomingCalls: (input: LocInput) => Effect.Effect<any[]>
    readonly outgoingCalls: (input: LocInput) => Effect.Effect<any[]>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/LSP") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service

      const state = yield* InstanceState.make<State>(
        Effect.fn("LSP.state")(function* () {
          const cfg = yield* config.get()

          const servers: Record<string, LSPServer.Info> = {}

          if (cfg.lsp === false) {
            log.info("all LSPs are disabled")
          } else {
            for (const server of Object.values(LSPServer)) {
              servers[server.id] = server
            }

            filterExperimentalServers(servers)

            for (const [name, item] of Object.entries(cfg.lsp ?? {})) {
              const existing = servers[name]
              if (item.disabled) {
                log.info(`LSP server ${name} is disabled`)
                delete servers[name]
                continue
              }
              servers[name] = {
                ...existing,
                id: name,
                root: existing?.root ?? (async () => Instance.directory),
                extensions: item.extensions ?? existing?.extensions ?? [],
                spawn: async (root) => ({
                  process: lspspawn(item.command[0], item.command.slice(1), {
                    cwd: root,
                    env: { ...process.env, ...item.env },
                  }),
                  initialization: item.initialization,
                }),
              }
            }

            log.info("enabled LSP servers", {
              serverIds: Object.values(servers)
                .map((server) => server.id)
                .join(", "),
            })
          }

          const s: State = {
            clients: [],
            servers,
            broken: new Set(),
            spawning: new Map(),
            disposing: false,
          }

          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              s.disposing = true

              const graceful = async () => {
                // Wait for in-flight spawns to settle so their processes don't leak
                if (s.spawning.size > 0) {
                  const inflight = [...s.spawning.values()]
                  const spawned = await Promise.allSettled(inflight)
                  // Any successfully spawned clients not yet in s.clients need shutdown too
                  for (const result of spawned) {
                    if (result.status !== "fulfilled" || !result.value) continue
                    if (!s.clients.includes(result.value)) {
                      s.clients.push(result.value)
                    }
                  }
                }
                const results = await Promise.allSettled(s.clients.map((client) => client.shutdown()))
                results.forEach((result, index) => {
                  if (result.status === "fulfilled") return
                  const client = s.clients[index]
                  log.warn("failed to shutdown lsp client", {
                    error: result.reason,
                    serverID: client?.serverID,
                    root: client?.root,
                  })
                })
              }

              const deadline = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10_000))
              const result = await Promise.race([graceful().then(() => "done" as const), deadline])

              if (result === "timeout") {
                log.warn("LSP graceful shutdown timed out after 10s, force-killing remaining processes")
              }

              // Force-kill any survivors regardless of graceful outcome
              for (const pid of pids) {
                try {
                  process.kill(-pid, "SIGKILL")
                } catch {
                  try {
                    process.kill(pid, "SIGKILL")
                  } catch {}
                }
              }
              pids.clear()
            }),
          )

          return s
        }),
      )

      // Idle shutdown: when all sessions idle for 30 min, invalidate LSP state.
      // Capture directory lazily — in tests the layer may be built outside an
      // Instance ALS context. When no context is active, skip the subscription
      // entirely (idle shutdown is a no-op).
      let dir: string | undefined
      try {
        dir = Instance.directory
      } catch {
        dir = undefined
      }
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      let unsub: (() => void) | undefined
      if (dir !== undefined) {
        const directory = dir
        const idle = async () => {
          const all = await SessionStatus.list()
          const anyBusy = [...all.values()].some((s) => s.type !== "idle")
          if (anyBusy) {
            if (idleTimer) {
              clearTimeout(idleTimer)
              idleTimer = undefined
            }
            return
          }
          if (!idleTimer) {
            idleTimer = setTimeout(
              () => {
                idleTimer = undefined
                Effect.runPromise(ScopedCache.invalidate(state.cache, directory)).catch((error) => {
                  log.error("failed to invalidate idle lsp state", { error, directory })
                })
              },
              30 * 60 * 1000,
            )
          }
        }
        unsub = Bus.subscribe(SessionStatus.Event.Status, idle)
        void idle()
      }
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unsub?.()
          if (idleTimer) {
            clearTimeout(idleTimer)
            idleTimer = undefined
          }
        }),
      )

      const getClients = Effect.fnUntraced(function* (file: string) {
        const internal = Instance.containsPath(file)
        const s = yield* InstanceState.get(state)
        if (s.disposing) return [] as LSPClient.Info[]
        return yield* Effect.promise(async () => {
          const extension = path.parse(file).ext || file
          const result: LSPClient.Info[] = []

          // For isolated instances, translate file path to parent-equivalent
          // to find matching parent LSP clients (don't spawn new ones)
          const ctx = Instance.current
          const isolated = ctx.isolated && ctx.parent
          const lookup = isolated ? file.replace(ctx.directory, ctx.parent!) : file

          async function schedule(server: LSPServer.Info, root: string, key: string) {
            const handle = await server
              .spawn(root)
              .then((value) => {
                if (!value) s.broken.add(key)
                return value
              })
              .catch((err) => {
                s.broken.add(key)
                log.error(`Failed to spawn LSP server ${server.id}`, { error: err })
                return undefined
              })

            if (!handle) return undefined
            if (handle.process.pid) {
              const pid = handle.process.pid
              pids.add(pid)
              persistPids()
              handle.process.once("exit", () => {
                pids.delete(pid)
                persistPids()
              })
            }
            log.info("spawned lsp server", { serverID: server.id, root })

            const client = await LSPClient.create({
              serverID: server.id,
              server: handle,
              root,
              directory: Instance.directory,
            }).catch(async (err) => {
              s.broken.add(key)
              await Process.stop(handle.process)
              log.error(`Failed to initialize LSP client ${server.id}`, { error: err })
              return undefined
            })

            if (!client) return undefined

            const existing = s.clients.find((x) => x.root === root && x.serverID === server.id)
            if (existing) {
              await Process.stop(handle.process)
              return existing
            }

            s.clients.push(client)
            return client
          }

          for (const server of Object.values(s.servers)) {
            if (server.extensions.length && !server.extensions.includes(extension)) continue

            // Root resolution: internal uses existing path; external uses resolveRoot
            let root: string | undefined
            if (internal) {
              root = await server.root(lookup)
            } else {
              root = server.resolveRoot ? await server.resolveRoot(file) : undefined
            }
            if (!root) continue
            if (s.broken.has(root + server.id)) continue

            // Check if any existing client already has this root in its folders
            const folderMatch = s.clients.find((x) => x.serverID === server.id && x.folders.has(root!))
            if (folderMatch) {
              result.push(folderMatch)
              continue
            }

            // Try to add folder to existing multi-root client (same server type)
            if (!internal) {
              let candidate = s.clients.find((x) => x.serverID === server.id && x.multiRoot)

              // Race guard: await any in-flight spawn of same server type
              if (!candidate) {
                const inflight = [...s.spawning.entries()].find(([key]) => key.endsWith(server.id))
                if (inflight) {
                  const spawned = await inflight[1]
                  if (spawned?.multiRoot) candidate = spawned
                }
              }

              if (candidate) {
                await candidate.addFolder(root)
                result.push(candidate)
                continue
              }
            }

            // Existing spawn path (for internal, or fallback for non-multi-root external)
            const match = s.clients.find((x) => x.root === root && x.serverID === server.id)
            if (match) {
              result.push(match)
              continue
            }

            const inflight = s.spawning.get(root + server.id)
            if (inflight) {
              const client = await inflight
              if (!client) continue
              result.push(client)
              continue
            }

            const task = schedule(server, root, root + server.id)
            s.spawning.set(root + server.id, task)

            task.finally(() => {
              if (s.spawning.get(root + server.id) === task) {
                s.spawning.delete(root + server.id)
              }
            })

            const client = await task
            if (!client) continue

            result.push(client)
            Bus.publish(Event.Updated, {})
          }

          return result
        })
      })

      const run = Effect.fnUntraced(function* <T>(file: string, fn: (client: LSPClient.Info) => Promise<T>) {
        const clients = yield* getClients(file)
        return yield* Effect.promise(() => Promise.all(clients.map((x) => fn(x))))
      })

      const runAll = Effect.fnUntraced(function* <T>(fn: (client: LSPClient.Info) => Promise<T>) {
        const s = yield* InstanceState.get(state)
        return yield* Effect.promise(() => Promise.all(s.clients.map((x) => fn(x))))
      })

      const init = Effect.fn("LSP.init")(function* () {
        yield* Effect.promise(() => killOrphans())
        yield* InstanceState.get(state)
      })

      const status = Effect.fn("LSP.status")(function* () {
        const s = yield* InstanceState.get(state)
        const result: Status[] = []
        for (const client of s.clients) {
          result.push({
            id: client.serverID,
            name: s.servers[client.serverID].id,
            root: path.relative(Instance.directory, client.root),
            status: "connected",
          })
        }
        return result
      })

      const hasClients = Effect.fn("LSP.hasClients")(function* (file: string) {
        const s = yield* InstanceState.get(state)
        return yield* Effect.promise(async () => {
          const extension = path.parse(file).ext || file
          for (const server of Object.values(s.servers)) {
            if (server.extensions.length && !server.extensions.includes(extension)) continue
            const root = await server.root(file)
            if (!root) continue
            if (s.broken.has(root + server.id)) continue
            return true
          }
          return false
        })
      })

      const touchFile = Effect.fn("LSP.touchFile")(function* (input: string, diagnostics?: "document" | "full") {
        log.info("touching file", { file: input })
        const clients = yield* getClients(input)
        yield* Effect.promise(() =>
          Promise.all(
            clients.map(async (client) => {
              const after = Date.now()
              const version = await client.notify.open({ path: input })
              if (!diagnostics) return
              return client.waitForDiagnostics({
                path: input,
                version,
                mode: diagnostics,
                after,
              })
            }),
          ).catch((err) => {
            log.error("failed to touch file", { err, file: input })
          }),
        )
      })

      const diagnostics = Effect.fn("LSP.diagnostics")(function* () {
        const results: Record<string, LSPClient.Diagnostic[]> = {}
        const all = yield* runAll(async (client) => client.diagnostics)
        for (const result of all) {
          for (const [p, diags] of result.entries()) {
            const arr = results[p] || []
            arr.push(...diags)
            results[p] = arr
          }
        }
        return results
      })

      const hover = Effect.fn("LSP.hover")(function* (input: LocInput) {
        return yield* run(input.file, (client) =>
          client.connection
            .sendRequest("textDocument/hover", {
              textDocument: { uri: pathToFileURL(input.file).href },
              position: { line: input.line, character: input.character },
            })
            .catch(() => null),
        )
      })

      const definition = Effect.fn("LSP.definition")(function* (input: LocInput) {
        const results = yield* run(input.file, (client) =>
          client.connection
            .sendRequest("textDocument/definition", {
              textDocument: { uri: pathToFileURL(input.file).href },
              position: { line: input.line, character: input.character },
            })
            .catch(() => null),
        )
        return results.flat().filter(Boolean)
      })

      const references = Effect.fn("LSP.references")(function* (input: LocInput) {
        const results = yield* run(input.file, (client) =>
          client.connection
            .sendRequest("textDocument/references", {
              textDocument: { uri: pathToFileURL(input.file).href },
              position: { line: input.line, character: input.character },
              context: { includeDeclaration: true },
            })
            .catch(() => []),
        )
        return results.flat().filter(Boolean)
      })

      const implementation = Effect.fn("LSP.implementation")(function* (input: LocInput) {
        const results = yield* run(input.file, (client) =>
          client.connection
            .sendRequest("textDocument/implementation", {
              textDocument: { uri: pathToFileURL(input.file).href },
              position: { line: input.line, character: input.character },
            })
            .catch(() => null),
        )
        return results.flat().filter(Boolean)
      })

      const documentSymbol = Effect.fn("LSP.documentSymbol")(function* (uri: string) {
        const file = fileURLToPath(uri)
        const results = yield* run(file, (client) =>
          client.connection.sendRequest("textDocument/documentSymbol", { textDocument: { uri } }).catch(() => []),
        )
        return (results.flat() as (LSP.DocumentSymbol | LSP.Symbol)[]).filter(Boolean)
      })

      const workspaceSymbol = Effect.fn("LSP.workspaceSymbol")(function* (query: string) {
        const results = yield* runAll((client) =>
          client.connection
            .sendRequest("workspace/symbol", { query })
            .then((result: any) => result.filter((x: LSP.Symbol) => kinds.includes(x.kind)))
            .then((result: any) => result.slice(0, 10))
            .catch(() => []),
        )
        return results.flat() as LSP.Symbol[]
      })

      const prepareCallHierarchy = Effect.fn("LSP.prepareCallHierarchy")(function* (input: LocInput) {
        const results = yield* run(input.file, (client) =>
          client.connection
            .sendRequest("textDocument/prepareCallHierarchy", {
              textDocument: { uri: pathToFileURL(input.file).href },
              position: { line: input.line, character: input.character },
            })
            .catch(() => []),
        )
        return results.flat().filter(Boolean)
      })

      const callHierarchyRequest = Effect.fnUntraced(function* (
        input: LocInput,
        direction: "callHierarchy/incomingCalls" | "callHierarchy/outgoingCalls",
      ) {
        const results = yield* run(input.file, async (client) => {
          const items = (await client.connection
            .sendRequest("textDocument/prepareCallHierarchy", {
              textDocument: { uri: pathToFileURL(input.file).href },
              position: { line: input.line, character: input.character },
            })
            .catch(() => [])) as any[]
          if (!items?.length) return []
          return client.connection.sendRequest(direction, { item: items[0] }).catch(() => [])
        })
        return results.flat().filter(Boolean)
      })

      const incomingCalls = Effect.fn("LSP.incomingCalls")(function* (input: LocInput) {
        return yield* callHierarchyRequest(input, "callHierarchy/incomingCalls")
      })

      const outgoingCalls = Effect.fn("LSP.outgoingCalls")(function* (input: LocInput) {
        return yield* callHierarchyRequest(input, "callHierarchy/outgoingCalls")
      })

      return Service.of({
        init,
        status,
        hasClients,
        touchFile,
        diagnostics,
        hover,
        definition,
        references,
        implementation,
        documentSymbol,
        workspaceSymbol,
        prepareCallHierarchy,
        incomingCalls,
        outgoingCalls,
      })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer))

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export const init = async () => runPromise((svc) => svc.init())

  export const status = async () => runPromise((svc) => svc.status())

  export const hasClients = async (file: string) => runPromise((svc) => svc.hasClients(file))

  export const touchFile = async (input: string, diagnostics?: "document" | "full") =>
    runPromise((svc) => svc.touchFile(input, diagnostics))

  export const diagnostics = async () => runPromise((svc) => svc.diagnostics())

  export const hover = async (input: LocInput) => runPromise((svc) => svc.hover(input))

  export const definition = async (input: LocInput) => runPromise((svc) => svc.definition(input))

  export const references = async (input: LocInput) => runPromise((svc) => svc.references(input))

  export const implementation = async (input: LocInput) => runPromise((svc) => svc.implementation(input))

  export const documentSymbol = async (uri: string) => runPromise((svc) => svc.documentSymbol(uri))

  export const workspaceSymbol = async (query: string) => runPromise((svc) => svc.workspaceSymbol(query))

  export const prepareCallHierarchy = async (input: LocInput) => runPromise((svc) => svc.prepareCallHierarchy(input))

  export const incomingCalls = async (input: LocInput) => runPromise((svc) => svc.incomingCalls(input))

  export const outgoingCalls = async (input: LocInput) => runPromise((svc) => svc.outgoingCalls(input))

  export namespace Diagnostic {
    export function pretty(diagnostic: LSPClient.Diagnostic) {
      const severityMap = {
        1: "ERROR",
        2: "WARN",
        3: "INFO",
        4: "HINT",
      }

      const severity = severityMap[diagnostic.severity || 1]
      const line = diagnostic.range.start.line + 1
      const col = diagnostic.range.start.character + 1

      return `${severity} [${line}:${col}] ${diagnostic.message}`
    }
  }
}
