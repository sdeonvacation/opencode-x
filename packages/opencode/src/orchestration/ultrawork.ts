import type { ModelRef } from "./category-routing"

const FENCED_CODE_RE = /```[\s\S]*?```/g
const INLINE_CODE_RE = /`[^`]*`/g
const URL_RE = /https?:\/\/\S+/gi
const KEYWORD_RE = /\b(ulw|ultrawork)\b/i

function sanitize(text: string) {
  return text.replace(FENCED_CODE_RE, " ").replace(INLINE_CODE_RE, " ").replace(URL_RE, " ")
}

export function detect(text: string, model?: ModelRef): ModelRef | null {
  if (!model) return null
  return KEYWORD_RE.test(sanitize(text)) ? model : null
}
