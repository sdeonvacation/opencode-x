import { cmd } from "@/cli/cmd/cmd"
import { tui } from "./app"
import { Rpc } from "@/util/rpc"
import { type rpc } from "./worker"
import path from "path"
import { fileURLToPath } from "url"
import { UI } from "@/cli/ui"
import { Log } from "@/util/log"
import { errorMessage } from "@/util/error"
import { withTimeout } from "@/util/timeout"
import { withNetworkOptions, resolveNetworkOptions } from "@/cli/network"
import { Filesystem } from "@/util/filesystem"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import type { EventSource } from "./context/sdk"
import { win32DisableProcessedInput, win32InstallCtrlCGuard } from "./win32"
import { TuiConfig } from "@/config/tui"
import { Instance } from "@/project/instance"
import { writeHeapSnapshot } from "v8"
import { validateSession } from "./validate-session"
import { gitDiff, gitApply } from "@/orchestration/patch"

declare global {
  const OPENCODE_WORKER_PATH: string
}

type RpcClient = ReturnType<typeof Rpc.client<typeof rpc>>

function createWorkerFetch(client: RpcClient): typeof fetch {
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const body = request.body ? await request.text() : undefined
    const result = await client.call("fetch", {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    })
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    })
  }
  return fn as typeof fetch
}

function createEventSource(client: RpcClient): EventSource {
  return {
    subscribe: async (directory, handler) => {
      return client.on<GlobalEvent>("global.event", (e) => {
        handler(e)
      })
    },
    changeDirectory: async (directory) => {
      await client.call("changeDirectory", { directory })
    },
  }
}

async function target() {
  if (typeof OPENCODE_WORKER_PATH !== "undefined") return OPENCODE_WORKER_PATH
  const dist = new URL("./cli/cmd/tui/worker.js", import.meta.url)
  if (await Filesystem.exists(fileURLToPath(dist))) return dist
  return new URL("./worker.ts", import.meta.url)
}

async function input(value?: string) {
  const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()
  if (!value) return piped
  if (!piped) return value
  return piped + "\n" + value
}

