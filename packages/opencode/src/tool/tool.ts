import z from "zod"
import { Effect } from "effect"
import type { MessageV2 } from "../session/message-v2"
import type { Agent } from "../agent/agent"
import type { Permission } from "../permission"
import type { SessionID, MessageID } from "../session/schema"
import { Truncate } from "./truncate"

export namespace Tool {
  interface Metadata {
    [key: string]: any
  }

  // TODO: remove this hack
  export type DynamicDescription = (agent: Agent.Info) => Effect.Effect<string>

  export interface InitContext {
    agent?: Agent.Info
  }

  export type Context<M extends Metadata = Metadata> = {
    sessionID: SessionID
    messageID: MessageID
    agent: string
    abort: AbortSignal
    callID?: string
    extra?: { [key: string]: any }
    messages: MessageV2.WithParts[]
    metadata(input: { title?: string; metadata?: M }): void
    ask(input: Omit<Permission.Request, "id" | "sessionID" | "tool">): Promise<void>
  }

  export interface Def<Parameters extends z.ZodType = z.ZodType, M extends Metadata = Metadata> {
    id: string
    description: string
    parameters: Parameters
    parallelSafe?: boolean | ((input: z.infer<Parameters>) => boolean) // [fork-perf] function form for input-aware safety
    execute(
      args: z.infer<Parameters>,
      ctx: Context,
    ): Promise<{
      title: string
      metadata: M
      output: string
      attachments?: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[]
    }>
    formatValidationError?(error: z.ZodError): string
  }

  export type DefWithoutID<Parameters extends z.ZodType = z.ZodType, M extends Metadata = Metadata> = Omit<
    Def<Parameters, M>,
    "id"
  >

  export interface Info<Parameters extends z.ZodType = z.ZodType, M extends Metadata = Metadata> {
    id: string
    parallelSafe?: boolean | ((input: any) => boolean) // [fork-perf] function form for input-aware safety
    init: (ctx?: InitContext) => Promise<DefWithoutID<Parameters, M>>
  }

  /**
   * [fork-perf] Evaluate the parallelSafe field of a Tool.Info against a concrete input.
   * Returns false when undefined; calls the function when it is a predicate; returns the boolean as-is.
   */
  export function evalParallelSafe(info: Pick<Info, "parallelSafe">, input: any): boolean {
    const ps = info.parallelSafe
    if (ps === undefined) return false
    if (typeof ps === "function") return ps(input)
    return ps
  }

  export type InferParameters<T> =
    T extends Info<infer P, any>
      ? z.infer<P>
      : T extends Effect.Effect<Info<infer P, any>, any, any>
        ? z.infer<P>
        : never

  export type InferMetadata<T> =
    T extends Info<any, infer M> ? M : T extends Effect.Effect<Info<any, infer M>, any, any> ? M : never

  export type InferDef<T> =
    T extends Info<infer P, infer M>
      ? Def<P, M>
      : T extends Effect.Effect<Info<infer P, infer M>, any, any>
        ? Def<P, M>
        : never

  function wrap<Parameters extends z.ZodType, Result extends Metadata>(
    id: string,
    init: ((ctx?: InitContext) => Promise<DefWithoutID<Parameters, Result>>) | DefWithoutID<Parameters, Result>,
  ) {
    return async (initCtx?: InitContext) => {
      const toolInfo = init instanceof Function ? await init(initCtx) : { ...init }
      const execute = toolInfo.execute
      toolInfo.execute = async (args, ctx) => {
        try {
          toolInfo.parameters.parse(args)
        } catch (error) {
          if (error instanceof z.ZodError && toolInfo.formatValidationError) {
            throw new Error(toolInfo.formatValidationError(error), { cause: error })
          }
          throw new Error(
            `The ${id} tool was called with invalid arguments: ${error}.\nPlease rewrite the input so it satisfies the expected schema.`,
            { cause: error },
          )
        }
        const result = await execute(args, ctx)
        if (result.metadata.truncated !== undefined) {
          return result
        }
        const truncated = await Truncate.output(result.output, {}, initCtx?.agent)
        return {
          ...result,
          output: truncated.content,
          metadata: {
            ...result.metadata,
            truncated: truncated.truncated,
            ...(truncated.truncated && { outputPath: truncated.outputPath }),
          },
        }
      }
      return toolInfo
    }
  }

  export function define<Parameters extends z.ZodType, Result extends Metadata, ID extends string = string>(
    id: ID,
    init: ((ctx?: InitContext) => Promise<DefWithoutID<Parameters, Result>>) | DefWithoutID<Parameters, Result>,
    parallelSafeOverride?: boolean | ((input: any) => boolean), // [fork-perf] explicit override for function-based tool defs
  ): Info<Parameters, Result> & { id: ID } {
    return {
      id,
      parallelSafe: parallelSafeOverride ?? (init instanceof Function ? undefined : init.parallelSafe), // [fork-perf]
      init: wrap(id, init),
    }
  }

  export function defineEffect<Parameters extends z.ZodType, Result extends Metadata, R, ID extends string = string>(
    id: ID,
    init: Effect.Effect<
      ((ctx?: InitContext) => Promise<DefWithoutID<Parameters, Result>>) | DefWithoutID<Parameters, Result>,
      never,
      R
    >,
  ): Effect.Effect<Info<Parameters, Result>, never, R> & { id: ID } {
    return Object.assign(
      Effect.map(init, (next) => ({
        id,
        parallelSafe: next instanceof Function ? undefined : next.parallelSafe,
        init: wrap(id, next),
      })),
      { id },
    )
  }

  export function init<P extends z.ZodType, M extends Metadata>(
    info: Info<P, M>,
    ctx?: InitContext,
  ): Effect.Effect<Def<P, M>> {
    return Effect.gen(function* () {
      const init = yield* Effect.promise(() => info.init(ctx))
      return {
        ...init,
        id: info.id,
      }
    })
  }
}
