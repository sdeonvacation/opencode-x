import { Sandbox, isBusy } from "./sandbox"
import { WorkflowMeta } from "./meta"
import { WorkflowResolve } from "./resolve"
import { WorkflowBuiltin } from "./builtin"
import { WorkflowPersistence } from "./persistence"
import { WorkflowRunID } from "./schema"
import { WorkflowEvent } from "./events"
import { WorkflowWorkspace } from "./workspace"
import { WorkflowRuntimeRef } from "./runtime-ref"
import { Bus } from "@/bus"
import { spawnSubagent } from "@/orchestration/task-spawn"
import { Agent } from "@/agent/agent"
import { SessionPrompt } from "@/session/prompt"
import { MessageID } from "@/session/schema"
import type { SessionID } from "../session/schema"

export namespace WorkflowRuntime {
  export type Config = {
    concurrent: number
    timeout: number
    depth: number
    dir: string
  }

  export type StartInput = {
    name: string
    args?: Record<string, unknown>
    session: string
    parent?: string
    concurrent?: number
    timeout?: number
  }

  let cfg: Config | undefined
  const active = new Map<string, { abort: AbortController }>()
  let slots = 0

  export function init(config: Config) {
    cfg = config
    WorkflowRuntimeRef.set({
      start,
      status: (id) => {
        const run = status(id)
        if (!run) return Promise.resolve(undefined)
        return Promise.resolve({ id: run.id, status: run.status, error: run.error ?? undefined })
      },
      cancel: (id) => {
        cancel(id)
        return Promise.resolve()
      },
      list: (session?) => {
        const runs = WorkflowPersistence.list(session as SessionID | undefined)
        return runs.map((r) => ({ id: r.id, name: r.name, status: r.status, error: r.error ?? undefined }))
      },
    })
  }

  export async function start(input: StartInput): Promise<string> {
    if (!cfg) throw new Error("WorkflowRuntime not initialized")

    // Depth check
    if (input.parent) {
      const parent = WorkflowPersistence.load(WorkflowRunID.make(input.parent))
      let depth = 1
      let cur = parent
      while (cur?.parent_actor_id) {
        depth++
        cur = WorkflowPersistence.load(WorkflowRunID.make(cur.parent_actor_id))
      }
      if (depth >= cfg.depth) throw new Error(`Max workflow depth (${cfg.depth}) exceeded`)
    }

    // Concurrency: limit total active workflows (not per-workflow agents)
    if (slots >= 10) throw new Error("Too many concurrent workflows, try later")
    slots++

    const script = resolveScript(input.name)
    const parsed = WorkflowMeta.parse(script.source)
    if ("message" in parsed) {
      slots--
      throw new Error(`Parse error: ${parsed.message}`)
    }

    const id = WorkflowRunID.generate()
    const sha = new Bun.CryptoHasher("sha256").update(script.source).digest("hex")
    const timeout = input.timeout ?? cfg.timeout

    WorkflowPersistence.recordStart({
      id,
      session: input.session as SessionID,
      name: input.name,
      script: script.source,
      args: input.args ?? null,
      timeout,
      parent: input.parent,
    })

    Bus.publish(WorkflowEvent.Started, {
      runID: id,
      name: input.name,
      sessionID: input.session,
    })

    const ctrl = new AbortController()
    active.set(id, { abort: ctrl })

    execute(id, parsed.body, input, ctrl.signal).catch(() => {})

    return id
  }

  export function status(id: string) {
    return WorkflowPersistence.load(WorkflowRunID.make(id))
  }

  export function cancel(id: string) {
    const entry = active.get(id)
    if (!entry) return
    entry.abort.abort()
    const rid = WorkflowRunID.make(id)
    WorkflowPersistence.recordTerminal(rid, "cancelled")
    Bus.publish(WorkflowEvent.Finished, {
      runID: id,
      name: status(id)?.name ?? "unknown",
      status: "cancelled",
    })
    active.delete(id)
    slots--
  }

  export function list(session?: string) {
    return WorkflowPersistence.list(session as SessionID | undefined)
  }