export async function resolveWorktree(name: string, cwd: string) {
  const slug =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || Math.random().toString(36).slice(2, 8)

  const check = Bun.spawn(["git", "rev-parse", "--show-toplevel"], { cwd, stdout: "pipe", stderr: "pipe" })
  const root = (await new Response(check.stdout).text()).trim()
  if ((await check.exited) !== 0) throw new Error("Worktrees require a git project")

  const ref = `refs/heads/opencode/${slug}`
  const list = Bun.spawn(["git", "worktree", "list", "--porcelain"], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const text = await new Response(list.stdout).text()
  await list.exited

  const entries = text.split("\n").reduce<{ path?: string; branch?: string }[]>((acc, line) => {
    const trimmed = line.trim()
    if (!trimmed) return acc
    if (trimmed.startsWith("worktree ")) {
      acc.push({ path: trimmed.slice("worktree ".length) })
      return acc
    }
    const current = acc[acc.length - 1]
    if (current && trimmed.startsWith("branch ")) {
      current.branch = trimmed.slice("branch ".length)
    }
    return acc
  }, [])

  const match = entries.find((e) => e.branch === ref)
  if (match?.path) {
    const exists = await Bun.file(path.join(match.path, ".git"))
      .exists()
      .catch(() => false)
    if (exists) return { name: slug, branch: `opencode/${slug}`, directory: match.path }
    // Stale entry: prune worktree tracking and delete orphaned branch
    const prune = Bun.spawn(["git", "worktree", "prune"], { cwd: root, stdout: "pipe", stderr: "pipe" })
    await prune.exited
    const del = Bun.spawn(["git", "branch", "-D", `opencode/${slug}`], { cwd: root, stdout: "pipe", stderr: "pipe" })
    await del.exited
  }

  const dir = path.join(root, ".worktrees", slug)
  const create = Bun.spawn(["git", "worktree", "add", "--no-checkout", "-b", `opencode/${slug}`, dir], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stderr = await new Response(create.stderr).text()
  if ((await create.exited) !== 0) throw new Error(stderr || "Failed to create worktree")

  const reset = Bun.spawn(["git", "reset", "--hard"], { cwd: dir, stdout: "pipe", stderr: "pipe" })
  await reset.exited

  return { name: slug, branch: `opencode/${slug}`, directory: dir }
}

export type PatchStatus = { status: "applied" } | { status: "empty" } | { status: "conflict"; branch: string }

export async function ephemeralCleanup(
  info: { name: string; branch: string; directory: string },
  parent: string,
): Promise<PatchStatus> {
  const diff = await gitDiff(info.directory)
  if (!diff.trim()) {
    await worktreeRemove(info.directory, parent)
    return { status: "empty" }
  }
  const result = await gitApply(diff, parent)
  if (!result.success) return { status: "conflict", branch: info.branch }
  await worktreeRemove(info.directory, parent)
  return { status: "applied" }
}

async function worktreeRemove(directory: string, cwd: string) {
  const proc = Bun.spawn(["git", "worktree", "remove", "--force", directory], { cwd, stdout: "pipe", stderr: "pipe" })
  const code = await proc.exited
  if (code !== 0) {
    Log.Default.warn("worktree remove failed", { directory })
  }
}

export const TuiThreadCommand = cmd({
  command: "$0 [project]",
  describe: "start opencode tui",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .positional("project", {
        type: "string",
        describe: "path to start opencode in",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("fork", {
        type: "boolean",
        describe: "fork the session when continuing (use with --continue or --session)",
      })
      .option("prompt", {
        type: "string",
        describe: "prompt to use",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("worktree", {
        type: "string",
        describe: "create or reuse a named worktree",
      })
      .option("ephemeral", {
        type: "boolean",
        describe: "auto-cleanup worktree on exit (patch changes back)",
      }),
  handler: async (args) => {
    // Keep ENABLE_PROCESSED_INPUT cleared even if other code flips it.
    // (Important when running under `bun run` wrappers on Windows.)
    const unguard = win32InstallCtrlCGuard()
    try {
      // Must be the very first thing — disables CTRL_C_EVENT before any Worker
      // spawn or async work so the OS cannot kill the process group.
      win32DisableProcessedInput()

      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exitCode = 1
        return
      }

      // Resolve relative --project paths from PWD, then use the real cwd after
      // chdir so the thread and worker share the same directory key.
      const root = Filesystem.resolve(process.env.PWD ?? process.cwd())
      const next = args.project
        ? Filesystem.resolve(path.isAbsolute(args.project) ? args.project : path.join(root, args.project))
        : Filesystem.resolve(process.cwd())
      const file = await target()

      if (args.ephemeral && args.worktree === undefined) {
        UI.error("--ephemeral requires --worktree")
        process.exitCode = 1
        return
      }

      let resolved = next
      let worktreeInfo: { name: string; branch: string; directory: string } | undefined
      if (args.worktree !== undefined) {
        try {
          worktreeInfo = await resolveWorktree(args.worktree || "", next)
          resolved = worktreeInfo.directory
        } catch (e) {
          UI.error(`Worktree failed: ${e instanceof Error ? e.message : e}`)
          process.exitCode = 1
          return
        }
      }

      try {
        process.chdir(resolved)
      } catch {
        UI.error("Failed to change directory to " + resolved)
        return
      }
      const cwd = Filesystem.resolve(process.cwd())

      const worker = new Worker(file, {
        env: Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
      })
      worker.onerror = (e) => {
        Log.Default.error(e)
      }

      const client = Rpc.client<typeof rpc>(worker)
      const error = (e: unknown) => {
        Log.Default.error(e)
      }
      const reload = () => {
        client.call("reload", undefined).catch((err) => {
          Log.Default.warn("worker reload failed", {
            error: errorMessage(err),
          })
        })
      }
      process.on("uncaughtException", error)
      process.on("unhandledRejection", error)
      process.on("SIGUSR2", reload)

      let stopped = false
      const stop = async () => {
        if (stopped) return
        stopped = true
        process.off("uncaughtException", error)
        process.off("unhandledRejection", error)
        process.off("SIGUSR2", reload)
        signals.forEach((sig) => process.off(sig, onSignal))
        await withTimeout(client.call("shutdown", undefined), 15_000).catch((error) => {
          Log.Default.warn("worker shutdown failed", {
            error: errorMessage(error),
          })
        })
        worker.terminate()
        if (args.ephemeral && worktreeInfo) {
          const patch = await ephemeralCleanup(worktreeInfo, next)
          if (patch.status === "conflict") {
            process.stderr.write(`Warning: patch conflict, branch ${patch.branch} preserved\n`)
          }
        }
      }

      // Graceful shutdown on terminal signals
      const onSignal = () => {
        stop().finally(() => process.exit(0))
      }
      const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"]
      signals.forEach((sig) => process.on(sig, onSignal))

      const prompt = await input(args.prompt)
      const config = await Instance.provide({
        directory: cwd,
        fn: () => TuiConfig.get(),
      })

      const network = await resolveNetworkOptions(args)
      const external =
        process.argv.includes("--port") ||
        process.argv.includes("--hostname") ||
        process.argv.includes("--mdns") ||
        network.mdns ||
        network.port !== 0 ||
        network.hostname !== "127.0.0.1"

      const transport = external
        ? {
            url: (await client.call("server", network)).url,
            fetch: undefined,
            events: undefined,
          }
        : {
            url: "http://opencode.internal",
            fetch: createWorkerFetch(client),
            events: createEventSource(client),
          }

      try {
        await validateSession({
          url: transport.url,
          sessionID: args.session,
          directory: cwd,
          fetch: transport.fetch,
        })
      } catch (error) {
        UI.error(errorMessage(error))
        process.exitCode = 1
        return
      }

      setTimeout(() => {
        client.call("checkUpgrade", { directory: cwd }).catch(() => {})
      }, 1000).unref?.()

      try {
        await tui({
          url: transport.url,
          async onSnapshot() {
            const tui = writeHeapSnapshot("tui.heapsnapshot")
            const server = await client.call("snapshot", undefined)
            return [tui, server]
          },
          config,
          directory: cwd,
          fetch: transport.fetch,
          events: transport.events,
          args: {
            continue: args.continue,
            sessionID: args.session,
            agent: args.agent,
            model: args.model,
            prompt,
            fork: args.fork,
          },
        })
      } finally {
        await stop()
      }
    } finally {
      unguard?.()
    }
    process.exit(0)
  },
})
