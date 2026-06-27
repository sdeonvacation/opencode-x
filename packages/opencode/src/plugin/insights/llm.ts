import { generateText } from "ai"
import type { LanguageModelV3 } from "@ai-sdk/provider"

export interface LlmCallOptions {
  model: LanguageModelV3
  prompt: string
  system?: string
  timeout?: number
}

export class JsonParseError extends Error {
  readonly raw: string
  constructor(message: string, raw: string) {
    super(message)
    this.name = "JsonParseError"
    this.raw = raw
  }
}

export async function callLlm(opts: LlmCallOptions): Promise<string> {
  const response = await generateText({
    model: opts.model,
    system: opts.system,
    messages: [{ role: "user", content: opts.prompt }],
    temperature: 0,
    maxOutputTokens: 4096,
    abortSignal: AbortSignal.timeout(opts.timeout ?? 30_000),
  })
  return response.text
}

export function extractJson(text: string): unknown {
  // Strip markdown code fences
  let cleaned = text.trim()
  if (cleaned.startsWith("```")) {
    const firstNewline = cleaned.indexOf("\n")
    if (firstNewline !== -1) cleaned = cleaned.slice(firstNewline + 1)
  }
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.slice(0, cleaned.lastIndexOf("```"))
  }
  cleaned = cleaned.trim()

  // Try array as well
  const startObj = cleaned.indexOf("{")
  const startArr = cleaned.indexOf("[")
  const start = startObj === -1 ? startArr : startArr === -1 ? startObj : Math.min(startObj, startArr)
  const endObj = cleaned.lastIndexOf("}")
  const endArr = cleaned.lastIndexOf("]")
  const end = endObj === -1 ? endArr : endArr === -1 ? endObj : Math.max(endObj, endArr)

  if (start === -1 || end === -1 || end <= start) {
    throw new JsonParseError("No JSON object found in text", text)
  }

  const raw = cleaned.slice(start, end + 1)
  try {
    return JSON.parse(raw)
  } catch {
    throw new JsonParseError("Failed to parse JSON", raw)
  }
}

export function extractJsonSafe(text: string, fallback: unknown = {}): unknown {
  try {
    return extractJson(text)
  } catch {
    return fallback
  }
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0

  const worker = async () => {
    while (nextIndex < items.length) {
      const idx = nextIndex++
      results[idx] = await fn(items[idx], idx)
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}