  export function shutdown() {
    for (const [id, entry] of active) {
      entry.abort.abort()
      const rid = WorkflowRunID.make(id)
      WorkflowPersistence.recordTerminal(rid, "cancelled", "Session terminated")
      slots--
    }
    active.clear()
  }

  export async function resume(id: string): Promise<string> {
    const rid = WorkflowRunID.make(id)
    const run = WorkflowPersistence.load(rid)
    if (!run) throw new Error("Workflow run not found: " + id)
    if (run.status !== "failed") throw new Error("Can only resume failed runs")

    const stored = WorkflowPersistence.readScript(run.script_sha)
    if (!stored) throw new Error("Script not found for sha: " + run.script_sha)

    const script = resolveScript(run.name)
    const sha = new Bun.CryptoHasher("sha256").update(script.source).digest("hex")
    if (sha !== run.script_sha) {
      WorkflowPersistence.clearJournal(rid)
    }

    const parsed = WorkflowMeta.parse(script.source)
    if ("message" in parsed) throw new Error(`Parse error: ${parsed.message}`)

    WorkflowPersistence.recordTerminal(rid, "running")

    if (slots >= 10) throw new Error("Too many concurrent workflows, try later")
    slots++

    const ctrl = new AbortController()
    active.set(id, { abort: ctrl })

    const timeout = run.agent_timeout_ms
    execute(id, parsed.body, { name: run.name, session: run.session_id, timeout }, ctrl.signal).catch(() => {})

    return id
  }

  function resolveScript(name: string): { source: string } {
    const builtin = WorkflowBuiltin.get(name)
    if (builtin) return { source: builtin.source }
    if (!cfg) throw new Error("WorkflowRuntime not initialized")
    const resolved = WorkflowResolve.resolve(name, cfg.dir)
    if (!resolved) throw new Error("Workflow script not found: " + name)
    return { source: resolved.source }
  }

  async function execute(id: string, body: string, input: StartInput, signal: AbortSignal) {
    const rid = WorkflowRunID.make(id)
    let running = 0
    let succeeded = 0
    let failed = 0

    const journal = WorkflowPersistence.loadJournal(rid)
    const completed = new Set<string>()
    for (const entry of journal) {
      if (entry.type === "agent_complete") completed.add(entry.data.name as string)
    }

    const hooks: Sandbox.Hook[] = [
      {
        name: "agent",
        fn: async (name: unknown, opts: unknown) => {
          const agent = String(name)
          const options = (typeof opts === "object" && opts !== null ? opts : {}) as Record<string, unknown>
          const prompt = String(options.prompt ?? `Execute: ${agent}`)
          if (signal.aborted) throw new Error("Workflow cancelled")
          if (completed.has(agent)) return { result: "skipped", cached: true }

          running++
          WorkflowPersistence.flushCounters(rid, { running, succeeded, failed })
          WorkflowPersistence.appendJournal(rid, {
            type: "agent_start",
            timestamp: Date.now(),
            data: { name: agent },
          })
          Bus.publish(WorkflowEvent.AgentStarted, { runID: id, agent, prompt })

          try {
            const result = await runAgent(agent, opts, input.session as SessionID, signal)
            running--
            succeeded++
            WorkflowPersistence.flushCounters(rid, { running, succeeded, failed })
            WorkflowPersistence.appendJournal(rid, {
              type: "agent_complete",
              timestamp: Date.now(),
              data: { name: agent, result: { text: result } },
            })
            return { result }
          } catch (err) {
            running--
            failed++
            const msg = err instanceof Error ? err.message : String(err)
            WorkflowPersistence.flushCounters(rid, { running, succeeded, failed })
            WorkflowPersistence.appendJournal(rid, {
              type: "agent_failed",
              timestamp: Date.now(),
              data: { name: agent, error: msg },
            })
            Bus.publish(WorkflowEvent.AgentFailed, { runID: id, agent, error: msg })
            return { error: msg }
          }
        },
      },
      {
        name: "phase",
        fn: async (name: unknown) => {
          const phase = String(name)
          WorkflowPersistence.recordPhase(rid, phase)
          Bus.publish(WorkflowEvent.Phase, { runID: id, phase })
        },
      },
      {
        name: "log",
        fn: async (level: unknown, message: unknown) => {
          const lvl = String(level) as "info" | "warn" | "error"
          const msg = String(message)
          Bus.publish(WorkflowEvent.Log, { runID: id, level: lvl, message: msg })
          WorkflowPersistence.appendJournal(rid, {
            type: "log",
            timestamp: Date.now(),
            data: { level: lvl, message: msg },
          })
        },
      },
      ...fileHooks(cfg!.dir),
    ]

    // Inject args + strip 'await' (evalCodeAsync resolves async calls transparently)
    const args = input.args ?? {}
    const stripped = body.replace(/\bawait\s+/g, "")
    const script = `const args = ${JSON.stringify(args)};\n${stripped}`

    // Notify if another workflow holds the sandbox lock
    if (isBusy()) {
      Bus.publish(WorkflowEvent.Waiting, { runID: id, name: input.name })
    }

    try {
      await Sandbox.evaluate(script, {
        memory: 64 * 1024 * 1024,
        deadline: input.timeout ?? cfg!.timeout,
        seed: id,
        hooks,
      })
      WorkflowPersistence.recordTerminal(rid, "completed")
      Bus.publish(WorkflowEvent.Finished, { runID: id, name: input.name, status: "completed" })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      WorkflowPersistence.recordTerminal(rid, "failed", msg)
      Bus.publish(WorkflowEvent.Finished, { runID: id, name: input.name, status: "failed", error: msg })
    } finally {
      active.delete(id)
      slots--
    }
  }

