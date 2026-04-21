import { Auth } from "@/auth"
import type { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import type { RouteLogEntry } from "@/session/route-logger"
import type { ModelMessage, Tool } from "ai"

export type RouteCategory = "LOCAL_ONLY" | "CLOUD_ONLY" | "SPLIT"
export type Route = "cloud" | "local"

export type RouteDecision = {
  route: Route
  reason: string
  tool?: string
  complexity?: "simple" | "complex" | "unknown"
  lineCount?: number
}

export type ClassifyInput = {
  enabled: boolean
  toolName?: string
  toolOutput?: string
  toolInput?: Record<string, unknown>
}

export const LOCAL_ONLY_TOOLS = new Set(["grep", "glob", "read", "list"])
export const CLOUD_ONLY_TOOLS = new Set(["edit", "write", "multiedit", "apply_patch", "task", "todowrite"])

const SIMPLE = [
  "git status",
  "git log",
  "git diff",
  "git branch",
  "git show",
  "python -m pytest",
  "npm test",
  "bun test",
  "yarn test",
  "pnpm test",
  "npm run",
  "bun run",
  "cargo test",
  "go test",
  "pytest",
  "echo",
  "ls",
  "env",
  "cat",
  "pwd",
  "tree",
  "find",
  "grep",
  "make",
]

const LINE_LIMIT = 200

type Part = {
  type?: string
  toolCallId?: string
  toolName?: string
  input?: Record<string, unknown>
  content?: unknown
  output?: unknown
}

type Context = {
  toolName: string
  toolCallId?: string
  input?: Record<string, unknown>
  output?: string
}

type Resolved = {
  route: Route
  model: Provider.Model
  language: Awaited<ReturnType<typeof Provider.getLanguage>>
  provider: Awaited<ReturnType<typeof Provider.getProvider>>
  auth: Awaited<ReturnType<typeof Auth.get>>
}

export function category(tool: string): RouteCategory | undefined {
  if (LOCAL_ONLY_TOOLS.has(tool)) return "LOCAL_ONLY"
  if (CLOUD_ONLY_TOOLS.has(tool)) return "CLOUD_ONLY"
  if (tool === "bash") return "SPLIT"
}

export function bashKind(command: string): "simple" | "complex" {
  const cmd = command.trim().toLowerCase()
  if (!cmd) return "complex"
  if (/[\n;&|<>`]/.test(cmd) || cmd.includes("&&") || cmd.includes("||") || cmd.includes("$(")) return "complex"
  return SIMPLE.some((item) => cmd === item || cmd.startsWith(item + " ")) ? "simple" : "complex"
}

export function listLines(text: string): number {
  if (!text) return 0
  return text.split("\n").length
}

export function complexityClassify(input: ClassifyInput): RouteDecision {
  if (!input.enabled) return { route: "cloud", reason: "disabled" }
  if (!input.toolName) return { route: "cloud", reason: "reasoning" }

  if (CLOUD_ONLY_TOOLS.has(input.toolName)) {
    return { route: "cloud", reason: "cloud_only", tool: input.toolName, complexity: "complex" }
  }

  const lines = listLines(input.toolOutput ?? "")
  if (lines >= LINE_LIMIT) {
    return { route: "cloud", reason: "complex", tool: input.toolName, complexity: "complex", lineCount: lines }
  }

  if (LOCAL_ONLY_TOOLS.has(input.toolName)) {
    return { route: "local", reason: "simple", tool: input.toolName, complexity: "simple", lineCount: lines }
  }

  if (input.toolName === "bash") {
    const cmd = typeof input.toolInput?.command === "string" ? input.toolInput.command : ""
    if (bashKind(cmd) === "simple") {
      return { route: "local", reason: "bash_simple", tool: input.toolName, complexity: "simple", lineCount: lines }
    }
  }

  return { route: "cloud", reason: "complex", tool: input.toolName, complexity: "complex", lineCount: lines }
}

export async function resolveHybridRoute(input: {
  enabled: boolean
  cfg: Config.Info
  input: {
    sessionID: string
    messages: ModelMessage[]
    tools: Record<string, Tool>
    model: Provider.Model
  }
  language: Awaited<ReturnType<typeof Provider.getLanguage>>
  provider: Awaited<ReturnType<typeof Provider.getProvider>>
  auth: Awaited<ReturnType<typeof Auth.get>>
}) {
  const ctx = context(input.input.messages)
  const decision = complexityClassify({
    enabled: input.enabled,
    toolName: ctx?.toolName,
    toolOutput: ctx?.output,
    toolInput: ctx?.input,
  })

  const base = {
    route: "cloud" as const,
    model: input.input.model,
    language: input.language,
    provider: input.provider,
    auth: input.auth,
  }

  if (decision.reason === "disabled") return base

  const cloud = async () => {
    const ref = input.cfg.hybrid?.cloud_model
    if (!ref) return base
    return resolve(ref, "cloud").catch(() => base)
  }

  if (decision.route === "cloud") {
    return await cloud()
  }

  const ref = input.cfg.hybrid?.local_model
  if (!ref) {
    return await cloud()
  }

  try {
    const local = await resolve(ref, "local")
    const next = await cloud()
    return { ...next, route: "local" as const }
  } catch {
    return await cloud()
  }

  async function resolve(ref: { providerID: string; modelID: string }, route: Route): Promise<Resolved> {
    const model = await Provider.getModel(ProviderID.make(ref.providerID), ModelID.make(ref.modelID))
    const [language, provider, auth] = await Promise.all([
      Provider.getLanguage(model),
      Provider.getProvider(model.providerID),
      Auth.get(model.providerID),
    ])
    return { route, model, language, provider, auth }
  }
}

export function compressionEligibleEntry(input: {
  sessionID: string
  step: number
  tool: string
  output: string
  modelID: string
  providerID: string
}): RouteLogEntry {
  const eligible = shouldCompress(input.output, input.tool)
  const reason = !input.tool
    ? "no_tool"
    : input.tool === "bash" && eligible
      ? "bash_threshold"
      : (input.tool === "grep" || input.tool === "glob") && eligible
        ? `${input.tool}_threshold`
        : "not_compressible"
  return {
    sessionID: input.sessionID,
    step: input.step,
    tool: input.tool,
    modelID: input.modelID,
    providerID: input.providerID,
    eligible,
    reason,
    lineCount: listLines(input.output),
  }
}

function context(messages: ModelMessage[]): Context | undefined {
  const res = result(messages)
  if (!res) return call(messages)
  if (!res.toolCallId) return res
  const c = call(messages, res.toolCallId)
  return { ...res, input: c?.input }
}

function result(messages: ModelMessage[]): Context | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "user") return
    if (!Array.isArray(msg.content)) continue
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const part = msg.content[j] as Part
      if (part.type !== "tool-result" || !part.toolName) continue
      const output = extractOutput(part.output)
      return { toolName: part.toolName, toolCallId: part.toolCallId, output }
    }
  }
}

export function extractOutput(content: unknown): string | undefined {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: string; text: string } => p?.type === "text")
      .map((p) => p.text)
      .join("\n")
  }
  // { type: "text", value: string } — from toModelOutput
  if (content && typeof content === "object") {
    const o = content as Record<string, unknown>
    if (o.type === "text" && typeof o.value === "string") return o.value
    // { type: "content", value: Array<{type,text}> }
    if (o.type === "content" && Array.isArray(o.value)) {
      return (o.value as Array<{ type: string; text: string }>)
        .filter((p) => p?.type === "text")
        .map((p) => p.text)
        .join("\n")
    }
  }
}

function call(messages: ModelMessage[], id?: string): Context | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === "user") return
    if (!Array.isArray(msg.content)) continue
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const part = msg.content[j] as Part
      if (part.type !== "tool-call" || !part.toolName) continue
      if (id && part.toolCallId !== id) continue
      return { toolName: part.toolName, toolCallId: part.toolCallId, input: part.input }
    }
  }
}

export type CompressionTemplate = "extract" | "summarize" | "filter"

export const COMPRESSION_SYSTEM = `You are a lossless compression tool. Rules:
- Output ONLY facts present in the input
- Never add information, analysis, or recommendations
- Never infer intent or suggest next steps
- Preserve all identifiers: file paths, line numbers, symbol names, error codes
- If unsure whether to keep or drop, keep it`

export const COMPRESSION_TEMPLATES: Record<CompressionTemplate, string> = {
  extract: `Extract only the key lines from the following tool output.
Return file paths, line numbers, matching content, and error messages.
Use bullet format. Max 20 items.
Do NOT add commentary, analysis, or recommendations.
Do NOT infer what the results mean.`,

  summarize: `Summarize the following content in 3-6 bullets.
Preserve all identifiers (file paths, line numbers, function names, class names).
Keep code structure references (which function, which class, which module).
Do NOT add interpretation, analysis, or recommendations.
Do NOT speculate about purpose or intent.`,

  filter: `Return only the relevant items from the following output.
Drop duplicate entries, empty lines, and boilerplate.
Keep error codes, file paths, test names, and status indicators.
Do NOT add summary, analysis, or recommendations.
Do NOT reorder or reinterpret the items.`,
}

export function templateFor(tool: string, override?: Record<string, string>): CompressionTemplate {
  const o = override?.[tool]
  if (o === "extract" || o === "summarize" || o === "filter") return o
  if (tool === "read") return "summarize"
  if (tool === "bash") return "filter"
  return "extract"
}

export function shouldCompress(output: string, tool: string): boolean {
  const lines = listLines(output)
  if (tool === "bash") return lines > 30
  if (tool === "grep" || tool === "glob") return lines > 100
  return false
}

export function validateCompression(raw: string, compressed: string): boolean {
  const rawLines = listLines(raw)
  const compLines = listLines(compressed)
  // Expansion check: strictly longer = invalid
  if (compLines > rawLines) return false
  // Empty check
  if (!compressed.trim()) return false
  return true
}
