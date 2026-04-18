import z from "zod"
import path from "path"
import { Effect, Option } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { generateObject } from "ai"
import { Provider } from "../provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { AppFileSystem } from "../filesystem"
import type { HybridRoutingConfig, ModelRef } from "./hybrid-types"

export type VerifyResult = {
  ok: boolean
  source: "command" | "autodetect" | "llm" | "none"
  warn?: boolean
  reason?: string
}

type CacheEntry = {
  commands: string[]
  expires_at: number
  stamp: string
}

// In-memory autodetect cache keyed by repoRoot
const cache = new Map<string, CacheEntry>()

function enoent(err: unknown) {
  if (typeof err !== "object" || err === null) return false
  if ("reason" in err && typeof err.reason === "object" && err.reason && "_tag" in err.reason)
    return err.reason._tag === "NotFound"
  if ("cause" in err && typeof err.cause === "object" && err.cause && "code" in err.cause)
    return err.cause.code === "ENOENT"
  if ("message" in err && typeof err.message === "string") return err.message.includes("ENOENT")
  return false
}

function message(err: unknown) {
  if (err instanceof Error) return err.message
  if (typeof err === "string") return err
  return "spawn failed"
}

const LLMVerifySchema = z.object({
  confidence: z.number().min(0).max(1),
  verified: z.boolean(),
  reason: z.string(),
})

/**
 * Probe repoRoot for available verification commands.
 * Checks package.json scripts (typecheck, build, test) and Makefile targets.
 */
export const autodetect = Effect.fn("Verify.autodetect")(function* (root: string) {
  const fs = yield* AppFileSystem.Service
  const cmds: string[] = []

  const pkgPath = path.join(root, "package.json")
  const hasPkg = yield* fs.exists(pkgPath).pipe(Effect.orElseSucceed(() => false))
  if (hasPkg) {
    const raw = yield* fs.readFileString(pkgPath).pipe(Effect.orElseSucceed(() => "{}"))
    const pkg = yield* Effect.sync(() => {
      try {
        return JSON.parse(raw) as Record<string, unknown>
      } catch {
        return {}
      }
    })
    const scripts = (pkg.scripts ?? {}) as Record<string, unknown>
    for (const name of ["typecheck", "build", "test"]) {
      if (scripts[name]) cmds.push(`bun run ${name}`)
    }
  }

  if (cmds.length === 0) {
    const makePath = path.join(root, "Makefile")
    const hasMake = yield* fs.exists(makePath).pipe(Effect.orElseSucceed(() => false))
    if (hasMake) cmds.push("make")
  }

  return cmds
})

const file = (fs: AppFileSystem.Interface, target: string) =>
  fs.stat(target).pipe(
    Effect.map((info) => `${Option.getOrUndefined(info.mtime)?.getTime() ?? "x"}:${Number(info.size)}`),
    Effect.catch(() => Effect.succeed("x:x")),
  )

export const stamp = Effect.fn("Verify.stamp")(function* (root: string) {
  const fs = yield* AppFileSystem.Service
  const pkg = yield* file(fs, path.join(root, "package.json"))
  const make = yield* file(fs, path.join(root, "Makefile"))
  return `${pkg}|${make}`
})

function spawnCmd(
  cmd: string,
  root: string,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
): Effect.Effect<{ code: number; enoent: boolean; reason?: string }, never> {
  return Effect.gen(function* () {
    const handle = yield* spawner
      .spawn(
        ChildProcess.make("sh", ["-c", cmd], {
          cwd: root,
          extendEnv: true,
          stdin: "ignore",
        }),
      )
      .pipe(
        Effect.catch((err) =>
          Effect.succeed({
            exitCode: undefined,
            enoent: enoent(err),
            reason: message(err),
          }),
        ),
      )
    if ("enoent" in handle) {
      if (handle.enoent) return { code: 1, enoent: true }
      return { code: 1, enoent: false, reason: handle.reason }
    }
    const code = yield* handle.exitCode.pipe(
      Effect.map(Number),
      Effect.catch(() => Effect.succeed(1)),
    )
    return { code, enoent: false }
  }).pipe(Effect.scoped)
}

async function llmVerify(
  root: string,
  base: { providerID: string; modelID: string },
): Promise<{ confidence: number; verified: boolean; reason: string }> {
  try {
    const model = await Provider.getModel(ProviderID.make(base.providerID), ModelID.make(base.modelID))
    const language = await Provider.getLanguage(model)
    const result = await generateObject({
      model: language,
      schema: LLMVerifySchema,
      messages: [
        {
          role: "user",
          content: `Verify that recent code changes in the repository at "${root}" are correct and complete. Return confidence (0-1), verified (bool), and reason.`,
        },
      ],
    })
    return result.object
  } catch {
    return { confidence: 0, verified: false, reason: "llm verification failed" }
  }
}

/**
 * Run verification after a code_change operation.
 * Priority: configured commands → autodetect → LLM
 *
 * Semantics:
 * - Configured command ENOENT → fallback to autodetect/LLM
 * - Configured command exits non-zero → hard fail, no fallback
 * - No commands → autodetect (cached) → LLM
 * - LLM confidence < 0.6 → { ok: false, warn: true }
 */
export const run = Effect.fn("Verify.run")(function* (
  cfg: HybridRoutingConfig,
  base: ModelRef,
  _sessionID: string,
  root: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  // 1. Configured commands
  if (cfg.verify_commands.length > 0) {
    let anyEnoent = false
    for (const cmd of cfg.verify_commands) {
      const r = yield* spawnCmd(cmd, root, spawner)
      if (r.reason) return { ok: false, source: "command", reason: r.reason }
      if (r.enoent) {
        anyEnoent = true
        break
      }
      if (r.code !== 0) {
        // Hard fail: command ran and failed
        return { ok: false, source: "command", reason: `exit code ${r.code}` }
      }
    }
    if (!anyEnoent) {
      // All configured commands passed
      return { ok: true, source: "command" }
    }
    // ENOENT → fall through to autodetect/LLM
  }

  // 2. Autodetect with cache
  const now = Date.now()
  const next = yield* stamp(root)
  const hit = cache.get(root)
  const detected =
    hit && hit.expires_at > now && hit.stamp === next
      ? hit.commands
      : yield* Effect.gen(function* () {
          const cmds = yield* autodetect(root)
          cache.set(root, { commands: cmds, expires_at: now + cfg.verify_cache_ttl_ms, stamp: next })
          return cmds
        })

  if (detected.length > 0) {
    for (const cmd of detected) {
      const r = yield* spawnCmd(cmd, root, spawner)
      if (r.reason) return { ok: false, source: "autodetect", reason: r.reason }
      if (r.enoent) continue
      if (r.code !== 0) {
        return { ok: false, source: "autodetect", reason: `exit code ${r.code}` }
      }
    }
    return { ok: true, source: "autodetect" }
  }

  // 3. LLM verification
  const llm = yield* Effect.promise(() => llmVerify(root, base))
  if (llm.confidence < 0.6) {
    return { ok: false, source: "llm", warn: true, reason: llm.reason }
  }
  return { ok: llm.verified, source: "llm", reason: llm.reason }
})
