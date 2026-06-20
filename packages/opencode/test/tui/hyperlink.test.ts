import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Hyperlink } from "../../src/cli/cmd/tui/util/hyperlink"

describe("Hyperlink", () => {
  describe("URL_REGEX", () => {
    test("matches http urls", () => {
      const matches = "visit http://example.com today".match(Hyperlink.URL_REGEX)
      expect(matches).toEqual(["http://example.com"])
    })

    test("matches https urls", () => {
      const matches = "see https://github.com/foo/bar".match(Hyperlink.URL_REGEX)
      expect(matches).toEqual(["https://github.com/foo/bar"])
    })

    test("matches urls with paths and query params", () => {
      const matches = "go to https://x.com/path?q=1&b=2#hash end".match(Hyperlink.URL_REGEX)
      expect(matches).toEqual(["https://x.com/path?q=1&b=2#hash"])
    })

    test("does not match bare domains without scheme", () => {
      const matches = "visit example.com today".match(Hyperlink.URL_REGEX)
      expect(matches).toBeNull()
    })

    test("does not match ftp or other schemes", () => {
      const matches = "ftp://files.example.com".match(Hyperlink.URL_REGEX)
      expect(matches).toBeNull()
    })

    test("stops at closing paren", () => {
      const matches = "(https://example.com)".match(Hyperlink.URL_REGEX)
      expect(matches).toEqual(["https://example.com"])
    })

    test("stops at closing bracket", () => {
      const matches = "[https://example.com]".match(Hyperlink.URL_REGEX)
      expect(matches).toEqual(["https://example.com"])
    })

    test("stops at quote", () => {
      const matches = `"https://example.com"`.match(Hyperlink.URL_REGEX)
      expect(matches).toEqual(["https://example.com"])
    })

    test("matches multiple urls in one string", () => {
      const matches = "http://a.com and https://b.com".match(Hyperlink.URL_REGEX)
      expect(matches).toEqual(["http://a.com", "https://b.com"])
    })
  })

  describe("detect", () => {
    const orig: Record<string, string | undefined> = {}

    beforeEach(() => {
      orig["TMUX"] = process.env["TMUX"]
      orig["TMUX_PASSTHROUGH"] = process.env["TMUX_PASSTHROUGH"]
      orig["TERM_PROGRAM"] = process.env["TERM_PROGRAM"]
      orig["TERM"] = process.env["TERM"]
    })

    afterEach(() => {
      for (const [k, v] of Object.entries(orig)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    })

    test("returns click-only in tmux without passthrough", () => {
      process.env["TMUX"] = "/tmp/tmux-1000/default,12345,0"
      delete process.env["TMUX_PASSTHROUGH"]
      process.env["TERM_PROGRAM"] = "iTerm.app"
      expect(Hyperlink.detect()).toBe("click-only")
    })

    test("returns osc8 in tmux with passthrough", () => {
      process.env["TMUX"] = "/tmp/tmux-1000/default,12345,0"
      process.env["TMUX_PASSTHROUGH"] = "1"
      process.env["TERM_PROGRAM"] = "iTerm.app"
      expect(Hyperlink.detect()).toBe("osc8")
    })

    test("returns osc8 for iTerm", () => {
      delete process.env["TMUX"]
      process.env["TERM_PROGRAM"] = "iTerm.app"
      expect(Hyperlink.detect()).toBe("osc8")
    })

    test("returns osc8 for WezTerm", () => {
      delete process.env["TMUX"]
      process.env["TERM_PROGRAM"] = "WezTerm"
      expect(Hyperlink.detect()).toBe("osc8")
    })

    test("returns osc8 for kitty via TERM_PROGRAM", () => {
      delete process.env["TMUX"]
      process.env["TERM_PROGRAM"] = "kitty"
      expect(Hyperlink.detect()).toBe("osc8")
    })

    test("returns osc8 for kitty via TERM", () => {
      delete process.env["TMUX"]
      process.env["TERM_PROGRAM"] = ""
      process.env["TERM"] = "xterm-kitty"
      expect(Hyperlink.detect()).toBe("osc8")
    })

    test("returns osc8 for ghostty", () => {
      delete process.env["TMUX"]
      process.env["TERM_PROGRAM"] = "ghostty"
      expect(Hyperlink.detect()).toBe("osc8")
    })

    test("returns osc8 for vscode", () => {
      delete process.env["TMUX"]
      process.env["TERM_PROGRAM"] = "vscode"
      expect(Hyperlink.detect()).toBe("osc8")
    })

    test("returns click-only for unknown terminal", () => {
      delete process.env["TMUX"]
      process.env["TERM_PROGRAM"] = "xterm"
      process.env["TERM"] = "xterm-256color"
      expect(Hyperlink.detect()).toBe("click-only")
    })
  })

  describe("supported", () => {
    const orig: Record<string, string | undefined> = {}

    beforeEach(() => {
      orig["TMUX"] = process.env["TMUX"]
      orig["TMUX_PASSTHROUGH"] = process.env["TMUX_PASSTHROUGH"]
      orig["TERM_PROGRAM"] = process.env["TERM_PROGRAM"]
      orig["TERM"] = process.env["TERM"]
    })

    afterEach(() => {
      for (const [k, v] of Object.entries(orig)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    })

    test("returns true when detect is osc8", () => {
      delete process.env["TMUX"]
      process.env["TERM_PROGRAM"] = "iTerm.app"
      expect(Hyperlink.supported()).toBe(true)
    })

    test("returns false when detect is click-only", () => {
      delete process.env["TMUX"]
      process.env["TERM_PROGRAM"] = "xterm"
      process.env["TERM"] = "xterm-256color"
      expect(Hyperlink.supported()).toBe(false)
    })
  })

  describe("wrap", () => {
    test("produces correct OSC-8 sequence", () => {
      const result = Hyperlink.wrap("https://example.com", "Example")
      expect(result).toBe("\x1b]8;;https://example.com\x07Example\x1b]8;;\x07")
    })

    test("handles empty label", () => {
      const result = Hyperlink.wrap("https://x.com", "")
      expect(result).toBe("\x1b]8;;https://x.com\x07\x1b]8;;\x07")
    })

    test("handles url with special characters", () => {
      const url = "https://example.com/path?q=hello%20world&x=1"
      const result = Hyperlink.wrap(url, "link")
      expect(result).toBe(`\x1b]8;;${url}\x07link\x1b]8;;\x07`)
    })
  })

  describe("segment", () => {
    test("splits text with url in middle", () => {
      const result = Hyperlink.segment("hello https://x.com world")
      expect(result).toEqual([
        { type: "text", value: "hello " },
        { type: "url", value: "https://x.com", href: "https://x.com" },
        { type: "text", value: " world" },
      ])
    })

    test("handles text with no urls", () => {
      const result = Hyperlink.segment("no links here")
      expect(result).toEqual([{ type: "text", value: "no links here" }])
    })

    test("handles url at start", () => {
      const result = Hyperlink.segment("https://a.com is good")
      expect(result).toEqual([
        { type: "url", value: "https://a.com", href: "https://a.com" },
        { type: "text", value: " is good" },
      ])
    })

    test("handles url at end", () => {
      const result = Hyperlink.segment("visit https://a.com")
      expect(result).toEqual([
        { type: "text", value: "visit " },
        { type: "url", value: "https://a.com", href: "https://a.com" },
      ])
    })

    test("handles multiple urls", () => {
      const result = Hyperlink.segment("see http://a.com and https://b.com/path")
      expect(result).toEqual([
        { type: "text", value: "see " },
        { type: "url", value: "http://a.com", href: "http://a.com" },
        { type: "text", value: " and " },
        { type: "url", value: "https://b.com/path", href: "https://b.com/path" },
      ])
    })

    test("handles text that is only a url", () => {
      const result = Hyperlink.segment("https://only.com")
      expect(result).toEqual([{ type: "url", value: "https://only.com", href: "https://only.com" }])
    })

    test("handles empty string", () => {
      const result = Hyperlink.segment("")
      expect(result).toEqual([])
    })

    test("handles adjacent urls", () => {
      const result = Hyperlink.segment("https://a.com https://b.com")
      expect(result).toEqual([
        { type: "url", value: "https://a.com", href: "https://a.com" },
        { type: "text", value: " " },
        { type: "url", value: "https://b.com", href: "https://b.com" },
      ])
    })
  })

  describe("linkify", () => {
    test("converts bare URL to markdown link", () => {
      expect(Hyperlink.linkify("Visit https://example.com for info")).toBe(
        "Visit [https://example.com](https://example.com) for info",
      )
    })

    test("preserves existing markdown links", () => {
      const md = "See [docs](https://example.com/docs) here"
      expect(Hyperlink.linkify(md)).toBe(md)
    })

    test("preserves inline code", () => {
      const md = "Run `curl https://api.example.com/v1` to test"
      expect(Hyperlink.linkify(md)).toBe(md)
    })

    test("preserves fenced code blocks", () => {
      const md = "Example:\n```\nhttps://example.com\n```\nEnd"
      expect(Hyperlink.linkify(md)).toBe(md)
    })

    test("linkifies URL outside code but not inside", () => {
      const md = "See https://a.com and `https://b.com`"
      expect(Hyperlink.linkify(md)).toBe("See [https://a.com](https://a.com) and `https://b.com`")
    })

    test("handles multiple bare URLs", () => {
      const md = "Check https://a.com and https://b.com"
      expect(Hyperlink.linkify(md)).toBe("Check [https://a.com](https://a.com) and [https://b.com](https://b.com)")
    })

    test("does not linkify URLs inside angle brackets", () => {
      const md = "Source: <https://example.com>"
      expect(Hyperlink.linkify(md)).toBe(md)
    })

    test("no URLs returns unchanged", () => {
      const md = "No links here at all"
      expect(Hyperlink.linkify(md)).toBe(md)
    })
  })
})
