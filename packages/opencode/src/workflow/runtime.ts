import { Sandbox, isBusy } from "./sandbox"
import { WorkflowMeta } from "./meta"
import { WorkflowResolve } from "./resolve"
import { WorkflowBuiltin } from "./builtin"
import { WorkflowPersistence } from "./persistence"
import { WorkflowRunID } from "./schema"
import { WorkflowEvent } from "./events"
import { WorkflowWorkspace } from "./workspace"
import { WorkflowSessionWriter } from "./session-writer"
import { WorkflowRuntimeRef } from "./runtime-ref"
import { Bus } from "@/bus"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { spawnSubagent } from "@/orchestration/task-spawn"
import { Agent } from "@/agent/agent"
import { SessionPrompt } from "@/session/prompt"
import { MessageID } from "@/session/schema"
import { withTimeout } from "@/util/timeout"
import { Log } from "@/util/log"
import type { SessionID } from "../session/schema"

const log = Log.create({ service: "workflow.runtime" })

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
  const active = new Map<string, { abort: AbortController; parentSessionID?: SessionID; childSessionID?: string }>()
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
    if (entry.parentSessionID && entry.childSessionID) {
      Bus.publish(TuiEvent.BackgroundTaskUpdate, {
        sessionID: entry.parentSessionID,
        taskID: entry.childSessionID,
        title: `workflow:${status(id)?.name ?? "unknown"}`,
        state: "error",
      })
    }
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
      {
        name: "bash",
        fn: async (cmd: unknown) => {
          const command = String(cmd)
          const proc = Bun.spawn(["sh", "-c", command], { cwd: cfg!.dir, stdout: "pipe", stderr: "pipe" })
          const stdout = await new Response(proc.stdout).text()
          const stderr = await new Response(proc.stderr).text()
          await proc.exited
          return { exitCode: proc.exitCode, stdout, stderr }
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

  async function runAgent(
    name: string,
    opts: unknown,
    session: SessionID,
    signal: AbortSignal,
    onSpawn?: (childSessionID: string) => void,
  ): Promise<{ result: string; childSessionID: string }> {
    const options = (typeof opts === "object" && opts !== null ? opts : {}) as Record<string, unknown>
    const prompt = String(options.prompt ?? `Execute: ${name}`)

    // Resolve agent — use name from workflow step, fall back to default
    let agentInfo: Awaited<ReturnType<typeof Agent.get>> | undefined = await Agent.get(name)
    if (!agentInfo) {
      // Agent.get uses dictionary key lookup which may miss config-loaded agents
      // Try finding by name from the full list
      const all = await Agent.list()
      agentInfo = all.find((a) => a.name === name)
    }
    if (!agentInfo) {
      log.warn("agent not found, falling back to default", { name, available: (await Agent.list()).map((a) => a.name) })
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
      taskPermissionID: "task",
      maxDepth: cfg!.depth,
      maxDescendants: 50,
    })

    const child = subagent.session
    onSpawn?.(child.id)

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

    return { result, childSessionID: child.id }
  }

  // --- Session-based execution (used by workflow tool) ---

  export type ExecuteInSessionInput = {
    sessionID: SessionID
    parentSessionID?: SessionID
    name: string
    args?: Record<string, unknown>
    timeout: number
    concurrent?: number
  }

  export async function executeInSession(input: ExecuteInSessionInput): Promise<string> {
    if (!cfg) throw new Error("WorkflowRuntime not initialized")

    const script = resolveScript(input.name)
    const parsed = WorkflowMeta.parse(script.source)
    if ("message" in parsed) throw new Error(`Parse error: ${parsed.message}`)

    const id = WorkflowRunID.generate()
    const timeout = input.timeout

    WorkflowPersistence.recordStart({
      id,
      session: input.parentSessionID ?? input.sessionID,
      name: input.name,
      script: script.source,
      args: input.args ?? null,
      timeout,
      parent: undefined,
    })

    Bus.publish(WorkflowEvent.Started, { runID: id, name: input.name, sessionID: String(input.sessionID) })

    const ctrl = new AbortController()
    active.set(id, { abort: ctrl, parentSessionID: input.parentSessionID, childSessionID: input.sessionID })
    if (slots >= 10) throw new Error("Too many concurrent workflows, try later")
    slots++

    WorkflowSessionWriter.reset()
    WorkflowSessionWriter.setCwd(cfg.dir)

    try {
      await executeWithSession(id, parsed.body, input, ctrl.signal)
      WorkflowPersistence.recordTerminal(WorkflowRunID.make(id), "completed")
      WorkflowSessionWriter.writeStatus(input.sessionID, "completed")
      Bus.publish(WorkflowEvent.Finished, { runID: id, name: input.name, status: "completed" })
      return `Workflow "${input.name}" completed successfully.`
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      WorkflowPersistence.recordTerminal(WorkflowRunID.make(id), "failed", msg)
      WorkflowSessionWriter.writeStatus(input.sessionID, "failed", msg)
      Bus.publish(WorkflowEvent.Finished, { runID: id, name: input.name, status: "failed", error: msg })
      throw err
    } finally {
      active.delete(id)
      slots--
    }
  }

  async function executeWithSession(id: string, body: string, input: ExecuteInSessionInput, signal: AbortSignal) {
    const rid = WorkflowRunID.make(id)
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

          WorkflowPersistence.appendJournal(rid, { type: "agent_start", timestamp: Date.now(), data: { name: agent } })
          Bus.publish(WorkflowEvent.AgentStarted, { runID: id, agent, prompt })

          const start = Date.now()
          let runningPart: { partID: any; callID: string } | undefined
          try {
            const { result, childSessionID } = await runAgent(agent, opts, input.sessionID, signal, (childID) => {
              runningPart = WorkflowSessionWriter.writeAgentRunning(input.sessionID, {
                childSessionID: childID,
                name: agent,
                prompt,
              })
            })
            WorkflowPersistence.appendJournal(rid, {
              type: "agent_complete",
              timestamp: Date.now(),
              data: { name: agent, result: { text: result } },
            })
            WorkflowSessionWriter.writeAgentTask(input.sessionID, {
              partID: runningPart?.partID,
              callID: runningPart?.callID,
              childSessionID,
              name: agent,
              prompt,
              output: result.length > 2000 ? result.slice(0, 2000) + "..." : result,
              status: "completed",
              duration: Date.now() - start,
            })
            return { result }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            WorkflowPersistence.appendJournal(rid, {
              type: "agent_failed",
              timestamp: Date.now(),
              data: { name: agent, error: msg },
            })
            WorkflowSessionWriter.writeAgentTask(input.sessionID, {
              partID: runningPart?.partID,
              callID: runningPart?.callID,
              childSessionID: "",
              name: agent,
              prompt,
              output: `ERROR: ${msg}`,
              status: "error",
              duration: Date.now() - start,
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
          WorkflowSessionWriter.writePhase(input.sessionID, phase)
          Bus.publish(WorkflowEvent.Phase, { runID: id, phase })
        },
      },
      {
        name: "log",
        fn: async (level: unknown, message: unknown) => {
          const lvl = String(level) as "info" | "warn" | "error"
          const msg = String(message)
          WorkflowSessionWriter.appendLog(input.sessionID, lvl, msg)
          Bus.publish(WorkflowEvent.Log, { runID: id, level: lvl, message: msg })
          WorkflowPersistence.appendJournal(rid, {
            type: "log",
            timestamp: Date.now(),
            data: { level: lvl, message: msg },
          })
        },
      },
      {
        name: "bash",
        fn: async (cmd: unknown) => {
          const command = String(cmd)
          const start = Date.now()
          const proc = Bun.spawn(["sh", "-c", command], { cwd: cfg!.dir, stdout: "pipe", stderr: "pipe" })
          const stdout = await new Response(proc.stdout).text()
          const stderr = await new Response(proc.stderr).text()
          await proc.exited
          const output = stdout + (stderr ? `\n${stderr}` : "")
          const duration = Date.now() - start
          WorkflowSessionWriter.writeTool(input.sessionID, {
            tool: "bash",
            args: { command },
            output,
            title: command,
            duration,
          })
          return { exitCode: proc.exitCode, stdout, stderr }
        },
      },
      ...sessionFileHooks(input.sessionID, cfg!.dir),
    ]

    const args = input.args ?? {}
    const stripped = body.replace(/\bawait\s+/g, "")
    const script = `const args = ${JSON.stringify(args)};\n${stripped}`

    if (isBusy()) {
      Bus.publish(WorkflowEvent.Waiting, { runID: id, name: input.name })
    }

    await Sandbox.evaluate(script, {
      memory: 64 * 1024 * 1024,
      deadline: input.timeout,
      seed: id,
      hooks,
    })
  }

  function sessionFileHooks(sessionID: SessionID, dir: string): Sandbox.Hook[] {
    const fh = WorkflowWorkspace.makeFileHooks(dir)
    return [
      {
        name: "readFile",
        fn: async (p: unknown) => {
          const path = String(p)
          const start = Date.now()
          const content = await fh.readFile(path)
          WorkflowSessionWriter.writeTool(sessionID, {
            tool: "read",
            args: { path },
            output: String(content).slice(0, 2000),
            title: path,
            duration: Date.now() - start,
          })
          return content
        },
      },
      {
        name: "writeFile",
        fn: async (p: unknown, c: unknown) => {
          const path = String(p)
          const content = String(c)
          const start = Date.now()
          await fh.writeFile(path, content)
          WorkflowSessionWriter.writeTool(sessionID, {
            tool: "write",
            args: { path, content: content.slice(0, 200) },
            output: `Written ${content.length} bytes`,
            title: path,
            duration: Date.now() - start,
          })
        },
      },
      { name: "exists", fn: async (p: unknown) => fh.exists(String(p)) },
      { name: "glob", fn: async (p: unknown) => fh.glob(String(p)) },
    ]
  }

  async function runAgentInline(
    prompt: string,
    sessionID: SessionID,
    signal: AbortSignal,
    timeout: number,
  ): Promise<string> {
    const result = await new Promise<string>((resolve, reject) => {
      const abort = () => {
        SessionPrompt.cancel(sessionID)
        reject(new Error("Workflow cancelled"))
      }
      signal.addEventListener("abort", abort, { once: true })

      withTimeout(
        SessionPrompt.prompt({
          messageID: MessageID.ascending(),
          sessionID,
          parts: [{ type: "text", text: prompt }],
        }),
        timeout,
      )
        .then((msg) => {
          const last = msg.parts.findLast((p: { type: string }) => p.type === "text")
          const text = last && "text" in last ? String((last as { text: string }).text) : ""
          resolve(text)
        })
        .catch((err) => {
          if (err instanceof Error && err.message.includes("Operation timed out")) {
            SessionPrompt.cancel(sessionID)
            reject(new Error(`Agent step timed out after ${timeout}ms`))
            return
          }
          reject(err)
        })
        .finally(() => signal.removeEventListener("abort", abort))
    })

    return result
  }
}