  function fileHooks(dir: string): Sandbox.Hook[] {
    const fh = WorkflowWorkspace.makeFileHooks(dir)
    return [
      { name: "readFile", fn: async (p: unknown) => fh.readFile(String(p)) },
      { name: "writeFile", fn: async (p: unknown, c: unknown) => fh.writeFile(String(p), String(c)) },
      { name: "exists", fn: async (p: unknown) => fh.exists(String(p)) },
      { name: "glob", fn: async (p: unknown) => fh.glob(String(p)) },
    ]
  }

  async function runAgent(name: string, opts: unknown, session: SessionID, signal: AbortSignal): Promise<string> {
    const options = (typeof opts === "object" && opts !== null ? opts : {}) as Record<string, unknown>
    const prompt = String(options.prompt ?? `Execute: ${name}`)

    // Resolve agent — use name from workflow step, fall back to default
    let agentInfo: Awaited<ReturnType<typeof Agent.get>>
    try {
      agentInfo = await Agent.get(name)
    } catch {
      const fallback = await Agent.defaultAgent()
      agentInfo = await Agent.get(fallback)
    }

    // Spawn child session
    const subagent = await spawnSubagent(undefined, {
      parentSessionID: session,
      agent: agentInfo,
      description: `workflow:${name}`,
      canTask: false,
      canTodo: false,
      taskPermissionID: "workflow",
      maxDepth: cfg!.depth,
      maxDescendants: 50,
    })

    const child = subagent.session

    // Send prompt and wait for response
    const result = await new Promise<string>((resolve, reject) => {
      const abort = () => {
        SessionPrompt.cancel(child.id)
        reject(new Error("Workflow cancelled"))
      }
      signal.addEventListener("abort", abort, { once: true })

      SessionPrompt.prompt({
        messageID: MessageID.ascending(),
        sessionID: child.id,
        parts: [{ type: "text", text: prompt }],
      })
        .then((msg) => {
          const last = msg.parts.findLast((p: { type: string }) => p.type === "text")
          const text = last && "text" in last ? String((last as { text: string }).text) : ""
          resolve(text)
        })
        .catch(reject)
        .finally(() => signal.removeEventListener("abort", abort))
    })

    // Release spawn slot
    if (subagent.spawned) subagent.spawnInfo.release()

    return result
  }
}
