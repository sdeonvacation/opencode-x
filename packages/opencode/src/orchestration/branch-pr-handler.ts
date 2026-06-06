import { OrchestrationBranchPR, type WorktreeInfo } from "./branch-pr"
import { BranchPRState } from "./branch-pr-state"
import { BranchPREvent } from "./branch-pr-events"
import { OrchestrationEvent } from "./events"
import { acquire, release } from "./concurrency"
import { Bus } from "../bus"
import { Config } from "../config/config"
import { Instance, type InstanceContext } from "../project/instance"
import { SessionPrompt } from "../session/prompt"
import { withTimeout } from "@/util/timeout"
import { ModelID, ProviderID } from "../provider/schema"
import { Log } from "../util/log"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { BackgroundJob } from "@/background/job"
import { makeRuntime } from "@/effect/run-service"
import { Effect } from "effect"
import type { Tool } from "../tool/tool"
import type { Agent } from "../agent/agent"
import type { SessionID, MessageID } from "../session/schema"

const SUBAGENT_TIMEOUT = 1_800_000

type PRReviewOutput = {
  pr_id: string
  worktree_id: string
  base: string
  summary: string
  diff: {
    files_changed: number
    insertions: number
    deletions: number
    files: Array<{ path: string; status: string; patch: string }>
  }
  actions: { approve: string; reject: string }
}

type ExecuteParams = {
  description: string
  prompt: string
  subagent_type: string
  task_id?: string
  background?: boolean
  pr_action?: "approve" | "reject"
}

type ExecuteOpts = {
  session: { id: SessionID }
  model: { modelID: string; providerID: string }
  agent: Agent.Info
  guard: { before(input: any): Promise<void> }
  concurrencyKey: string
  concurrencyLimit: number
  parentVariant: string | undefined
  messageID: MessageID
  promptParts: SessionPrompt.PromptInput["parts"]
}

type ExecuteResult = { title: string; metadata: any; output: string }

const log = Log.create({ service: "branch-pr-handler" })
const bgRuntime = makeRuntime(BackgroundJob.Service, BackgroundJob.defaultLayer)

function output(session: SessionID, text: string) {
  return [
    `task_id: ${session} (for resuming to continue this task if needed)`,
    "",
    "<task_result>",
    text,
    "</task_result>",
  ].join("\n")
}

function backgroundOutput(session: SessionID) {
  return [
    `task_id: ${session} (for polling this task with task_status)`,
    "state: running",
    "",
    "<task_result>",
    "Background task launched. If you have more independent tasks to launch, emit them NOW in this same response. Do not narrate between Task calls.",
    "</task_result>",
  ].join("\n")
}

function errorText(err: unknown) {
  if (err instanceof Error) return err.message
  return String(err)
}

function worktreeFromRow(row: { id: string; branch: string; base: string }): WorktreeInfo {
  return { id: row.id, worktree: row.branch, base: row.base, cwd: Instance.directory }
}

export namespace branchPRHandler {
  export async function execute(params: ExecuteParams, ctx: Tool.Context, opts: ExecuteOpts): Promise<ExecuteResult> {
    ensureSweep()
    if (params.pr_action) {
      return handleAction(params, ctx, opts)
    }
    if (params.background) {
      return handleBackground(params, ctx, opts)
    }
    return handleForeground(params, ctx, opts)
  }
}

