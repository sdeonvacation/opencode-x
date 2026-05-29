const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/g
const placeholderRegex = /\$(\d+)/g
const quoteTrimRegex = /^["']|["']$/g

export function applyArgs(template: string, args: string): string {
  const raw = args.match(argsRegex) ?? []
  const parts = raw.map((arg) => arg.replace(quoteTrimRegex, ""))

  const placeholders = template.match(placeholderRegex) ?? []
  let last = 0
  for (const item of placeholders) {
    const value = Number(item.slice(1))
    if (value > last) last = value
  }

  const withArgs = template.replaceAll(placeholderRegex, (_, index) => {
    const position = Number(index)
    const idx = position - 1
    if (idx >= parts.length) return ""
    if (position === last) return parts.slice(idx).join(" ")
    return parts[idx]
  })

  const usesArguments = template.includes("$ARGUMENTS")
  let out = withArgs.replaceAll("$ARGUMENTS", args)

  if (placeholders.length === 0 && !usesArguments && args.trim()) {
    out = out + "\n\n" + args
  }

  return out
}
