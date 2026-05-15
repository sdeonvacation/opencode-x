import { Provider } from "@/provider/provider"
import { Auth } from "@/auth"
import { Log } from "@/util/log"
import { Effect } from "effect"
import { generateText, wrapLanguageModel } from "ai"
import type { CompressionTemplate } from "./route-classifier"
import { COMPRESSION_SYSTEM, COMPRESSION_TEMPLATES, listLines, validateCompression } from "./route-classifier"

const log = Log.create({ service: "llm.compress" })

export namespace LLMCompress {
  export type Input = {
    tool: string
    output: string
    template: CompressionTemplate
    model: Provider.Model
    threshold: number
    timeout: number
    maxTokens: number
  }

  export type Stats = {
    input_lines: number
    output_lines: number
    ratio: number
    template: string
    model: string
    fallback: boolean
    validated: boolean
    duration_ms: number
  }

  export type Result = {
    compressed: string
    stats: Stats
  }

  export const compress: (input: Input) => Effect.Effect<Result> = Effect.fn("LLMCompress.compress")(function* (
    input: Input,
  ) {
    const start = Date.now()
    return yield* Effect.tryPromise({
      try: () => doCompress(input, start),
      catch: (err) => err,
    }).pipe(
      Effect.catch((err) => {
        log.warn("compression_error", {
          tool: input.tool,
          error: String(err),
          fallback: true,
          duration_ms: Date.now() - start,
        })
        return Effect.succeed(fallback(input, start))
      }),
    )
  })

  async function doCompress(input: Input, start: number): Promise<Result> {
    const [language, , auth] = await Promise.all([
      Provider.getLanguage(input.model),
      Provider.getProvider(input.model.providerID),
      Auth.get(input.model.providerID),
    ])

    const response = await generateText({
      model: wrapLanguageModel({ model: language, middleware: [] }),
      system: COMPRESSION_SYSTEM,
      messages: [
        {
          role: "user",
          content: `${COMPRESSION_TEMPLATES[input.template]}\n\n${input.output}`,
        },
      ],
      temperature: 0,
      maxOutputTokens: input.maxTokens,
      abortSignal: AbortSignal.timeout(input.timeout),
    })

    const compressed = response.text
    const input_lines = listLines(input.output)
    const output_lines = listLines(compressed)
    const valid = validateCompression(input.output, compressed)

    if (!valid) {
      const reason = !compressed.trim() ? "empty_output" : "expansion"
      log.warn("compression_validation_failed", {
        tool: input.tool,
        reason,
        input_lines,
        output_lines,
        fallback: true,
        validated: false,
      })
      return fallback(input, start)
    }

    const stats: Stats = {
      input_lines,
      output_lines,
      ratio: input_lines === 0 ? 1.0 : output_lines / input_lines,
      template: input.template,
      model: input.model.id,
      fallback: false,
      validated: true,
      duration_ms: Date.now() - start,
    }

    log.info("compression", { tool: input.tool, ...stats })
    return { compressed, stats }
  }

  function fallback(input: Input, start: number): Result {
    const lines = listLines(input.output)
    return {
      compressed: input.output,
      stats: {
        input_lines: lines,
        output_lines: lines,
        ratio: 1.0,
        template: input.template,
        model: input.model.id,
        fallback: true,
        validated: false,
        duration_ms: Date.now() - start,
      },
    }
  }
}