async function handleAction(params: ExecuteParams, ctx: Tool.Context, opts: ExecuteOpts): Promise<ExecuteResult> {
  const rows = BranchPRState.pending(ctx.sessionID)

  if (!params.task_id && rows.length > 1) {
    const list = rows.map((r) => `  - task_id: "${r.session_id}" (${r.slug})`).join("\n")
    throw new Error(`Multiple pending PRs. Specify task_id:\n${list}`)
  }

  const target = params.task_id ? rows.find((r) => r.session_id === params.task_id) : rows[0]

  if (!target) {
    throw new Error("No pending branch-pr found for this session")
  }

  if (params.pr_action === "approve") {
    const worktree = worktreeFromRow(target)

    // Verify worktree still exists before attempting apply
    const exists = await Bun.file(worktree.worktree + "/.git").exists()
    if (!exists) {
      BranchPRState.update({ id: target.id, state: "rejected", note: "Worktree expired" })
      return {
        title: params.description,
        metadata: { pr_id: target.id, action: "approve", expired: true },
        output: output(
          opts.session.id,
          JSON.stringify(
            {
              pr_id: target.id,
              state: "expired",
              message: "Worktree no longer exists (expired or cleaned up). Reject and re-dispatch the subagent.",
              actions: { reject: `Use pr_action: "reject" with task_id: "${params.task_id}" to close this PR` },
            },
            null,
            2,
          ),
        ),
      }
    }

    const result = await OrchestrationBranchPR.apply({ worktree })

    if (result.conflicts.length > 0) {
      BranchPRState.update({ id: target.id, state: "conflict", note: `Conflicts: ${result.conflicts.join(", ")}` })

      await Bus.publish(BranchPREvent.Conflict, {
        id: target.id,
        sessionID: target.session_id,
        branch: target.branch,
        files: result.conflicts,
      })

      const conflict = {
        pr_id: target.id,
        state: "conflict",
        applied_files: result.applied,
        conflicting_files: result.conflicts,
        message: `${result.conflicts.length} file(s) conflict — modified since this subagent started.`,
        actions: {
          reject: `Use pr_action: "reject" with task_id: "${params.task_id}" to discard`,
          retry: "Reject this PR, then re-dispatch the subagent — it will see the current file state",
        },
      }

      return {
        title: params.description,
        metadata: { pr_id: target.id, action: "approve", conflict: true },
        output: output(opts.session.id, JSON.stringify(conflict, null, 2)),
      }
    }

    BranchPRState.update({ id: target.id, state: "merged", mergedAt: Date.now() })

    await Bus.publish(BranchPREvent.Merged, {
      id: target.id,
      sessionID: target.session_id,
      branch: target.branch,
      strategy: "file-apply",
    })

    // Cleanup worktree after successful apply
    await OrchestrationBranchPR.cleanup({ worktree }).catch(() => {})

    return {
      title: params.description,
      metadata: { pr_id: target.id, action: "approve", applied: true },
      output: output(opts.session.id, `Applied ${result.applied.length} file(s) to working directory.`),
    }
  }

  // reject — cleanup preserved worktree
  const worktree = worktreeFromRow(target)
  await OrchestrationBranchPR.cleanup({ worktree }).catch(() => {})

  BranchPRState.update({ id: target.id, state: "rejected", note: "Rejected by user" })

  await Bus.publish(BranchPREvent.Rejected, {
    id: target.id,
    sessionID: target.session_id,
    branch: target.branch,
    reason: "Rejected by user",
  })

  return {
    title: params.description,
    metadata: { pr_id: target.id, action: "reject" },
    output: output(opts.session.id, `PR ${target.id} rejected. Worktree cleaned up.`),
  }
}

