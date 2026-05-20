import type { Provider } from "../provider/provider"

export namespace PromptSplit {
  export type SystemContent = {
    text: string
    cache?: boolean
  }

  /**
   * Split system prompt parts into stable prefix + dynamic suffix.
   *
   * Stable: core identity, capabilities, tool guidelines, skills, safety rules, custom instructions.
   * Dynamic: env info (cwd, date), session memory, active goal, persistent memory, runtime state.
   */
  export function split(parts: string[], dynamic: string[]): SystemContent[] {
    const result: SystemContent[] = []

    if (parts.length > 0) {
      result.push({ text: parts.join("\n\n"), cache: true })
    }

    if (dynamic.length > 0) {
      result.push({ text: dynamic.join("\n\n"), cache: false })
    }

    return result
  }

  /**
   * Convert SystemContent[] to Vercel AI SDK content parts format.
   * For Anthropic-like providers, applies cacheControl on the stable prefix part.
   */
  export function applySubPartCache(
    content: SystemContent[],
    model: Provider.Model,
  ): { type: "text"; text: string; providerOptions?: Record<string, unknown> }[] {
    return content.map((part, i) => {
      if (i === 0 && part.cache && isAnthropicLike(model)) {
        return {
          type: "text" as const,
          text: part.text,
          providerOptions: {
            anthropic: { cacheControl: { type: "ephemeral" } },
            bedrock: { cachePoint: { type: "default" } },
            alibaba: { cacheControl: { type: "ephemeral" } },
          },
        }
      }
      return { type: "text" as const, text: part.text }
    })
  }

  function isAnthropicLike(model: Provider.Model): boolean {
    if (model.providerID === "anthropic") return true
    if (model.providerID.includes("bedrock")) return true
    if (model.api.npm === "@ai-sdk/anthropic") return true
    if (model.api.npm === "@ai-sdk/amazon-bedrock") return true
    return false
  }
}
