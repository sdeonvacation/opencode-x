export namespace WorkflowMeta {
  export type Meta = {
    name?: string
    description?: string
    args?: Record<string, { type: string; required?: boolean; default?: unknown }>
    timeout?: number
    max_agents?: number
  }

  export type Parsed = { meta: Meta; body: string }
  export type ParseError = { line: number; message: string }

  const START = "/// meta"
  const END = "/// end meta"
  const PREFIX = "///"

  export function parse(source: string): Parsed | ParseError {
    const lines = source.split("\n")
    if (lines.length === 0 || lines[0].trim() !== START) return { meta: {}, body: source }

    const meta: Meta = {}
    let end = -1

    for (let i = 1; i < lines.length; i++) {
      const trimmed = lines[i].trim()
      if (trimmed === END) {
        end = i
        break
      }
      if (!trimmed.startsWith(PREFIX)) return { line: i + 1, message: `expected "///" prefix` }

      const content = trimmed.slice(PREFIX.length).trim()
      if (content === "") continue

      const colon = content.indexOf(":")
      if (colon === -1) return { line: i + 1, message: `expected key: value pair` }

      const key = content.slice(0, colon).trim()
      const raw = content.slice(colon + 1).trim()

      const result = parseValue(raw)
      if (result.error) return { line: i + 1, message: result.error }

      switch (key) {
        case "name":
          meta.name = result.value as string
          break
        case "description":
          meta.description = result.value as string
          break
        case "args":
          meta.args = result.value as Meta["args"]
          break
        case "timeout":
          meta.timeout = result.value as number
          break
        case "max_agents":
          meta.max_agents = result.value as number
          break
        default:
          return { line: i + 1, message: `unknown key "${key}"` }
      }
    }

    if (end === -1) return { line: lines.length, message: `missing "/// end meta"` }

    const body = lines.slice(end + 1).join("\n")
    return { meta, body }
  }

  type ValueResult = { value: unknown; error?: undefined } | { value?: undefined; error: string }

  function parseValue(raw: string): ValueResult {
    const ctx = { src: raw, pos: 0 }
    const result = parseExpr(ctx)
    if (result.error) return result
    skipWhitespace(ctx)
    if (ctx.pos < ctx.src.length) return { error: `unexpected character at position ${ctx.pos}` }
    return result
  }

  type Ctx = { src: string; pos: number }

  function parseExpr(ctx: Ctx): ValueResult {
    skipWhitespace(ctx)
    if (ctx.pos >= ctx.src.length) return { error: "unexpected end of input" }

    const ch = ctx.src[ctx.pos]
    if (ch === '"' || ch === "'") return parseString(ctx)
    if (ch === "{") return parseObject(ctx)
    if (ch === "[") return parseArray(ctx)
    if (ch === "-" || (ch >= "0" && ch <= "9")) return parseNumber(ctx)
    return parseKeyword(ctx)
  }

  function parseString(ctx: Ctx): ValueResult {
    const quote = ctx.src[ctx.pos]
    ctx.pos++
    let val = ""
    while (ctx.pos < ctx.src.length) {
      const ch = ctx.src[ctx.pos]
      if (ch === "\\") {
        ctx.pos++
        if (ctx.pos >= ctx.src.length) return { error: "unterminated escape" }
        const esc = ctx.src[ctx.pos]
        switch (esc) {
          case "n":
            val += "\n"
            break
          case "t":
            val += "\t"
            break
          case "\\":
            val += "\\"
            break
          case '"':
            val += '"'
            break
          case "'":
            val += "'"
            break
          default:
            val += esc
        }
        ctx.pos++
        continue
      }
      if (ch === quote) {
        ctx.pos++
        return { value: val }
      }
      val += ch
      ctx.pos++
    }
    return { error: "unterminated string" }
  }

  function parseNumber(ctx: Ctx): ValueResult {
    const start = ctx.pos
    if (ctx.src[ctx.pos] === "-") ctx.pos++
    while (ctx.pos < ctx.src.length && ctx.src[ctx.pos] >= "0" && ctx.src[ctx.pos] <= "9") ctx.pos++
    if (ctx.pos < ctx.src.length && ctx.src[ctx.pos] === ".") {
      ctx.pos++
      while (ctx.pos < ctx.src.length && ctx.src[ctx.pos] >= "0" && ctx.src[ctx.pos] <= "9") ctx.pos++
    }
    const num = Number(ctx.src.slice(start, ctx.pos))
    if (Number.isNaN(num)) return { error: `invalid number at position ${start}` }
    return { value: num }
  }

  function parseObject(ctx: Ctx): ValueResult {
    ctx.pos++ // skip {
    const obj: Record<string, unknown> = {}
    skipWhitespace(ctx)
    if (ctx.pos < ctx.src.length && ctx.src[ctx.pos] === "}") {
      ctx.pos++
      return { value: obj }
    }

    while (true) {
      skipWhitespace(ctx)
      const key = parseObjectKey(ctx)
      if (key.error) return key

      skipWhitespace(ctx)
      if (ctx.pos >= ctx.src.length || ctx.src[ctx.pos] !== ":") return { error: `expected ":" after key` }
      ctx.pos++

      const val = parseExpr(ctx)
      if (val.error) return val
      obj[key.value as string] = val.value

      skipWhitespace(ctx)
      if (ctx.pos >= ctx.src.length) return { error: "unterminated object" }
      if (ctx.src[ctx.pos] === "}") {
        ctx.pos++
        return { value: obj }
      }
      if (ctx.src[ctx.pos] === ",") {
        ctx.pos++
        continue
      }
      return { error: `expected "," or "}" in object` }
    }
  }

  function parseObjectKey(ctx: Ctx): ValueResult {
    if (ctx.pos >= ctx.src.length) return { error: "expected object key" }
    const ch = ctx.src[ctx.pos]
    if (ch === '"' || ch === "'") return parseString(ctx)
    // unquoted key: identifier chars
    const start = ctx.pos
    while (ctx.pos < ctx.src.length && isIdentChar(ctx.src[ctx.pos])) ctx.pos++
    if (ctx.pos === start) return { error: "expected object key" }
    return { value: ctx.src.slice(start, ctx.pos) }
  }

  function parseArray(ctx: Ctx): ValueResult {
    ctx.pos++ // skip [
    const arr: unknown[] = []
    skipWhitespace(ctx)
    if (ctx.pos < ctx.src.length && ctx.src[ctx.pos] === "]") {
      ctx.pos++
      return { value: arr }
    }

    while (true) {
      const val = parseExpr(ctx)
      if (val.error) return val
      arr.push(val.value)

      skipWhitespace(ctx)
      if (ctx.pos >= ctx.src.length) return { error: "unterminated array" }
      if (ctx.src[ctx.pos] === "]") {
        ctx.pos++
        return { value: arr }
      }
      if (ctx.src[ctx.pos] === ",") {
        ctx.pos++
        continue
      }
      return { error: `expected "," or "]" in array` }
    }
  }

  function parseKeyword(ctx: Ctx): ValueResult {
    const start = ctx.pos
    while (ctx.pos < ctx.src.length && isIdentChar(ctx.src[ctx.pos])) ctx.pos++
    const word = ctx.src.slice(start, ctx.pos)
    if (word === "true") return { value: true }
    if (word === "false") return { value: false }
    if (word === "null") return { value: null }
    if (word === "undefined") return { value: undefined }
    if (word === "") return { error: `unexpected character "${ctx.src[start]}"` }
    return { error: `unknown keyword "${word}"` }
  }

  function skipWhitespace(ctx: Ctx) {
    while (ctx.pos < ctx.src.length && (ctx.src[ctx.pos] === " " || ctx.src[ctx.pos] === "\t")) ctx.pos++
  }

  function isIdentChar(ch: string): boolean {
    return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "_" || ch === "$"
  }
}