async function handleForeground(params: ExecuteParams, ctx: Tool.Context, opts: ExecuteOpts): Promise<ExecuteResult> {
  const cfg = await Config.get()
  const timeout = cfg.experimental?.subagent_timeout ?? SUBAGENT_TIMEOUT

  const worktree = await OrchestrationBranchPR.create({
    session: opts.session.id,
    cwd: Instance.directory,
    slug: params.description,
  })

  const worktreeCtx: InstanceContext = {
    ...Instance.current,
    directory: worktree.worktree,
    pathRemapFrom: Instance.directory,
  }

  // Push-to-background resilience: if parent is cancelled but child completes via
  // session lifecycle, this subscriber handles diff/PR-insert.
  // Intentional: push-to-background always creates review PR regardless of auto_merge config.
  let handled = false
  const unsub = Bus.subscribe(OrchestrationEvent.Complete, async (event) => {
    if (event.properties.sessionID !== opts.session.id) return
    if (handled) return
    handled = true
    try {
      const diff = await OrchestrationBranchPR.diff({
        worktree,
        maxLines: cfg.experimental?.branch_pr_max_diff_lines,
      })

      if (diff.files_changed === 0) {
        await OrchestrationBranchPR.cleanup({ worktree }).catch(() => {})
        return
      }

      const id = crypto.randomUUID()
      BranchPRState.insert({
        id,
        session_id: opts.session.id,
        parent_session_id: ctx.sessionID,
        branch: worktree.worktree,
        base: worktree.base,
        slug: params.description,
        state: "open",
        diff_summary: `${diff.files_changed} files, +${diff.insertions} -${diff.deletions}`,
        review_note: null,
        created_at: Date.now(),
      })
      await Bus.publish(BranchPREvent.Ready, {
        id,
        sessionID: opts.session.id,
        parentSessionID: ctx.sessionID,
        branch: worktree.worktree,
        filesChanged: diff.files_changed,
        insertions: diff.insertions,
        deletions: diff.deletions,
      })
      await Bus.publish(TuiEvent.ToastShow, {
        title: "Branch PR ready",
        message: `"${params.description}" ready for review (pushed to background)`,
        variant: "success",
        duration: 5000,
      })
      // Worktree preserved for later apply on approve
    } catch (err) {
      log.error("push-to-bg subscriber failed", { error: err instanceof Error ? err.message : String(err) })
      await OrchestrationBranchPR.cleanup({ worktree }).catch(() => {})
    } finally {
      unsub()
    }
  })

  function cancel() {
    SessionPrompt.cancel(opts.session.id)
  }
  ctx.abort.addEventListener("abort", cancel)

  let success = false
  try {
    await opts.guard.before({
      toolName: "task",
      input: { prompt: params.prompt, subagent_type: params.subagent_type },
    })

    await acquire(opts.concurrencyKey, opts.concurrencyLimit, ctx.abort)
    let result: Awaited<ReturnType<typeof SessionPrompt.prompt>>
    const promptCall = () =>
      SessionPrompt.prompt({
        messageID: opts.messageID,
        sessionID: opts.session.id,
        model: {
          modelID: ModelID.make(opts.model.modelID),
          providerID: ProviderID.make(opts.model.providerID),
        },
        variant: opts.parentVariant,
        agent: opts.agent.name,
        tools: { todowrite: false, task: false, goal_complete: false },
        parts: opts.promptParts,
      })

    try {
      result = await withTimeout(
        Instance.restore(worktreeCtx, () => promptCall()),
        timeout,
      ).catch((err) => {
        if (err instanceof Error && err.message.includes("Operation timed out")) {
          cancel()
          throw new Error(`Subagent timed out after ${timeout}ms`)
        }
        throw err
      })
    } finally {
      release(opts.concurrencyKey)
    }

    // Must unsub before publishing Complete (prevents double-fire from synchronous subscriber)
    handled = true
    unsub()

    const diff = await OrchestrationBranchPR.diff({
      worktree,
      maxLines: cfg.experimental?.branch_pr_max_diff_lines,
    })

    if (diff.files_changed === 0) {
      await OrchestrationBranchPR.cleanup({ worktree }).catch(() => {})
      const text = result.parts.findLast((p) => p.type === "text")?.text ?? ""
      return {
        title: params.description,
        metadata: { sessionId: opts.session.id },
        output: output(opts.session.id, text),
      }
    }

    const id = crypto.randomUUID()

    BranchPRState.insert({
      id,
      session_id: opts.session.id,
      parent_session_id: ctx.sessionID,
      branch: worktree.worktree,
      base: worktree.base,
      slug: params.description,
      state: "open",
      diff_summary: `${diff.files_changed} files, +${diff.insertions} -${diff.deletions}`,
      review_note: null,
      created_at: Date.now(),
    })

    await Bus.publish(BranchPREvent.Created, {
      id,
      sessionID: opts.session.id,
      parentSessionID: ctx.sessionID,
      branch: worktree.worktree,
      slug: params.description,
    })

    await Bus.publish(OrchestrationEvent.Complete, {
      sessionID: opts.session.id,
      parentSessionID: ctx.sessionID,
      agent: opts.agent.name,
      durationMs: 0,
    })

    // Review path — return structured PR output (worktree preserved for later apply)
    const review: PRReviewOutput = {
      pr_id: id,
      worktree_id: worktree.id,
      base: worktree.base,
      summary: `${diff.files_changed} files changed, +${diff.insertions} -${diff.deletions}`,
      diff: {
        files_changed: diff.files_changed,
        insertions: diff.insertions,
        deletions: diff.deletions,
        files: diff.files.map((f) => ({ path: f.path, status: f.status, patch: f.patch })),
      },
      actions: {
        approve: `Use pr_action: "approve" with task_id: "${opts.session.id}" to apply changes`,
        reject: `Use pr_action: "reject" with task_id: "${opts.session.id}" to reject`,
      },
    }

    success = true
    return {
      title: params.description,
      metadata: { sessionId: opts.session.id, pr_id: id },
      output: output(opts.session.id, JSON.stringify(review, null, 2)),
    }
  } finally {
    ctx.abort.removeEventListener("abort", cancel)
    handled = true
    unsub()
    if (!success) {
      // Only cleanup on error — worktree preserved on success for later apply/reject
      OrchestrationBranchPR.cleanup({ worktree }).catch(() => {})
    }
  }
}

