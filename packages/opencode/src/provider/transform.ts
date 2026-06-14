import type { ModelMessage } from "ai"
import { mergeDeep, unique } from "remeda"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type { JSONSchema } from "zod/v4/core"
import type { Provider } from "./provider"
import type { ModelsDev } from "./models"
import { iife } from "@/util/iife"
import { Flag } from "@/flag/flag"
import { TransformCache } from "./transform-cache" // [fork-perf]

type Modality = NonNullable<ModelsDev.Model["modalities"]>["input"][number]

function mimeToModality(mime: string): Modality | undefined {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime === "application/pdf") return "pdf"
  return undefined
}

export namespace ProviderTransform {
  export const OUTPUT_TOKEN_MAX = Flag.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX || 32_000

  // Maps npm package to the key the AI SDK expects for providerOptions
  function sdkKey(npm: string): string | undefined {
    switch (npm) {
      case "@ai-sdk/github-copilot":
        return "copilot"
      case "@ai-sdk/azure":
        return "azure"
      case "@ai-sdk/openai":
        return "openai"
      case "@ai-sdk/amazon-bedrock":
        return "bedrock"
      case "@ai-sdk/anthropic":
      case "@ai-sdk/google-vertex/anthropic":
        return "anthropic"
      case "@ai-sdk/google-vertex":
        return "vertex"
      case "@ai-sdk/google":
        return "google"
      case "@ai-sdk/gateway":
        return "gateway"
      case "@openrouter/ai-sdk-provider":
        return "openrouter"
    }
    return undefined
  }

  function normalizeMessages(
    msgs: ModelMessage[],
    model: Provider.Model,
    options: Record<string, unknown>,
  ): ModelMessage[] {
    // Anthropic rejects messages with empty content - filter out empty string messages
    // and remove empty text/reasoning parts from array content
    // (cherry-pick f19d863689) split anthropic and bedrock into separate transforms
    if (model.api.npm === "@ai-sdk/anthropic") {
      msgs = msgs
        .map((msg) => {
          if (typeof msg.content === "string") {
            if (msg.content === "") return undefined
            return msg
          }
          if (!Array.isArray(msg.content)) return msg
          const filtered = msg.content.filter((part) => {
            if (part.type === "text") {
              return part.text !== ""
            }
            if (part.type === "reasoning") {
              return (
                part.text.trim().length > 0 ||
                part.providerOptions?.anthropic?.signature != null ||
                part.providerOptions?.anthropic?.redactedData != null
              )
            }
            return true
          })
          if (filtered.length === 0) return undefined
          return { ...msg, content: filtered }
        })
        .filter((msg): msg is ModelMessage => msg !== undefined && msg.content !== "")
    }

    // Bedrock specific transforms
    if (model.api.npm === "@ai-sdk/amazon-bedrock") {
      msgs = msgs
        .map((msg) => {
          if (typeof msg.content === "string") {
            if (msg.content === "") return undefined
            return msg
          }
          if (!Array.isArray(msg.content)) return msg
          const filtered = msg.content.filter((part) => {
            if (part.type === "text") {
              return part.text !== ""
            }
            if (part.type === "reasoning") {
              return (
                part.text.trim().length > 0 ||
                part.providerOptions?.bedrock?.signature != null ||
                part.providerOptions?.bedrock?.redactedData != null
              )
            }
            return true
          })
          if (filtered.length === 0) return undefined
          return { ...msg, content: filtered }
        })
        .filter((msg): msg is ModelMessage => msg !== undefined && msg.content !== "")
    }

    if (model.api.id.includes("claude")) {
      const scrub = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_")
      msgs = msgs.map((msg) => {
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          return {
            ...msg,
            content: msg.content.map((part) => {
              if (part.type === "tool-call" || part.type === "tool-result") {
                return { ...part, toolCallId: scrub(part.toolCallId) }
              }
              return part
            }),
          }
        }
        if (msg.role === "tool" && Array.isArray(msg.content)) {
          return {
            ...msg,
            content: msg.content.map((part) => {
              if (part.type === "tool-result") {
                return { ...part, toolCallId: scrub(part.toolCallId) }
              }
              return part
            }),
          }
        }
        return msg
      })
    }

