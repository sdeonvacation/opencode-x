export namespace Hyperlink {
  /** Conservative URL regex: requires scheme */
  export const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/g

  export type SupportLevel = "osc8" | "click-only"

  /** Detect terminal support based on env vars */
  export function detect(): SupportLevel {
    if (process.env["TMUX"] && !process.env["TMUX_PASSTHROUGH"]) return "click-only"
    const term = process.env["TERM_PROGRAM"] ?? ""
    const osc8Terms = ["iTerm.app", "WezTerm", "kitty", "ghostty", "vscode"]
    if (osc8Terms.some((t) => term.includes(t))) return "osc8"
    if ((process.env["TERM"] ?? "").includes("kitty")) return "osc8"
    return "click-only"
  }

  /** Check if OSC-8 should be used */
  export function supported(): boolean {
    return detect() === "osc8"
  }

  /** Wrap text with OSC-8 escape for terminal hyperlinks */
  export function wrap(url: string, label: string): string {
    return `\x1b]8;;${url}\x07${label}\x1b]8;;\x07`
  }

  export type Segment = { type: "text"; value: string } | { type: "url"; value: string; href: string }

  /** Split text into segments: plain text and URL spans */
  export function segment(text: string): Segment[] {
    const result: Segment[] = []
    const regex = new RegExp(URL_REGEX.source, "g")
    let last = 0
    let match: RegExpExecArray | null
    while ((match = regex.exec(text)) !== null) {
      if (match.index > last) {
        result.push({ type: "text", value: text.slice(last, match.index) })
      }
      result.push({ type: "url", value: match[0], href: match[0] })
      last = match.index + match[0].length
    }
    if (last < text.length) {
      result.push({ type: "text", value: text.slice(last) })
    }
    return result
  }

  /**
   * Convert bare URLs in markdown text to [url](url) links.
   * Preserves fenced code blocks, inline code, and existing markdown links.
   */
  export function linkify(md: string): string {
    return md.replace(
      /(```[\s\S]*?```)|(`[^`\n]+`)|((?<!\]\(|<)https?:\/\/[^\s<>"')\]]+)/g,
      (_, fenced: string | undefined, inline: string | undefined, url: string | undefined) => {
        if (fenced) return fenced
        if (inline) return inline
        return `[${url}](${url})`
      },
    )
  }
}
