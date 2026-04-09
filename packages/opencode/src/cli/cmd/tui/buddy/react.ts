/**
 * Companion reaction system.
 *
 * Called from the TUI after each query turn. Checks mute state, frequency
 * limits, and name-mention detection, then calls a local LLM to generate
 * a reaction shown in the companion speech bubble.
 */
import { generateText } from "ai"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import type { Config } from "@/config/config"
import { getCompanion } from "./companion"

// Minimal shape needed from session messages — avoids importing the full SDK type
type MessageLike = {
  role?: string
  type?: string
  content?: string | Array<{ type: string; text?: string }>
  message?: { content?: string | Array<{ type: string; text?: string }> }
  time?: { created?: number; completed?: number }
}

// ─── Rate limiting ──────────────────────────────────

let lastReactTime = 0
const MIN_INTERVAL_MS = 45_000

// ─── Recent reactions (avoid repetition) ────────────

const recentReactions: string[] = []
const MAX_RECENT = 8

// ─── Model resolution ───────────────────────────────

async function getReactionModel(config: Config.Info, activeModel: { providerID: string; modelID: string }) {
  const override = config.experimental?.buddy_model
  const { providerID, modelID } = override ?? activeModel
  const model = await Provider.getModel(ProviderID.make(providerID), ModelID.make(modelID))
  return Provider.getLanguage(model)
}

// ─── Helpers ────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function isAddressed(messages: MessageLike[], name: string): boolean {
  const pattern = new RegExp(`\\b${escapeRegex(name)}\\b`, "i")
  for (let i = messages.length - 1; i >= Math.max(0, messages.length - 3); i--) {
    const m = messages[i]
    if (!m) continue
    // Support both role-based messages and type-based messages
    const isUser = m.role === "user" || m.type === "user"
    if (!isUser) continue
    const content = m.content ?? m.message?.content
    if (typeof content === "string" && pattern.test(content)) return true
    if (Array.isArray(content)) {
      const text = content
        .filter((b) => b?.type === "text")
        .map((b) => b.text ?? "")
        .join(" ")
      if (pattern.test(text)) return true
    }
  }
  return false
}

export function buildTranscript(messages: MessageLike[]): string {
  return messages
    .slice(-12)
    .filter((m) => {
      const role = m.role ?? m.type
      return role === "user" || role === "assistant"
    })
    .map((m) => {
      const role = (m.role ?? m.type) === "user" ? "user" : "assistant"
      const content = m.content ?? m.message?.content
      const text =
        typeof content === "string"
          ? content.slice(0, 300)
          : Array.isArray(content)
            ? content
                .filter((b) => b?.type === "text")
                .map((b) => b.text ?? "")
                .join(" ")
                .slice(0, 300)
            : ""
      return `${role}: ${text}`
    })
    .join("\n")
    .slice(0, 5000)
}

// ─── Core reaction call ──────────────────────────────

async function callReaction(
  companion: {
    name: string
    personality: string
    species: string
    rarity: string
    stats: Record<string, number>
  },
  transcript: string,
  addressed: boolean,
  config: Config.Info,
  activeModel: { providerID: string; modelID: string },
  abort?: AbortSignal,
): Promise<string | null> {
  const stats = companion.stats
  const d = stats["DEBUGGING"]
  const p = stats["PATIENCE"]
  const c = stats["CHAOS"]
  const w = stats["WISDOM"]
  const s = stats["SNARK"]

  const system = `You are ${companion.name}, a small ${companion.species} companion sitting beside a developer's input box.
Personality: ${companion.personality}
Stats: DEBUGGING ${d ?? "?"}, PATIENCE ${p ?? "?"}, CHAOS ${c ?? "?"}, WISDOM ${w ?? "?"}, SNARK ${s ?? "?"}
Rarity: ${companion.rarity}

React to the conversation with ONE short sentence (15 words max).
Never use markdown. Never explain yourself. Be in character.
If addressed by name, respond directly to what was said.
Recent reactions to avoid repeating: ${recentReactions.slice(-5).join(" | ") || "none"}`

  const languageModel = await getReactionModel(config, activeModel)

  const result = await generateText({
    model: languageModel,
    system,
    prompt: transcript,
    maxOutputTokens: 60,
    abortSignal: abort,
  })

  return result.text.trim() || null
}

// ─── Public API ─────────────────────────────────────

/**
 * Trigger a companion reaction after a query turn.
 *
 * 1. Check companion exists and is not muted
 * 2. Detect if user mentioned companion by name
 * 3. Apply rate limiting (skip if not addressed and too soon)
 * 4. Build conversation transcript
 * 5. Call local LLM for reaction
 * 6. Pass reaction text to setReaction callback
 */
export function triggerCompanionReaction(
  messages: MessageLike[],
  setReaction: (text: string | undefined) => void,
  config: Config.Info,
  activeModel: { providerID: string; modelID: string },
  abort?: AbortSignal,
): void {
  const companion = getCompanion(config)
  if (!companion || config.companion_muted) return

  const addressed = isAddressed(messages, companion.name)

  const now = Date.now()
  if (!addressed && now - lastReactTime < MIN_INTERVAL_MS) return

  const transcript = buildTranscript(messages)
  if (!transcript.trim()) return

  lastReactTime = now

  void callReaction(companion, transcript, addressed, config, activeModel, abort)
    .then((reaction) => {
      if (!reaction) return
      recentReactions.push(reaction)
      if (recentReactions.length > MAX_RECENT) recentReactions.shift()
      setReaction(reaction)
    })
    .catch((err) => {
      console.warn("[buddy] reaction error:", err)
    })
}