    if (
      model.providerID === "mistral" ||
      model.api.id.toLowerCase().includes("mistral") ||
      model.api.id.toLocaleLowerCase().includes("devstral")
    ) {
      const scrub = (id: string) => {
        return id
          .replace(/[^a-zA-Z0-9]/g, "") // Remove non-alphanumeric characters
          .substring(0, 9) // Take first 9 characters
          .padEnd(9, "0") // Pad with zeros if less than 9 characters
      }
      const result: ModelMessage[] = []
      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i]
        const nextMsg = msgs[i + 1]

        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          msg.content = msg.content.map((part) => {
            if (part.type === "tool-call" || part.type === "tool-result") {
              return { ...part, toolCallId: scrub(part.toolCallId) }
            }
            return part
          })
        }
        if (msg.role === "tool" && Array.isArray(msg.content)) {
          msg.content = msg.content.map((part) => {
            if (part.type === "tool-result") {
              return { ...part, toolCallId: scrub(part.toolCallId) }
            }
            return part
          })
        }
        result.push(msg)

        // Fix message sequence: tool messages cannot be followed by user messages
        if (msg.role === "tool" && nextMsg?.role === "user") {
          result.push({
            role: "assistant",
            content: [
              {
                type: "text",
                text: "Done.",
              },
            ],
          })
        }
      }
      return result
    }

    // Deepseek requires all assistant messages to have reasoning on them
    if (model.api.id.toLowerCase().includes("deepseek")) {
      msgs = msgs.map((msg) => {
        if (msg.role !== "assistant") return msg
        if (Array.isArray(msg.content)) {
          if (msg.content.some((part) => part.type === "reasoning")) return msg
          return { ...msg, content: [...msg.content, { type: "reasoning", text: "" }] }
        }
        return {
          ...msg,
          content: [
            ...(msg.content ? [{ type: "text" as const, text: msg.content }] : []),
            { type: "reasoning" as const, text: "" },
          ],
        }
      })
    }

    if (typeof model.capabilities.interleaved === "object" && model.capabilities.interleaved.field) {
      const field = model.capabilities.interleaved.field
      return msgs.map((msg) => {
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          const reasoningParts = msg.content.filter((part: any) => part.type === "reasoning")
          const reasoningText = reasoningParts.map((part: any) => part.text).join("")

          // Filter out reasoning parts from content
          const filteredContent = msg.content.filter((part: any) => part.type !== "reasoning")

          return {
            ...msg,
            content: filteredContent,
            providerOptions: {
              ...msg.providerOptions,
              openaiCompatible: {
                ...(msg.providerOptions as any)?.openaiCompatible,
                [field]: reasoningText,
              },
            },
          }
        }

        return msg
      })
    }

    return msgs
  }

  function applyCaching(
    msgs: ModelMessage[],
    model: Provider.Model,
    options: Record<string, unknown> = {},
  ): ModelMessage[] {
    // [fork-perf] options.caching opt-in
    // Providers that also get a tool-level cache marker via toolCaching() must
    // reserve one breakpoint slot (4 max for Anthropic).  We allocate 3 message
    // markers and let the 4th go to tool definitions (3000-8000 tokens, often
    // the largest stable cacheable block).  Providers without tool caching use
    // all 4 slots for messages.
    const isAnthropicNative =
      model.providerID === "anthropic" ||
      model.providerID === "google-vertex-anthropic" ||
      model.providerID.includes("bedrock") ||
      model.api.npm === "@ai-sdk/anthropic" ||
      model.api.npm === "@ai-sdk/amazon-bedrock"
    const nonSystem = msgs.filter((msg) => msg.role !== "system")

    let targets: ModelMessage[]
    if (isAnthropicNative) {
      // 3 markers: system[0] + last 2 non-system messages (tool exchange boundary)
      const system = msgs.filter((msg) => msg.role === "system").slice(0, 1)
      const final = nonSystem.slice(-2)
      targets = unique([...system, ...final])
    } else {
      // 4 markers: system[0..1] + last 2 non-system messages
      const system = msgs.filter((msg) => msg.role === "system").slice(0, 2)
      const final = nonSystem.slice(-2)
      targets = unique([...system, ...final])
    }

    // [fork-perf] Include all provider cache keys unconditionally — the AI SDK silently ignores
    // unknown namespace keys, so injecting all of them is safe and keeps providerOptions
    // stable regardless of which provider is active.
    // [fork-perf] 1h cache TTL is opt-out, default-on. Only `0` / `false` / `off` disables.
    const cachingDisabled = ["0", "false", "off"].includes(
      String(process.env.ENABLE_PROMPT_CACHING_1H ?? "").toLowerCase(),
    )
    const cacheTtl = cachingDisabled ? undefined : "1h"
    const ttl = cacheTtl ? { ttl: cacheTtl } : {}
    // Global scope enables cross-session caching for stable content (system prompts).
    // Only native Anthropic APIs support scope; proxies/routers ignore it safely.
    const globalScope = isAnthropicNative ? { scope: "global" } : {}
    const providerOptions: Record<string, unknown> = {
      anthropic: { cacheControl: { type: "ephemeral", ...ttl, ...globalScope } },
      openrouter: { cacheControl: { type: "ephemeral", ...ttl } },
      bedrock: { cachePoint: { type: "default" } },
      alibaba: { cacheControl: { type: "ephemeral" } },
      copilot: { copilot_cache_control: { type: "ephemeral" } },
      openaiCompatible: { cache_control: { type: "ephemeral", ...ttl } },
    }
    // Session-specific options for non-system messages (no global scope — content changes per turn)
    const sessionProviderOptions: Record<string, unknown> = {
      anthropic: { cacheControl: { type: "ephemeral", ...ttl } },
      openrouter: { cacheControl: { type: "ephemeral", ...ttl } },
      bedrock: { cachePoint: { type: "default" } },
      alibaba: { cacheControl: { type: "ephemeral" } },
      copilot: { copilot_cache_control: { type: "ephemeral" } },
      openaiCompatible: { cache_control: { type: "ephemeral", ...ttl } },
    }

    // [fork-perf] Build patched versions of target messages without mutating originals
    const patched = new Map<ModelMessage, ModelMessage>()
    for (const msg of targets) {
      // System messages get global scope (stable across sessions); others get session scope
      const opts = msg.role === "system" ? providerOptions : sessionProviderOptions
      const useMessageLevelOptions =
        options.caching === true || // [fork-perf] opt-in caching uses message-level
        isAnthropicNative
      const shouldUseContentOptions = !useMessageLevelOptions && Array.isArray(msg.content) && msg.content.length > 0

      if (shouldUseContentOptions) {
        const lastContent = msg.content[msg.content.length - 1]
        if (
          lastContent &&
          typeof lastContent === "object" &&
          lastContent.type !== "tool-approval-request" &&
          lastContent.type !== "tool-approval-response"
        ) {
          const newLastContent = {
            ...lastContent,
            providerOptions: mergeDeep(lastContent.providerOptions ?? {}, opts) as typeof lastContent.providerOptions,
          }
          const newContent = [...msg.content]
          newContent[newContent.length - 1] = newLastContent
          patched.set(msg, { ...msg, content: newContent as typeof msg.content } as ModelMessage)
          continue
        }
      }

      patched.set(msg, {
        ...msg,
        providerOptions: mergeDeep(msg.providerOptions ?? {}, opts) as typeof msg.providerOptions,
      })
    }

    return msgs.map((msg) => patched.get(msg) ?? msg)
  }

  function unsupportedParts(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
    return msgs.map((msg) => {
      if (msg.role !== "user" || !Array.isArray(msg.content)) return msg

      const filtered = msg.content.map((part) => {
        if (part.type !== "file" && part.type !== "image") return part

        // Check for empty base64 image data
        if (part.type === "image") {
          const imageStr = part.image.toString()
          if (imageStr.startsWith("data:")) {
            const match = imageStr.match(/^data:([^;]+);base64,(.*)$/)
            if (match && (!match[2] || match[2].length === 0)) {
              return {
                type: "text" as const,
                text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
              }
            }
          }
        }

        const mime = part.type === "image" ? part.image.toString().split(";")[0].replace("data:", "") : part.mediaType
        const filename = part.type === "file" ? part.filename : undefined
        const modality = mimeToModality(mime)
        if (!modality) return part
        if (model.capabilities.input[modality]) return part

        const name = filename ? `"${filename}"` : modality
        return {
          type: "text" as const,
          text: `ERROR: Cannot read ${name} (this model does not support ${modality} input). Inform the user.`,
        }
      })

      return { ...msg, content: filtered }
    })
  }

  // Module-level state for session-stable tool caching (bounded to prevent memory leak)
  const TOOL_ANCHORS_MAX = 512
  const toolAnchors = new Map<string, { hash: string; anchor: string }>()

  function setToolAnchor(key: string, value: { hash: string; anchor: string }) {
    toolAnchors.set(key, value)
    if (toolAnchors.size > TOOL_ANCHORS_MAX) {
      // Evict oldest entry (first key in insertion order)
      const first = toolAnchors.keys().next().value
      if (first) toolAnchors.delete(first)
    }
  }

  export function toolCaching(
    tools: Record<string, { providerOptions?: Record<string, any> }>,
    model: Provider.Model,
    sessionID?: string,
    cacheKey?: TransformCache.Key, // [fork-perf] when provided, result is memoized
  ) {
    if (cacheKey) return TransformCache.memo(cacheKey, () => _toolCachingImpl(tools, model, sessionID)) // [fork-perf]
    return _toolCachingImpl(tools, model, sessionID)
  }

  function _toolCachingImpl(
    tools: Record<string, { providerOptions?: Record<string, any> }>,
    model: Provider.Model,
    sessionID?: string,
  ) {
    const isAnthropicLike =
      model.providerID === "anthropic" ||
      model.providerID === "google-vertex-anthropic" ||
      model.providerID.includes("bedrock") ||
      model.api.npm === "@ai-sdk/anthropic" ||
      model.api.npm === "@ai-sdk/amazon-bedrock"
    if (!isAnthropicLike) return tools
    const keys = Object.keys(tools)
    if (keys.length === 0) return tools

    const hash = [...keys].sort().join(",") // [fork-perf] cache-stability fix
    const key = sessionID ? `${sessionID}:${model.id}` : undefined

    if (key) {
      const prev = toolAnchors.get(key)
      if (prev) {
        if (prev.hash !== hash) {
          // Tools changed (MCP dynamic) — skip tool caching to avoid cache bust
          setToolAnchor(key, { hash, anchor: keys[keys.length - 1] })
          return tools
        }
      } else {
        // First call — latch anchor
        setToolAnchor(key, { hash, anchor: keys[keys.length - 1] })
      }
    }

    const anchor = key ? toolAnchors.get(key)!.anchor : keys[keys.length - 1]
    const target = keys.includes(anchor) ? anchor : keys[keys.length - 1]
    // [fork-perf] 1h cache TTL is opt-out, default-on. Only `0` / `false` / `off` disables.
    const cachingDisabled = ["0", "false", "off"].includes(
      String(process.env.ENABLE_PROMPT_CACHING_1H ?? "").toLowerCase(),
    )
    const cacheTtl = cachingDisabled ? {} : { ttl: "1h" }
    return {
      ...tools,
      [target]: {
        ...tools[target],
        providerOptions: mergeDeep(tools[target].providerOptions ?? {}, {
          anthropic: {
            cacheControl: { type: "ephemeral", scope: "global", ...cacheTtl },
          },
          bedrock: { cachePoint: { type: "default" } },
        }),
      },
    }
  }

  export function message(
    msgs: ModelMessage[],
    model: Provider.Model,
    options: Record<string, unknown>,
    messageCacheKey?: TransformCache.Key,
  ) {
    // [fork-perf] messageCacheKey enables memoization
    if (messageCacheKey) return TransformCache.memo(messageCacheKey, () => _messageImpl(msgs, model, options)) // [fork-perf]
    return _messageImpl(msgs, model, options)
  }

  function _messageImpl(msgs: ModelMessage[], model: Provider.Model, options: Record<string, unknown>) {
    msgs = unsupportedParts(msgs, model)
    msgs = normalizeMessages(msgs, model, options)
    if (
      (model.providerID === "anthropic" ||
        model.providerID === "google-vertex-anthropic" ||
        model.providerID === "openrouter" ||
        model.providerID === "github-copilot" ||
        model.providerID === "deepseek" ||
        model.api.id.includes("anthropic") ||
        model.api.id.includes("claude") ||
        model.id.includes("anthropic") ||
        model.id.includes("claude") ||
        model.api.npm === "@ai-sdk/anthropic" ||
        model.api.npm === "@ai-sdk/github-copilot" ||
        model.api.npm === "@openrouter/ai-sdk-provider" ||
        model.api.npm === "@ai-sdk/alibaba") &&
      model.api.npm !== "@ai-sdk/gateway"
    ) {
      msgs = applyCaching(msgs, model, options)
    }

    // Remap providerOptions keys from stored providerID to expected SDK key
    const key = sdkKey(model.api.npm)
    if (key && key !== model.providerID) {
      const remap = (opts: Record<string, any> | undefined) => {
        if (!opts) return opts
        if (!(model.providerID in opts)) return opts
        const result = { ...opts }
        result[key] = result[model.providerID]
        delete result[model.providerID]
        return result
      }

      msgs = msgs.map((msg) => {
        if (!Array.isArray(msg.content)) return { ...msg, providerOptions: remap(msg.providerOptions) }
        return {
          ...msg,
          providerOptions: remap(msg.providerOptions),
          content: msg.content.map((part) => {
            if (part.type === "tool-approval-request" || part.type === "tool-approval-response") {
              return { ...part }
            }
            return { ...part, providerOptions: remap(part.providerOptions) }
          }),
        } as typeof msg
      })
    }

    return msgs
  }

  export function temperature(model: Provider.Model) {
    const id = model.id.toLowerCase()
    if (id.includes("qwen")) return 0.55
    if (id.includes("claude")) return undefined
    if (id.includes("gemini")) return 1.0
    if (id.includes("glm-4.6")) return 1.0
    if (id.includes("glm-4.7")) return 1.0
    if (id.includes("minimax-m2")) return 1.0
    if (id.includes("kimi-k2")) {
      // kimi-k2-thinking & kimi-k2.5 && kimi-k2p5 && kimi-k2-5
      if (["thinking", "k2.", "k2p", "k2-5"].some((s) => id.includes(s))) {
        return 1.0
      }
      return 0.6
    }
    return undefined
  }

  export function topP(model: Provider.Model) {
    const id = model.id.toLowerCase()
    if (id.includes("qwen")) return 1
    if (["minimax-m2", "gemini", "kimi-k2.5", "kimi-k2p5", "kimi-k2-5"].some((s) => id.includes(s))) {
      return 0.95
    }
    return undefined
  }

  export function topK(model: Provider.Model) {
    const id = model.id.toLowerCase()
    if (id.includes("minimax-m2")) {
      if (["m2.", "m25", "m21"].some((s) => id.includes(s))) return 40
      return 20
    }
    if (id.includes("gemini")) return 64
    return undefined
  }

  const WIDELY_SUPPORTED_EFFORTS = ["low", "medium", "high"]
  const OPENAI_EFFORTS = ["none", "minimal", ...WIDELY_SUPPORTED_EFFORTS, "xhigh"]

  function anthropicOpus47OrLater(apiId: string) {
    const version = /opus-(\d+)[.-](\d+)(?:[.-]|$)/i.exec(apiId)
    if (!version) return false
    const major = Number(version[1])
    const minor = Number(version[2])
    return major > 4 || (major === 4 && minor >= 7)
  }

  export function variants(model: Provider.Model): Record<string, Record<string, any>> {
    if (!model.capabilities.reasoning) return {}

    const opts = model.capabilities.reasoning_options

    // === Tier 1: Capability-based gate ===

    // Explicitly tagged "no control" → no variants
    if (opts && opts.length === 0) return {}

    // Toggle-only → no effort variants (thinking controlled via options() defaults)
    if (opts && opts.every((o) => o.type === "toggle")) return {}

    // Has explicit effort values → extract them
    const effort = opts?.find((o): o is Extract<typeof o, { type: "effort" }> => o.type === "effort")
    const values = effort?.values

    // === Tier 2: Shape dispatch by SDK ===
    return variantsBySDK(model, values)
  }

  function variantsBySDK(model: Provider.Model, values: string[] | undefined): Record<string, Record<string, any>> {
    const id = model.id.toLowerCase()
    const opts = model.capabilities.reasoning_options
    const isOpus47 = anthropicOpus47OrLater(model.api.id)
    const isAnthropicAdaptive =
      isOpus47 || ["opus-4-6", "opus-4.6", "sonnet-4-6", "sonnet-4.6"].some((v) => model.api.id.includes(v))
    const adaptiveEfforts = isOpus47 ? ["low", "medium", "high", "xhigh", "max"] : ["low", "medium", "high", "max"]

    // Grok special case (fallback when opts undefined)
    if (!opts && id.includes("grok")) {
      if (id.includes("grok-3-mini")) {
        if (model.api.npm === "@openrouter/ai-sdk-provider") {
          return {
            low: { reasoning: { effort: "low" } },
            high: { reasoning: { effort: "high" } },
          }
        }
        return {
          low: { reasoningEffort: "low" },
          high: { reasoningEffort: "high" },
        }
      }
      return {}
    }

    switch (model.api.npm) {
      case "@openrouter/ai-sdk-provider":
        if (values) return Object.fromEntries(values.map((v) => [v, { reasoning: { effort: v } }]))
        if (!model.id.includes("gpt") && !model.id.includes("gemini-3") && !model.id.includes("claude")) return {}
        return Object.fromEntries(OPENAI_EFFORTS.map((v) => [v, { reasoning: { effort: v } }]))

      case "@ai-sdk/gateway":
        if (model.id.includes("anthropic")) {
          if (values) {
            return Object.fromEntries(values.map((v) => [v, { thinking: { type: "adaptive" }, effort: v }]))
          }
          if (isAnthropicAdaptive) {
            return Object.fromEntries(adaptiveEfforts.map((v) => [v, { thinking: { type: "adaptive" }, effort: v }]))
          }
          return {
            high: { thinking: { type: "enabled", budgetTokens: 16000 } },
            max: { thinking: { type: "enabled", budgetTokens: 31999 } },
          }
        }
        if (model.id.includes("google")) {
          if (values) {
            return Object.fromEntries(
              values.map((v) => [v, { thinkingConfig: { includeThoughts: true, thinkingLevel: v } }]),
            )
          }
          if (id.includes("2.5")) {
            return {
              high: { thinkingConfig: { includeThoughts: true, thinkingBudget: 16000 } },
              max: { thinkingConfig: { includeThoughts: true, thinkingBudget: 24576 } },
            }
          }
          return Object.fromEntries(["low", "high"].map((v) => [v, { includeThoughts: true, thinkingLevel: v }]))
        }
        if (values) return Object.fromEntries(values.map((v) => [v, { reasoningEffort: v }]))
        return Object.fromEntries(OPENAI_EFFORTS.map((v) => [v, { reasoningEffort: v }]))

      case "@ai-sdk/github-copilot":
        if (model.id.includes("gemini")) {
          // currently github copilot only returns thinking
          return {}
        }
        if (model.id.includes("claude")) {
          if (anthropicOpus47OrLater(model.api.id)) {
            return Object.fromEntries(["medium"].map((v) => [v, { reasoningEffort: v }]))
          }
          return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((v) => [v, { reasoningEffort: v }]))
        }
        {
          const copilotEfforts = iife(() => {
            if (id.includes("5.1-codex-max") || id.includes("5.2") || id.includes("5.3"))
              return [...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
            const arr = [...WIDELY_SUPPORTED_EFFORTS]
            if (id.includes("gpt-5") && model.release_date >= "2025-12-04") arr.push("xhigh")
            return arr
          })
          return Object.fromEntries(
            copilotEfforts.map((v) => [
              v,
              {
                reasoningEffort: v,
                reasoningSummary: "auto",
                include: ["reasoning.encrypted_content"],
              },
            ]),
          )
        }

      case "@ai-sdk/cerebras":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/cerebras
      case "@ai-sdk/togetherai":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/togetherai
      case "@ai-sdk/xai":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/xai
      case "@ai-sdk/deepinfra":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/deepinfra
      case "venice-ai-sdk-provider":
      // https://docs.venice.ai/overview/guides/reasoning-models#reasoning-effort
      case "@ai-sdk/openai-compatible":
        if (values) return Object.fromEntries(values.map((v) => [v, { reasoningEffort: v }]))
        if (model.api.npm === "@ai-sdk/openai-compatible" && !opts) return {}
        {
          const efforts = [...WIDELY_SUPPORTED_EFFORTS]
          if (model.api.id.toLowerCase().includes("deepseek-v4")) {
            efforts.push("max")
          }
          return Object.fromEntries(efforts.map((v) => [v, { reasoningEffort: v }]))
        }

      case "@ai-sdk/azure":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/azure
        if (values) {
          return Object.fromEntries(
            values.map((v) => [
              v,
              { reasoningEffort: v, reasoningSummary: "auto", include: ["reasoning.encrypted_content"] },
            ]),
          )
        }
        if (id === "o1-mini") return {}
        {
          const azureEfforts = ["low", "medium", "high"]
          if (id.includes("gpt-5-") || id === "gpt-5") {
            azureEfforts.unshift("minimal")
          }
          return Object.fromEntries(
            azureEfforts.map((v) => [
              v,
              { reasoningEffort: v, reasoningSummary: "auto", include: ["reasoning.encrypted_content"] },
            ]),
          )
        }

      case "@ai-sdk/openai":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/openai
        if (values) {
          return Object.fromEntries(
            values.map((v) => [
              v,
              { reasoningEffort: v, reasoningSummary: "auto", include: ["reasoning.encrypted_content"] },
            ]),
          )
        }
        if (id === "gpt-5-pro") return {}
        {
          const openaiEfforts = iife(() => {
            if (id.includes("codex")) {
              if (id.includes("5.2") || id.includes("5.3")) return [...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
              return WIDELY_SUPPORTED_EFFORTS
            }
            const arr = [...WIDELY_SUPPORTED_EFFORTS]
            if (id.includes("gpt-5-") || id === "gpt-5") {
              arr.unshift("minimal")
            }
            if (model.release_date >= "2025-11-13") {
              arr.unshift("none")
            }
            if (model.release_date >= "2025-12-04") {
              arr.push("xhigh")
            }
            return arr
          })
          return Object.fromEntries(
            openaiEfforts.map((v) => [
              v,
              { reasoningEffort: v, reasoningSummary: "auto", include: ["reasoning.encrypted_content"] },
            ]),
          )
        }

      case "@ai-sdk/anthropic":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/anthropic
      case "@ai-sdk/google-vertex/anthropic":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-vertex#anthropic-provider

        if (values) {
          return Object.fromEntries(values.map((v) => [v, { thinking: { type: "adaptive" }, effort: v }]))
        }

        if (isAnthropicAdaptive) {
          let efforts = [...adaptiveEfforts]
          if (model.providerID === "github-copilot") {
            if (anthropicOpus47OrLater(model.api.id)) {
              efforts = ["medium"]
            }
            efforts = efforts.filter((v) => v !== "max" && v !== "xhigh")
          }
          return Object.fromEntries(
            efforts.map((v) => [
              v,
              {
                thinking: {
                  type: "adaptive",
                  ...(isOpus47 ? { display: "summarized" } : {}),
                },
                effort: v,
              },
            ]),
          )
        }

        return {
          high: {
            thinking: {
              type: "enabled",
              budgetTokens: Math.min(16_000, Math.floor(model.limit.output / 2 - 1)),
            },
          },
          max: {
            thinking: {
              type: "enabled",
              budgetTokens: Math.min(31_999, model.limit.output - 1),
            },
          },
        }

      case "@ai-sdk/amazon-bedrock":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/amazon-bedrock
        if (values) {
          return Object.fromEntries(
            values.map((v) => [v, { reasoningConfig: { type: "adaptive", maxReasoningEffort: v } }]),
          )
        }
        if (isAnthropicAdaptive) {
          return Object.fromEntries(
            adaptiveEfforts.map((v) => [
              v,
              {
                reasoningConfig: {
                  type: "adaptive",
                  maxReasoningEffort: v,
                  ...(isOpus47 ? { display: "summarized" } : {}),
                },
              },
            ]),
          )
        }
        // For Anthropic models on Bedrock, use reasoningConfig with budgetTokens
        if (model.api.id.includes("anthropic")) {
          return {
            high: { reasoningConfig: { type: "enabled", budgetTokens: 16000 } },
            max: { reasoningConfig: { type: "enabled", budgetTokens: 31999 } },
          }
        }

        // For Amazon Nova models, use reasoningConfig with maxReasoningEffort
        return Object.fromEntries(
          WIDELY_SUPPORTED_EFFORTS.map((v) => [v, { reasoningConfig: { type: "enabled", maxReasoningEffort: v } }]),
        )

      case "@ai-sdk/google-vertex":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-vertex
      case "@ai-sdk/google": {
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai
        const budget = opts?.find((o): o is Extract<typeof o, { type: "budget_tokens" }> => o.type === "budget_tokens")
        if (values) {
          return Object.fromEntries(
            values.map((v) => [v, { thinkingConfig: { includeThoughts: true, thinkingLevel: v } }]),
          )
        }
        if (budget) {
          return {
            high: { thinkingConfig: { includeThoughts: true, thinkingBudget: budget.min } },
            max: { thinkingConfig: { includeThoughts: true, thinkingBudget: budget.max ?? budget.min } },
          }
        }
        // Fallback: existing id-based logic
        if (id.includes("2.5")) {
          return {
            high: { thinkingConfig: { includeThoughts: true, thinkingBudget: 16000 } },
            max: { thinkingConfig: { includeThoughts: true, thinkingBudget: 24576 } },
          }
        }
        let levels = ["low", "high"]
        if (id.includes("3.1")) {
          levels = ["low", "medium", "high"]
        }
        return Object.fromEntries(
          levels.map((v) => [v, { thinkingConfig: { includeThoughts: true, thinkingLevel: v } }]),
        )
      }

      case "@ai-sdk/mistral":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/mistral
        // https://docs.mistral.ai/capabilities/reasoning/adjustable
        if (values) return Object.fromEntries(values.map((v) => [v, { reasoningEffort: v }]))
        if (!model.capabilities.reasoning) return {}
        {
          const mistralIds = ["mistral-small-2603", "mistral-small-latest", "mistral-medium-3.5"]
          const mid = model.api.id.toLowerCase()
          if (!mistralIds.some((item) => mid.includes(item))) return {}
          return { high: { reasoningEffort: "high" } }
        }

      case "@ai-sdk/cohere":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/cohere
        return {}

      case "@ai-sdk/groq":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/groq
        if (values) return Object.fromEntries(values.map((v) => [v, { reasoningEffort: v }]))
        {
          const groqEffort = ["none", ...WIDELY_SUPPORTED_EFFORTS]
          return Object.fromEntries(groqEffort.map((v) => [v, { reasoningEffort: v }]))
        }

      case "@ai-sdk/perplexity":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/perplexity
        return {}

      case "@jerome-benoit/sap-ai-provider-v2":
        if (model.api.id.includes("anthropic")) {
          if (values) {
            return Object.fromEntries(values.map((v) => [v, { thinking: { type: "adaptive" }, effort: v }]))
          }
          if (isAnthropicAdaptive) {
            return Object.fromEntries(adaptiveEfforts.map((v) => [v, { thinking: { type: "adaptive" }, effort: v }]))
          }
          return {
            high: { thinking: { type: "enabled", budgetTokens: 16000 } },
            max: { thinking: { type: "enabled", budgetTokens: 31999 } },
          }
        }
        if (model.api.id.includes("gemini") && id.includes("2.5")) {
          return {
            high: { thinkingConfig: { includeThoughts: true, thinkingBudget: 16000 } },
            max: { thinkingConfig: { includeThoughts: true, thinkingBudget: 24576 } },
          }
        }
        if (model.api.id.includes("gpt") || /\bo[1-9]/.test(model.api.id)) {
          if (values) return Object.fromEntries(values.map((v) => [v, { reasoningEffort: v }]))
          return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((v) => [v, { reasoningEffort: v }]))
        }
        return {}
    }
    return {}
  }

  export function options(input: {
    model: Provider.Model
    sessionID: string
    providerOptions?: Record<string, any>
  }): Record<string, any> {
    const result: Record<string, any> = {}

    if (input.model.api.npm === "@ai-sdk/google-vertex/anthropic" || input.model.api.npm === "@ai-sdk/anthropic") {
      // [fork-perf] Disable for ALL anthropic (incl. claude) on @ai-sdk/anthropic 3.0.71+:
      // SDK now defaults to injecting `eager_input_streaming: true` on every tool when
      // toolStreaming is unset. Forces explicit opt-out to keep stable streaming.
      result["toolStreaming"] = false
    }

    // openai and providers using openai package should set store to false by default.
    if (
      input.model.providerID === "openai" ||
      input.model.api.npm === "@ai-sdk/openai" ||
      input.model.api.npm === "@ai-sdk/github-copilot"
    ) {
      result["store"] = false
      result["truncation"] = "auto"
    }

    if (input.model.api.npm === "@openrouter/ai-sdk-provider") {
      result["usage"] = {
        include: true,
      }
      if (input.model.api.id.includes("gemini-3")) {
        result["reasoning"] = { effort: "high" }
      }
    }

    if (
      (input.model.providerID === "baseten" || input.model.providerID === "opencode") &&
      input.model.capabilities.reasoning &&
      typeof input.model.capabilities.interleaved === "object"
    ) {
      result["chat_template_args"] = { enable_thinking: true }
    }

    if (["zai", "zhipuai"].includes(input.model.providerID) && input.model.api.npm === "@ai-sdk/openai-compatible") {
      result["thinking"] = {
        type: "enabled",
        clear_thinking: false,
      }
    }

    if (input.model.providerID === "openai" || input.providerOptions?.setCacheKey) {
      result["promptCacheKey"] = input.sessionID
      result["promptCacheRetention"] = "24h"
    }

    if (input.model.api.npm === "@ai-sdk/google" || input.model.api.npm === "@ai-sdk/google-vertex") {
      if (input.model.capabilities.reasoning) {
        result["thinkingConfig"] = {
          includeThoughts: true,
        }
        if (input.model.api.id.includes("gemini-3")) {
          result["thinkingConfig"]["thinkingLevel"] = "high"
        }
      }
    }

    // Enable thinking by default for non-Claude models using anthropic SDK
    const opts = input.model.capabilities.reasoning_options
    if (
      (input.model.api.npm === "@ai-sdk/anthropic" || input.model.api.npm === "@ai-sdk/google-vertex/anthropic") &&
      opts?.some((o) => o.type === "toggle") &&
      !input.model.api.id.includes("claude")
    ) {
      result["thinking"] = {
        type: "enabled",
        budgetTokens: Math.min(16_000, Math.floor(input.model.limit.output / 2 - 1)),
      }
    }

    // Enable thinking for reasoning models on alibaba-cn (DashScope).
    // DashScope's OpenAI-compatible API requires `enable_thinking: true` in the request body
    // to return reasoning_content. Without it, models like kimi-k2.5, qwen-plus, qwen3, qwq,
    // deepseek-r1, etc. never output thinking/reasoning tokens.
    // Note: models with reasoning_options: [] have always-on reasoning and need no flag.
    if (
      input.model.providerID === "alibaba-cn" &&
      input.model.capabilities.reasoning &&
      input.model.api.npm === "@ai-sdk/openai-compatible" &&
      !(opts && opts.length === 0)
    ) {
      result["enable_thinking"] = true
    }

    if (input.model.api.id.includes("gpt-5") && !input.model.api.id.includes("gpt-5-chat")) {
      if (!input.model.api.id.includes("gpt-5-pro")) {
        result["reasoningEffort"] = "medium"
        // Only inject reasoningSummary for providers that support it natively.
        // @ai-sdk/openai-compatible proxies (e.g. LiteLLM) do not understand this
        // parameter and return "Unknown parameter: 'reasoningSummary'".
        if (
          input.model.api.npm === "@ai-sdk/openai" ||
          input.model.api.npm === "@ai-sdk/azure" ||
          input.model.api.npm === "@ai-sdk/github-copilot" ||
          input.model.api.npm === "@ai-sdk/amazon-bedrock/mantle"
        ) {
          result["reasoningSummary"] = "auto"
        }
      }

      // Only set textVerbosity for non-chat gpt-5.x models
      // Chat models (e.g. gpt-5.2-chat-latest) only support "medium" verbosity
      if (
        input.model.api.id.includes("gpt-5.") &&
        !input.model.api.id.includes("codex") &&
        !input.model.api.id.includes("-chat") &&
        input.model.providerID !== "azure"
      ) {
        result["textVerbosity"] = "low"
      }

      if (input.model.providerID.startsWith("opencode")) {
        result["promptCacheKey"] = input.sessionID
        result["promptCacheRetention"] = "24h"
        result["include"] = ["reasoning.encrypted_content"]
        result["reasoningSummary"] = "auto"
      }
    }

    if (input.model.providerID === "venice" || input.model.providerID === "moonshotai") {
      result["promptCacheKey"] = input.sessionID
    }

    if (input.model.providerID === "openrouter") {
      result["prompt_cache_key"] = input.sessionID
    }
    if (input.model.api.npm === "@ai-sdk/gateway") {
      result["gateway"] = {
        caching: "auto",
      }
    }

    return result
  }

  export function smallOptions(model: Provider.Model) {
    if (
      model.providerID === "openai" ||
      model.api.npm === "@ai-sdk/openai" ||
      model.api.npm === "@ai-sdk/github-copilot"
    ) {
      if (model.api.id.includes("gpt-5")) {
        if (model.api.id.includes("5.") || model.api.id.includes("5-mini")) {
          return { store: false, reasoningEffort: "low" }
        }
        return { store: false, reasoningEffort: "minimal" }
      }
      return { store: false }
    }
    if (model.providerID === "google") {
      // gemini-3 uses thinkingLevel, gemini-2.5 uses thinkingBudget
      if (model.api.id.includes("gemini-3")) {
        return { thinkingConfig: { thinkingLevel: "minimal" } }
      }
      return { thinkingConfig: { thinkingBudget: 0 } }
    }
    if (model.providerID === "openrouter") {
      if (model.api.id.includes("google")) {
        return { reasoning: { enabled: false } }
      }
      return { reasoningEffort: "minimal" }
    }

    if (model.providerID === "venice") {
      return { veniceParameters: { disableThinking: true } }
    }

    return {}
  }

  // Maps model ID prefix to provider slug used in providerOptions.
  // Example: "amazon/nova-2-lite" → "bedrock"
  const SLUG_OVERRIDES: Record<string, string> = {
    amazon: "bedrock",
  }

  export function providerOptions(model: Provider.Model, options: { [x: string]: any }) {
    if (model.api.npm === "@ai-sdk/gateway") {
      // Gateway providerOptions are split across two namespaces:
      // - `gateway`: gateway-native routing/caching controls (order, only, byok, etc.)
      // - `<upstream slug>`: provider-specific model options (anthropic/openai/...)
      // We keep `gateway` as-is and route every other top-level option under the
      // model-derived upstream slug.
      const i = model.api.id.indexOf("/")
      const rawSlug = i > 0 ? model.api.id.slice(0, i) : undefined
      const slug = rawSlug ? (SLUG_OVERRIDES[rawSlug] ?? rawSlug) : undefined
      const gateway = options.gateway
      const rest = Object.fromEntries(Object.entries(options).filter(([k]) => k !== "gateway"))
      const has = Object.keys(rest).length > 0

      const result: Record<string, any> = {}
      if (gateway !== undefined) result.gateway = gateway

      if (has) {
        if (slug) {
          // Route model-specific options under the provider slug
          result[slug] = rest
        } else if (gateway && typeof gateway === "object" && !Array.isArray(gateway)) {
          result.gateway = { ...gateway, ...rest }
        } else {
          result.gateway = rest
        }
      }

      return result
    }

    const key = sdkKey(model.api.npm) ?? model.providerID
    // @ai-sdk/azure delegates to OpenAIChatLanguageModel which reads from
    // providerOptions["openai"], but OpenAIResponsesLanguageModel checks
    // "azure" first. Pass both so model options work on either code path.
    if (model.api.npm === "@ai-sdk/azure") {
      return { openai: options, azure: options }
    }
    return { [key]: options }
  }

  export function parallelToolCallOptions(input: {
    model: Provider.Model
    enabled: boolean
    provider?: {
      parallelToolCalls?: boolean
    }
  }) {
    if (input.model.api.npm === "@ai-sdk/openai" || input.model.api.npm === "@ai-sdk/github-copilot") {
      const enabled = input.provider?.parallelToolCalls ?? input.enabled
      return { parallelToolCalls: enabled }
    }
    return {}
  }

  export function maxOutputTokens(model: Provider.Model): number {
    return Math.min(model.limit.output, OUTPUT_TOKEN_MAX) || OUTPUT_TOKEN_MAX
  }

  export function schema(model: Provider.Model, schema: JSONSchema.BaseSchema | JSONSchema7): JSONSchema7 {
    /*
    if (["openai", "azure"].includes(providerID)) {
      if (schema.type === "object" && schema.properties) {
        for (const [key, value] of Object.entries(schema.properties)) {
          if (schema.required?.includes(key)) continue
          schema.properties[key] = {
            anyOf: [
              value as JSONSchema.JSONSchema,
              {
                type: "null",
              },
            ],
          }
        }
      }
    }
    */

    // Strict schema sanitizer for providers that reject extra keywords alongside $ref
    // and don't support tuple items (e.g., Moonshot/Kimi APIs)
    if (model.capabilities?.schema_compat === "strict") {
      const sanitize = (obj: unknown): unknown => {
        if (obj === null || typeof obj !== "object") return obj
        if (Array.isArray(obj)) return obj.map(sanitize)
        if ("$ref" in (obj as object) && typeof (obj as any).$ref === "string") return { $ref: (obj as any).$ref }
        const result = Object.fromEntries(Object.entries(obj as object).map(([k, v]) => [k, sanitize(v)]))
        if (Array.isArray(result.items)) result.items = result.items[0] ?? {}
        return result
      }
      const sanitized = sanitize(schema)
      if (typeof sanitized === "object" && sanitized !== null && !Array.isArray(sanitized)) {
        schema = sanitized as typeof schema
      }
    }

    // Convert integer enums to string enums for Google/Gemini
    if (model.providerID === "google" || model.api.id.includes("gemini")) {
      const isPlainObject = (node: unknown): node is Record<string, any> =>
        typeof node === "object" && node !== null && !Array.isArray(node)
      const hasCombiner = (node: unknown) =>
        isPlainObject(node) && (Array.isArray(node.anyOf) || Array.isArray(node.oneOf) || Array.isArray(node.allOf))
      const hasSchemaIntent = (node: unknown) => {
        if (!isPlainObject(node)) return false
        if (hasCombiner(node)) return true
        return [
          "type",
          "properties",
          "items",
          "prefixItems",
          "enum",
          "const",
          "$ref",
          "additionalProperties",
          "patternProperties",
          "required",
          "not",
          "if",
          "then",
          "else",
        ].some((key) => key in node)
      }

      const sanitizeGemini = (obj: any): any => {
        if (obj === null || typeof obj !== "object") {
          return obj
        }

        if (Array.isArray(obj)) {
          return obj.map(sanitizeGemini)
        }

        const result: any = {}
        for (const [key, value] of Object.entries(obj)) {
          if (key === "enum" && Array.isArray(value)) {
            // Convert all enum values to strings
            result[key] = value.map((v) => String(v))
            // If we have integer type with enum, change type to string
            if (result.type === "integer" || result.type === "number") {
              result.type = "string"
            }
          } else if (typeof value === "object" && value !== null) {
            result[key] = sanitizeGemini(value)
          } else {
            result[key] = value
          }
        }

        // Filter required array to only include fields that exist in properties
        if (result.type === "object" && result.properties && Array.isArray(result.required)) {
          result.required = result.required.filter((field: any) => field in result.properties)
        }

        if (result.type === "array" && !hasCombiner(result)) {
          if (result.items == null) {
            result.items = {}
          }
          // Ensure items has a type only when it's still schema-empty.
          if (isPlainObject(result.items) && !hasSchemaIntent(result.items)) {
            result.items.type = "string"
          }
        }

        // Remove properties/required from non-object types (Gemini rejects these)
        if (result.type && result.type !== "object" && !hasCombiner(result)) {
          delete result.properties
          delete result.required
        }

        // Strip JSON Schema keywords unsupported by Gemini
        delete result.additionalProperties
        delete result.patternProperties
        delete result.if
        delete result.then
        delete result.else
        delete result.not

        return result
      }

      schema = sanitizeGemini(schema)
    }

    return schema as JSONSchema7
  }
}
