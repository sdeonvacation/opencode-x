import { Effect, Layer, ServiceMap, Stream } from "effect"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { FileWatcher } from "@/file/watcher"
import { Git } from "@/git"
import { Log } from "@/util/log"
import { Instance } from "./instance"
import z from "zod"

export namespace Vcs {
  const log = Log.create({ service: "vcs" })

  const PATCH_CONTEXT_LINES = 2_147_483_647
  const MAX_PATCH_BYTES = 10_000_000
  const MAX_TOTAL_PATCH_BYTES = 10_000_000

  const merge = (...lists: Git.Item[][]) => {
    const out = new Map<string, Git.Item>()
    lists.flat().forEach((item) => {
      if (!out.has(item.file)) out.set(item.file, item)
    })
    return [...out.values()]
  }

  const emptyPatch = () => ({ text: "", truncated: false }) satisfies Git.Patch

  const emptyBatch = (): FileDiff[] => []

  const parseQuotedPath = (s: string): string => {
    if (!s.startsWith('"')) return s
    return s
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
      .replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(Number.parseInt(oct, 8)))
  }

  const parsePathToken = (token: string): string => parseQuotedPath(token.trim())

  const fileFromDiffPath = (raw: string): string => {
    const p = raw.trim()
    if (p.startsWith("a/") || p.startsWith("b/")) return parseQuotedPath(p.slice(2))
    return parseQuotedPath(p)
  }

  const fileFromGitHeader = (line: string): string | undefined => {
    const m = line.match(/^diff --git (.+) (.+)$/)
    if (!m) return
    return fileFromDiffPath(m[2])
  }

  const fileFromPatchChunk = (chunk: string): string | undefined => {
    for (const line of chunk.split("\n")) {
      if (line.startsWith("diff --git ")) return fileFromGitHeader(line)
    }
  }

  const splitGitPatch = (text: string): Map<string, string> => {
    const out = new Map<string, string>()
    const parts = text.split(/(?=^diff --git )/m)
    for (const part of parts) {
      if (!part.startsWith("diff --git ")) continue
      const file = fileFromPatchChunk(part)
      if (file) out.set(file, part)
    }
    return out
  }

  const batchPatches = (items: Git.Item[], patch: Git.Patch): FileDiff[] => {
    if (patch.truncated) return emptyBatch()
    const map = splitGitPatch(patch.text)
    return items.map((item) => ({
      file: item.file,
      patch: map.get(item.file) ?? "",
      additions: 0,
      deletions: 0,
      status: item.status,
    }))
  }

  const nativePatch = Effect.fnUntraced(function* (git: Git.Interface, cwd: string, ref: string, file: string) {
    return yield* git.patch(cwd, ref, file, {
      context: PATCH_CONTEXT_LINES,
      maxOutputBytes: MAX_PATCH_BYTES,
    })
  })

  const totalPatch = Effect.fnUntraced(function* (git: Git.Interface, cwd: string, ref: string) {
    return yield* git.patchAll(cwd, ref, {
      context: PATCH_CONTEXT_LINES,
      maxOutputBytes: MAX_TOTAL_PATCH_BYTES,
    })
  })

  const patchForItem = Effect.fnUntraced(function* (git: Git.Interface, cwd: string, item: Git.Item) {
    if (item.status === "added")
      return yield* git.patchUntracked(cwd, item.file, {
        context: PATCH_CONTEXT_LINES,
        maxOutputBytes: MAX_PATCH_BYTES,
      })
    return emptyPatch()
  })

  const files = Effect.fnUntraced(function* (
    git: Git.Interface,
    cwd: string,
    ref: string | undefined,
    list: Git.Item[],
  ) {
    if (!ref) {
      const patches = yield* Effect.forEach(list, (item) => patchForItem(git, cwd, item), { concurrency: 8 })
      return list
        .map((item, i) => ({
          file: item.file,
          patch: patches[i].text,
          additions: 0,
          deletions: 0,
          status: item.status,
        }))
        .toSorted((a, b) => a.file.localeCompare(b.file))
    }
    const batch = yield* totalPatch(git, cwd, ref)
    if (!batch.truncated) {
      return batchPatches(list, batch).toSorted((a, b) => a.file.localeCompare(b.file))
    }
    const patches = yield* Effect.forEach(
      list,
      (item) => (item.status === "added" ? patchForItem(git, cwd, item) : nativePatch(git, cwd, ref, item.file)),
      { concurrency: 8 },
    )
    return list
      .map((item, i) => ({
        file: item.file,
        patch: patches[i].text,
        additions: 0,
        deletions: 0,
        status: item.status,
      }))
      .toSorted((a, b) => a.file.localeCompare(b.file))
  })

  const track = Effect.fnUntraced(function* (git: Git.Interface, cwd: string, ref: string | undefined) {
    return yield* files(git, cwd, ref, yield* git.status(cwd))
  })

  const diffAgainstRef = Effect.fnUntraced(function* (git: Git.Interface, cwd: string, ref: string) {
    const [list, extra] = yield* Effect.all([git.diff(cwd, ref), git.status(cwd)], { concurrency: 2 })
    return yield* files(
      git,
      cwd,
      ref,
      merge(
        list,
        extra.filter((item) => item.code === "??"),
      ),
    )
  })

  export const Mode = z.enum(["git", "branch"])
  export type Mode = z.infer<typeof Mode>

  export const Event = {
    BranchUpdated: BusEvent.define(
      "vcs.branch.updated",
      z.object({
        branch: z.string().optional(),
      }),
    ),
  }

  export const Info = z
    .object({
      branch: z.string().optional(),
      default_branch: z.string().optional(),
    })
    .meta({
      ref: "VcsInfo",
    })
  export type Info = z.infer<typeof Info>

  export const FileDiff = z
    .object({
      file: z.string(),
      patch: z.string(),
      additions: z.number(),
      deletions: z.number(),
      status: z.enum(["added", "deleted", "modified"]).optional(),
    })
    .meta({
      ref: "VcsFileDiff",
    })
  export type FileDiff = z.infer<typeof FileDiff>

  export interface Interface {
    readonly init: () => Effect.Effect<void>
    readonly branch: () => Effect.Effect<string | undefined>
    readonly defaultBranch: () => Effect.Effect<string | undefined>
    readonly diff: (mode: Mode) => Effect.Effect<FileDiff[]>
  }

  interface State {
    current: string | undefined
    root: Git.Base | undefined
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Vcs") {}

  export const layer: Layer.Layer<Service, never, Git.Service | Bus.Service> = Layer.effect(
    Service,
    Effect.gen(function* () {
      const git = yield* Git.Service
      const bus = yield* Bus.Service

      const state = yield* InstanceState.make<State>(
        Effect.fn("Vcs.state")(function* (ctx) {
          if (ctx.project.vcs !== "git") {
            return { current: undefined, root: undefined }
          }

          const get = Effect.fnUntraced(function* () {
            return yield* git.branch(ctx.directory)
          })
          const [current, root] = yield* Effect.all([git.branch(ctx.directory), git.defaultBranch(ctx.directory)], {
            concurrency: 2,
          })
          const value = { current, root }
          log.info("initialized", { branch: value.current, default_branch: value.root?.name })

          yield* bus.subscribe(FileWatcher.Event.Updated).pipe(
            Stream.filter((evt) => evt.properties.file.endsWith("HEAD")),
            Stream.runForEach((_evt) =>
              Effect.gen(function* () {
                const next = yield* get()
                if (next !== value.current) {
                  log.info("branch changed", { from: value.current, to: next })
                  value.current = next
                  yield* bus.publish(Event.BranchUpdated, { branch: next })
                }
              }),
            ),
            Effect.forkScoped,
          )

          return value
        }),
      )

      return Service.of({
        init: Effect.fn("Vcs.init")(function* () {
          yield* InstanceState.get(state)
        }),
        branch: Effect.fn("Vcs.branch")(function* () {
          return yield* InstanceState.use(state, (x) => x.current)
        }),
        defaultBranch: Effect.fn("Vcs.defaultBranch")(function* () {
          return yield* InstanceState.use(state, (x) => x.root?.name)
        }),
        diff: Effect.fn("Vcs.diff")(function* (mode: Mode) {
          const value = yield* InstanceState.get(state)
          if (Instance.project.vcs !== "git") return []
          if (mode === "git") {
            return yield* track(git, Instance.directory, (yield* git.hasHead(Instance.directory)) ? "HEAD" : undefined)
          }

          if (!value.root) return []
          if (value.current && value.current === value.root.name) return []
          const ref = yield* git.mergeBase(Instance.directory, value.root.ref)
          if (!ref) return []
          return yield* diffAgainstRef(git, Instance.directory, ref)
        }),
      })
    }),
  )

  const defaultLayer = layer.pipe(Layer.provide(Git.defaultLayer), Layer.provide(Bus.layer))

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function init() {
    return runPromise((svc) => svc.init())
  }

  export async function branch() {
    return runPromise((svc) => svc.branch())
  }

  export async function defaultBranch() {
    return runPromise((svc) => svc.defaultBranch())
  }

  export async function diff(mode: Mode) {
    return runPromise((svc) => svc.diff(mode))
  }
}