async function handleBackground(params: ExecuteParams, ctx: Tool.Context, opts: ExecuteOpts): Promise<ExecuteResult> {
  const metadata = { sessionId: opts.session.id, background: true }

  const runTask = async (): Promise<string> => {
    const cfg = await Config.get()
    const timeout = cfg.experimental?.subagent_timeout ?? SUBAGENT_TIMEOUT

    const worktree = await OrchestrationBranchPR.create({
      session: opts.session.id,
      cwd: Instance.directory,
      slug: params.description,
    })

    const worktreeCtx: InstanceContext = {
      ...Instance.current,
      directory: worktree.worktree,
      pathRemapFrom: Instance.directory,
    }

    try {
      await opts.guard.before({
        toolName: "task",
        input: { prompt: params.prompt, subagent_type: params.subagent_type },
      })

      await acquire(opts.concurrencyKey, opts.concurrencyLimit)
      try {
        const promptCall = () =>
          SessionPrompt.prompt({
            messageID: opts.messageID,
            sessionID: opts.session.id,
            model: {
              modelID: ModelID.make(opts.model.modelID),
              providerID: ProviderID.make(opts.model.providerID),
            },
            variant: opts.parentVariant,
            agent: opts.agent.name,
            tools: { todowrite: false, task: false, goal_complete: false },
            parts: opts.promptParts,
          })

        await withTimeout(
          Instance.restore(worktreeCtx, () => promptCall()),
          timeout,
        ).catch((err) => {
          if (err instanceof Error && err.message.includes("Operation timed out")) {
            SessionPrompt.cancel(opts.session.id)
            throw new Error(`Subagent timed out after ${timeout}ms`)
          }
          throw err
        })
      } finally {
        release(opts.concurrencyKey)
      }

      const diff = await OrchestrationBranchPR.diff({
        worktree,
        maxLines: cfg.experimental?.branch_pr_max_diff_lines,
      })

      if (diff.files_changed === 0) {
        await OrchestrationBranchPR.cleanup({ worktree }).catch(() => {})
        return `No file changes — subagent completed without modifications.`
      }

      const id = crypto.randomUUID()

      BranchPRState.insert({
        id,
        session_id: opts.session.id,
        parent_session_id: ctx.sessionID,
        branch: worktree.worktree,
        base: worktree.base,
        slug: params.description,
        state: "open",
        diff_summary: `${diff.files_changed} files, +${diff.insertions} -${diff.deletions}`,
        review_note: null,
        created_at: Date.now(),
      })

      await Bus.publish(BranchPREvent.Ready, {
        id,
        sessionID: opts.session.id,
        parentSessionID: ctx.sessionID,
        branch: worktree.worktree,
        filesChanged: diff.files_changed,
        insertions: diff.insertions,
        deletions: diff.deletions,
      })

      // Worktree preserved for later apply on approve
      return `Branch PR ready: ${worktree.id} (${diff.files_changed} files, +${diff.insertions} -${diff.deletions})`
    } catch (err) {
      // Cleanup on failure
      await OrchestrationBranchPR.cleanup({ worktree }).catch(() => {})
      throw err
    }
  }

  const inject = Instance.bind(async (state: "completed" | "error", text: string) => {
    try {
      await Bus.publish(TuiEvent.BackgroundTaskUpdate, {
        sessionID: ctx.sessionID,
        taskID: opts.session.id,
        title: params.description,
        state,
      })
      await Bus.publish(TuiEvent.ToastShow, {
        title: state === "completed" ? "Branch PR ready" : "Branch PR failed",
        message:
          state === "completed"
            ? `Branch PR "${params.description}" ready for review.`
            : `Branch PR "${params.description}" failed.`,
        variant: state === "completed" ? "success" : "error",
        duration: 5000,
      })
    } catch (err) {
      log.error("inject failed", {
        sessionID: ctx.sessionID,
        state,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })

  const makeRun = () =>
    Effect.tryPromise({
      try: () => runTask(),
      catch: (err) => err,
    }).pipe(
      Effect.tap((text) => Effect.promise(() => inject("completed", text)).pipe(Effect.ignore)),
      Effect.catch((cause: unknown) =>
        Effect.gen(function* () {
          const err = errorText(cause)
          yield* Effect.promise(() => inject("error", err)).pipe(Effect.ignore)
          return yield* Effect.fail(cause)
        }),
      ),
    )

  await bgRuntime.runPromise((svc) =>
    svc.start({
      id: opts.session.id,
      type: "branch-pr",
      title: params.description,
      metadata,
      run: makeRun(),
    }),
  )

  await Bus.publish(TuiEvent.BackgroundTaskUpdate, {
    sessionID: ctx.sessionID,
    taskID: opts.session.id,
    title: params.description,
    state: "running",
  })

  return {
    title: params.description,
    metadata: { ...metadata, jobId: opts.session.id },
    output: backgroundOutput(opts.session.id),
  }
}

// Lazy sweep — clean orphan worktrees once on first execute() call
let swept = false
async function ensureSweep() {
  if (swept) return
  swept = true
  try {
    const cfg = await Config.get()
    if (!cfg.experimental?.branch_pr_review) return
    const ttl = (cfg.experimental?.branch_pr_ttl_hours ?? 24) * 60 * 60 * 1000
    await OrchestrationBranchPR.sweep({ cwd: Instance.directory, ttl })
    // Close stale "open" PRs whose worktree no longer exists
    try {
      const cutoff = Date.now() - ttl
      const stale = BranchPRState.stale(cutoff)
      for (const pr of stale) {
        const exists = await Bun.file(pr.branch + "/.git").exists()
        if (!exists) {
          BranchPRState.update({ id: pr.id, state: "rejected", note: "Auto-closed: worktree missing (interrupted)" })
        }
      }
    } catch {
      // Silent — stale cleanup is best-effort
    }
  } catch {
    // Silent — sweep is best-effort
  }
}
