import type { Part } from "@opencode-ai/sdk/v2"

export interface SearchMatch {
  messageID: string
  partID: string
  offset: number
  length: number
}

export namespace SearchText {
  /** Extract searchable plain text from message parts */
  export function extract(parts: Part[]): Array<{ id: string; text: string }> {
    const result: Array<{ id: string; text: string }> = []
    for (const part of parts) {
      if (part.type !== "text") continue
      if (!part.text || !part.text.trim()) continue
      result.push({ id: part.id, text: part.text })
    }
    return result
  }

  /** Find all substring matches (case-insensitive) */
  export function find(
    corpus: Array<{ id: string; text: string }>,
    query: string,
    messageID: string,
  ): SearchMatch[] {
    if (!query) return []
    const matches: SearchMatch[] = []
    const lower = query.toLowerCase()
    for (const entry of corpus) {
      const text = entry.text.toLowerCase()
      let pos = 0
      while (true) {
        const idx = text.indexOf(lower, pos)
        if (idx === -1) break
        matches.push({
          messageID,
          partID: entry.id,
          offset: idx,
          length: query.length,
        })
        pos = idx + 1
      }
    }
    return matches
  }
}
