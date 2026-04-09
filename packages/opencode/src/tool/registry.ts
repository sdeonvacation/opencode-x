import { PlanExitTool } from "./plan"
import { QuestionTool } from "./question"
import { BashTool } from "./bash"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { ReadTool } from "./read"
import { TaskDescription, TaskTool } from "./task"
import { TodoWriteTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SkillDescription, SkillTool } from "./skill"
import { Tool } from "./tool"
import { Config } from "../config/config"
import { type ToolContext as PluginToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import z from "zod"
import { Plugin } from "../plugin"
import { ProviderID, type ModelID } from "../provider/schema"
import { WebSearchTool } from "./websearch"
import { CodeSearchTool } from "./codesearch"
import { Flag } from "@/flag/flag"
import { Log } from "@/util/log"
import { LspTool } from "./lsp"
import { Truncate } from "./truncate"
import { ApplyPatchTool } from "./apply_patch"
import { Glob } from "../util/glob"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer, ServiceMap } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { Env } from "../env"
import { Question } from "../question"
import { Todo } from "../session/todo"
import { LSP } from "../lsp"
import { FileTime } from "../file/time"
import { Instruction } from "../session/instruction"
import { AppFileSystem } from "../filesystem"
import { Agent } from "../agent/agent"
import { BatchTool } from "./batch"

export namespace ToolRegistry {
  const log = Log.create({ service: "tool.registry" })

  type TaskDef = Tool.InferDef<typeof TaskTool>
  type ReadDef = Tool.InferDef<typeof ReadTool>

  type State = {
    custom: Tool.Def[]
    pluginToolCount: number
    pluginHookID: WeakMap<object, number>
    pluginFunctionID: WeakMap<Function, number>
    pluginHookSeq: number
    cache?: ToolCacheEntry
  }

  type ToolCacheKey = {
    agentName: string
    providerID: ProviderID
    modelID: ModelID
    customToolCount: number
    pluginToolCount: number
    pluginDefinitionSignature: string
    batchTool: boolean
  }

  type ToolCacheDef = Omit<Tool.Def & { id: string }, "execute">

  type ToolCacheEntry = {
    key: ToolCacheKey
    definitions: ToolCacheDef[]
    executors: Map<string, Tool.Def["execute"]>
  }

  export interface Interface {
    readonly register: (tool: Tool.Info) => Effect.Effect<void>
    readonly ids: () => Effect.Effect<string[]>
    readonly named: { task: TaskDef; read: ReadDef }
    readonly tools: (model: {
      providerID: ProviderID
      modelID: ModelID
      agent?: Agent.Info
    }) => Effect.Effect<Tool.Def[]>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/ToolRegistry") {}

  export const layer: Layer.Layer<
    Service,
    never,
    | Config.Service
    | Plugin.Service
    | Question.Service
    | Todo.Service
    | Agent.Service
    | LSP.Service
    | FileTime.Service
    | Instruction.Service
    | AppFileSystem.Service
  > = Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service
      const plugin = yield* Plugin.Service

      const taskInfo = yield* TaskTool
      const readInfo = yield* ReadTool
      const questionInfo = yield* QuestionTool
      const todoInfo = yield* TodoWriteTool

      const builtin = yield* Effect.all({
        invalid: Tool.init(InvalidTool),
        bash: Tool.init(BashTool),
        read: Tool.init(readInfo),
        glob: Tool.init(GlobTool),
        grep: Tool.init(GrepTool),
        edit: Tool.init(EditTool),
        write: Tool.init(WriteTool),
        task: Tool.init(taskInfo),
        fetch: Tool.init(WebFetchTool),
        todo: Tool.init(todoInfo),
        search: Tool.init(WebSearchTool),
        code: Tool.init(CodeSearchTool),
        skill: Tool.init(SkillTool),
        patch: Tool.init(ApplyPatchTool),
        question: Tool.init(questionInfo),
        lsp: Tool.init(LspTool),
        batch: Tool.init(BatchTool),
        plan: Tool.init(PlanExitTool),
      })

