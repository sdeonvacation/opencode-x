const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
  "msclkid",
  "ref",
  "source",
])

export function canonicalize(raw: string): string {
  try {
    const url = new URL(raw)
    url.hostname = url.hostname.toLowerCase()
    for (const param of TRACKING_PARAMS) {
      url.searchParams.delete(param)
    }
    url.hash = ""
    let path = url.pathname.replace(/\/+$/, "") || "/"
    url.pathname = path
    return url.toString()
  } catch {
    return raw
  }
}

export class DedupMap {
  private seen = new Set<string>()

  add(url: string): boolean {
    const key = canonicalize(url)
    if (this.seen.has(key)) return false
    this.seen.add(key)
    return true
  }

  has(url: string): boolean {
    return this.seen.has(canonicalize(url))
  }

  size(): number {
    return this.seen.size
  }
}

export function allocate(input: { hits: Array<{ url: string; relevance?: number }>; budget: number }): string[] {
  const dedup = new DedupMap()
  const unique: Array<{ url: string; relevance: number }> = []
  for (const hit of input.hits) {
    if (dedup.add(hit.url)) {
      unique.push({ url: hit.url, relevance: hit.relevance ?? 0.5 })
    }
  }
  unique.sort((a, b) => b.relevance - a.relevance)
  return unique.slice(0, input.budget).map((h) => h.url)
}