      const state = yield* InstanceState.make<State>(
        Effect.fn("ToolRegistry.state")(function* (ctx) {
          const custom: Tool.Def[] = []

          function fromPlugin(id: string, def: ToolDefinition): Tool.Def {
            return {
              id,
              parameters: z.object(def.args),
              description: def.description,
              execute: async (args, toolCtx) => {
                const pluginCtx: PluginToolContext = {
                  ...toolCtx,
                  directory: ctx.directory,
                  worktree: ctx.worktree,
                }
                const result = await def.execute(args as any, pluginCtx)
                const out = await Truncate.output(result, {}, await Agent.get(toolCtx.agent))
                return {
                  title: "",
                  output: out.truncated ? out.content : result,
                  metadata: {
                    truncated: out.truncated,
                    outputPath: out.truncated ? out.outputPath : undefined,
                  },
                }
              },
            }
          }

          const dirs = yield* config.directories()
          const matches = dirs.flatMap((dir) =>
            Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }),
          )
          if (matches.length) yield* config.waitForDependencies()
          for (const match of matches) {
            const namespace = path.basename(match, path.extname(match))
            const mod = yield* Effect.promise(
              () => import(process.platform === "win32" ? match : pathToFileURL(match).href),
            )
            for (const [id, def] of Object.entries<ToolDefinition>(mod)) {
              custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
            }
          }

          const plugins = yield* plugin.list()
          let pluginToolCount = 0
          for (const p of plugins) {
            for (const [id, def] of Object.entries(p.tool ?? {})) {
              custom.push(fromPlugin(id, def))
              pluginToolCount++
            }
          }

          return {
            custom,
            pluginToolCount,
            pluginHookID: new WeakMap(),
            pluginFunctionID: new WeakMap(),
            pluginHookSeq: 1,
          }
        }),
      )

      function keyMatches(a: ToolCacheKey, b: ToolCacheKey) {
        return (
          a.agentName === b.agentName &&
          a.providerID === b.providerID &&
          a.modelID === b.modelID &&
          a.customToolCount === b.customToolCount &&
          a.pluginToolCount === b.pluginToolCount &&
          a.pluginDefinitionSignature === b.pluginDefinitionSignature &&
          a.batchTool === b.batchTool
        )
      }

      const pluginDefinitionSignature = Effect.fnUntraced(function* (s: State) {
        const hooks = yield* plugin.list()
        const ids: string[] = []
        for (const hook of hooks) {
          const fn = (hook as any)["tool.definition"]
          if (!fn) continue
          let hookID = s.pluginHookID.get(hook as object)
          if (!hookID) {
            hookID = s.pluginHookSeq++
            s.pluginHookID.set(hook as object, hookID)
            s.cache = undefined
          }
          let fnID = s.pluginFunctionID.get(fn as Function)
          if (!fnID) {
            fnID = s.pluginHookSeq++
            s.pluginFunctionID.set(fn as Function, fnID)
            s.cache = undefined
          }
          ids.push(`${hookID}:${fnID}`)
        }
        return ids.join(",")
      })

      const all = Effect.fn("ToolRegistry.all")(function* (custom: Tool.Def[]) {
        const cfg = yield* config.get()
        const questionEnabled =
          ["app", "cli", "desktop"].includes(Flag.OPENCODE_CLIENT) || Flag.OPENCODE_ENABLE_QUESTION_TOOL

        return [
          builtin.invalid,
          ...(questionEnabled ? [builtin.question] : []),
          builtin.bash,
          builtin.read,
          builtin.glob,
          builtin.grep,
          builtin.edit,
          builtin.write,
          builtin.task,
          builtin.fetch,
          builtin.todo,
          builtin.search,
          builtin.code,
          builtin.skill,
          builtin.patch,
          ...(Flag.OPENCODE_EXPERIMENTAL_LSP_TOOL ? [builtin.lsp] : []),
          ...(cfg.experimental?.batch_tool === true ? [builtin.batch] : []),
          ...(Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE && Flag.OPENCODE_CLIENT === "cli" ? [builtin.plan] : []),
          ...custom,
        ]
      })

      const register = Effect.fn("ToolRegistry.register")(function* (tool: Tool.Info) {
        const s = yield* InstanceState.get(state)
        const next = yield* Tool.init(tool)
        s.cache = undefined
        const idx = s.custom.findIndex((item) => item.id === tool.id)
        if (idx >= 0) {
          s.custom.splice(idx, 1, next)
          return
        }
        s.custom.push(next)
      })

      const ids = Effect.fn("ToolRegistry.ids")(function* () {
        const s = yield* InstanceState.get(state)
        return (yield* all(s.custom)).map((tool) => tool.id)
      })

      const tools: Interface["tools"] = Effect.fn("ToolRegistry.tools")(function* (input) {
        const s = yield* InstanceState.get(state)
        const cfg = yield* config.get()
        const pluginSignature = yield* pluginDefinitionSignature(s)
        const key: ToolCacheKey = {
          agentName: input.agent?.name ?? "",
          providerID: input.providerID,
          modelID: input.modelID,
          customToolCount: s.custom.length,
          pluginToolCount: s.pluginToolCount,
          pluginDefinitionSignature: pluginSignature,
          batchTool: cfg.experimental?.batch_tool === true,
        }
        const cache = s.cache
        if (cache && keyMatches(cache.key, key)) {
          return cache.definitions.map((def) => ({
            ...def,
            execute: cache.executors.get(def.id)!,
          }))
        }

        const filtered = (yield* all(s.custom)).filter((tool) => {
          if (tool.id === CodeSearchTool.id || tool.id === WebSearchTool.id) {
            return input.providerID === ProviderID.opencode || Flag.OPENCODE_ENABLE_EXA
          }

          const usePatch =
            !!Env.get("OPENCODE_E2E_LLM_URL") ||
            (input.modelID.includes("gpt-") && !input.modelID.includes("oss") && !input.modelID.includes("gpt-4"))
          if (tool.id === ApplyPatchTool.id) return usePatch
          if (tool.id === EditTool.id || tool.id === WriteTool.id) return !usePatch

          return true
        })

        const next = yield* Effect.forEach(
          filtered,
          Effect.fnUntraced(function* (tool: Tool.Def) {
            using _ = log.time(tool.id)
            const output = {
              description: tool.description,
              parameters: tool.parameters,
              parallelSafe: tool.parallelSafe,
            }
            yield* plugin.trigger("tool.definition", { toolID: tool.id }, output)
            return {
              id: tool.id,
              description: [
                output.description,
                input.agent && tool.id === TaskTool.id ? yield* TaskDescription(input.agent) : undefined,
                input.agent && tool.id === SkillTool.id ? yield* SkillDescription(input.agent) : undefined,
              ]
                .filter(Boolean)
                .join("\n"),
              parameters: output.parameters,
              parallelSafe: output.parallelSafe,
              execute: tool.execute,
              formatValidationError: tool.formatValidationError,
            }
          }),
          { concurrency: "unbounded" },
        )

        s.cache = {
          key,
          definitions: next.map((tool) => ({
            id: tool.id,
            description: tool.description,
            parameters: tool.parameters,
            parallelSafe: tool.parallelSafe,
            formatValidationError: tool.formatValidationError,
          })),
          executors: new Map(next.map((tool) => [tool.id, tool.execute])),
        }
        return next
      })

      return Service.of({ register, ids, named: { task: builtin.task, read: builtin.read }, tools })
    }),
  )

  export const defaultLayer: Layer.Layer<Service> = Layer.unwrap(
    Effect.sync(() =>
      layer.pipe(
        Layer.provide(Config.defaultLayer),
        Layer.provide(Plugin.defaultLayer),
        Layer.provide(Question.defaultLayer),
        Layer.provide(Todo.defaultLayer),
        Layer.provide(Agent.defaultLayer),
        Layer.provide(LSP.defaultLayer),
        Layer.provide(FileTime.defaultLayer),
        Layer.provide(Instruction.defaultLayer),
        Layer.provide(AppFileSystem.defaultLayer),
      ),
    ),
  )

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function register(tool: Tool.Info) {
    return runPromise((svc) => svc.register(tool))
  }

  export async function ids() {
    return runPromise((svc) => svc.ids())
  }

  export async function tools(input: {
    providerID: ProviderID
    modelID: ModelID
    agent?: Agent.Info
  }): Promise<(Tool.Def & { id: string })[]> {
    return runPromise((svc) => svc.tools(input))
  }
}
