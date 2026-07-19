# HLD: kimi-code Feature Ports (SSRF, Cache-Loss Warning, /copy)

## Tech Stack

| Category | Technology            | Purpose                                            |
| -------- | --------------------- | -------------------------------------------------- |
| Language | TypeScript 5.8        | Existing codebase                                  |
| Runtime  | Bun 1.3.11            | Existing runtime                                   |
| Effect   | Effect-ts 4.0-beta    | HttpClient layer wrapping, service composition     |
| DNS      | `node:dns/promises`   | Resolve hostnames before fetch for SSRF validation |
| Net      | `node:net` BlockList  | Efficient private IP range matching                |
| TUI      | @opentui/core + Solid | Toast warnings, command palette                    |

## Components

| Component               | Responsibility                                                          | Dependencies                                    |
| ----------------------- | ----------------------------------------------------------------------- | ----------------------------------------------- |
| url-safety              | Validate URLs against SSRF (DNS resolve, IP blocklist, scheme check)    | `node:dns/promises`, `node:net`                 |
| ssrf-http-layer         | Effect HttpClient wrapper that validates + follows redirects safely     | url-safety, `HttpClient`                        |
| cache-warning           | Toast when model switch invalidates Anthropic prompt cache              | local.tsx model state, toast, sync.data.message |
| /copy (behavior change) | Change existing `/copy` slash from transcript to last-assistant-message | Existing CommandOption, Clipboard               |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Tool Registry (registry.ts)                            │
│  Layer.provide(ssrfSafeLayer)  ← replaces FetchHttp    │
└────────────┬────────────────────────────────────────────┘
             │ provides HttpClient.HttpClient
             ▼
┌────────────────────────┐     ┌─────────────────────────┐
│  webfetch.ts           │     │  research.ts            │
│  (uses HttpClient)     │     │  (uses HttpClient)      │
└────────────────────────┘     └─────────────────────────┘
             │ request
             ▼
┌────────────────────────────────────────────────────────┐
│  src/tool/ssrf-http.ts  (new file)                     │
│  ┌──────────────┐  ┌─────────────────────────┐        │
│  │ interceptReq │→ │ validateUrl (url-safety) │        │
│  └──────┬───────┘  └─────────────────────────┘        │
│         │ validated                                     │
│         ▼                                              │
│  ┌──────────────────────────┐                          │
│  │ fetch (redirect:manual)  │                          │
│  └──────┬───────────────────┘                          │
│         │ 3xx?                                         │
│         ▼                                              │
│  ┌──────────────────────────┐                          │
│  │ validateRedirect → loop  │ (max 10 hops)           │
│  └──────────────────────────┘                          │
└────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  TUI: local.tsx                                         │
│  model.set() / variant.set()                            │
│  → check hasMessages && isAnthropicProvider             │
│  → toast.show({ variant: "warning", ... })              │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  TUI: session/index.tsx                                 │
│  Existing "/copy" slash CommandOption                   │
│  → Change onSelect: transcript → last assistant msg     │
│  → Rename transcript action to "/transcript"            │
└─────────────────────────────────────────────────────────┘
```

Description: SSRF layer wraps the existing `FetchHttpClient.layer` in `registry.ts` (single injection point for all tools). Cache warning is purely TUI-side logic in existing model.set()/variant.set() methods. /copy is a behavior change to existing CommandOption.

## Interfaces

### url-safety (`src/tool/url-safety.ts`)

| Method             | Input                                            | Output                                                             | Behavior                                                                            | Errors                    |
| ------------------ | ------------------------------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------- |
| `isBlockedAddress` | `address: string`                                | `boolean`                                                          | Check IP against BlockList (loopback, RFC1918, link-local, CGNAT, ULA, unspecified) | None (pure)               |
| `validateUrl`      | `url: string, opts?: { allowPrivate?: boolean }` | `Promise<{ hostname: string; port: number; addresses: string[] }>` | Parse URL, validate scheme (http/https only), resolve DNS, check all IPs            | Throws if blocked/invalid |

### ssrf-http (`src/tool/ssrf-http.ts`)

| Method          | Input                               | Output                               | Behavior                                                                                                     | Errors                          |
| --------------- | ----------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| `ssrfSafeLayer` | `opts?: { allowPrivate?: boolean }` | `Layer.Layer<HttpClient.HttpClient>` | Returns Effect Layer wrapping FetchHttpClient with SSRF validation + manual redirect following (max 10 hops) | `SsrfBlockedError` on violation |

## Data Flow

### SSRF Validation Flow

| Step | Component                | Action                                                                                       | Next                |
| ---- | ------------------------ | -------------------------------------------------------------------------------------------- | ------------------- |
| 1    | Tool (webfetch/research) | Calls `httpOk.execute(request)`                                                              | ssrf-http intercept |
| 2    | ssrf-http                | Extracts URL from request, calls `validateUrl`                                               | url-safety          |
| 3    | url-safety               | Parses URL, resolves DNS via `dns.resolve4`/`dns.resolve6`, checks all IPs against BlockList | Return or throw     |
| 4    | ssrf-http                | If valid, executes fetch with `redirect: "manual"`                                           | raw response        |
| 5    | ssrf-http                | If 3xx, extracts Location header, calls `validateUrl` on redirect target                     | Loop (max 10)       |
| 6    | ssrf-http                | Returns final response to caller                                                             | Tool                |

**Error Flow**: If any IP resolves to private range → throw `SsrfBlockedError("Request blocked: target resolves to private network address")`. Caller (webfetch.ts) already has error handling that surfaces tool errors to the LLM.

### Cache Warning Flow

| Step | Component     | Action                                                                            | Next             |
| ---- | ------------- | --------------------------------------------------------------------------------- | ---------------- |
| 1    | TUI local.tsx | `model.set()` called                                                              | Check conditions |
| 2    | local.tsx     | Check: session has messages AND previous model providerID starts with "anthropic" | Show/skip        |
| 3    | local.tsx     | `toast.show({ variant: "warning", message: "...", duration: 5000 })`              | Done             |

### /copy Flow

| Step | Component                                | Action                                         | Next         |
| ---- | ---------------------------------------- | ---------------------------------------------- | ------------ |
| 1    | User types `/copy` or picks from palette | CommandOption.onSelect fires                   | Extract text |
| 2    | session/index.tsx                        | Find last assistant message, filter text parts | Clipboard    |
| 3    | Clipboard.copy(text)                     | Write via OSC52 + native                       | Toast        |

## Data Model

No new tables or schema changes required. All state is transient (config flags, runtime validation).

## Decisions

| Decision                                   | Choice                                                                                    | Reason                                                                                              | Alternatives                                                | Tradeoffs                                                                  |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| SSRF: Layer wrapper vs per-call validation | Layer wrapper (`ssrfSafeLayer`)                                                           | Single injection point in registry.ts (line 309); zero changes to webfetch.ts/research.ts tool code | Per-call `validateUrl` before each fetch                    | Layer approach = transparent to consumers, but adds ~1 DNS RTT per request |
| SSRF: DNS pinning (custom lookup)          | Skip — validate-before-fetch only                                                         | Bun's fetch doesn't expose `lookup` option; TOCTOU window is acceptable for a dev tool              | undici Agent with pinned lookup                             | Accept tiny rebinding window; document limitation                          |
| SSRF: Redirect handling                    | Manual redirect loop in layer                                                             | Need to validate each hop; native `redirect: "follow"` skips validation                             | Trust native redirect (insecure)                            | Extra complexity but required for security                                 |
| Cache warning: Detection method            | Check `providerID` string prefix "anthropic"                                              | Simple, no API call needed; covers all Anthropic models                                             | Check provider metadata for cache support                   | May false-positive for non-caching Anthropic models (none exist currently) |
| Cache warning: Trigger condition           | Only when session has messages AND previous model is Anthropic                            | Avoids noise on fresh sessions or non-caching providers                                             | Always warn on model switch                                 | Precision over recall                                                      |
| /copy: Behavior                            | Change existing `/copy` to copy last assistant message; add `/transcript` for full export | Matches kimi-code UX; last-message copy is more common use case                                     | Keep `/copy` as transcript, add `/copylast`                 | Breaking change for users who used `/copy` for transcripts                 |
| Config: allow_private option               | `experimental.allow_private_fetch: boolean`                                               | Follows existing experimental.\* pattern; no permission schema change needed                        | `permissions.webfetch.allow_private_addresses` nested field | Simpler, uses established pattern                                          |

## Risks

| Risk                                                        | Impact                                                             | Likelihood                                      | Mitigation                                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------- |
| DNS TOCTOU (rebinding)                                      | Attacker resolves to public IP first, then private on actual fetch | Low (requires attacker-controlled DNS + timing) | Document limitation; acceptable for dev tool. Could add TTL-based re-check later |
| Bun `redirect: "manual"` not supported in Effect HttpClient | Manual redirect loop fails to intercept                            | Low (standard fetch option)                     | Test during implementation; fallback to pre-validation without redirect control  |
| Cache warning false positive on model rename                | User annoyed by unnecessary warning                                | Low                                             | Only fires when providerID is "anthropic" AND session has messages               |
| `/copy` behavior change breaks existing users               | Users expecting transcript get last message only                   | Med                                             | `/transcript` preserves old behavior; announce in changelog                      |
| Performance: DNS lookup on every webfetch                   | Adds 5-50ms per tool call                                          | Low impact                                      | Webfetch is rare (user-triggered); latency negligible vs network fetch           |

## Test Plan

### Unit Tests

**`test/tool/url-safety.test.ts`** (new file):

- `isBlockedAddress`: 127.0.0.1, 10.x.x.x, 172.16-31.x.x, 192.168.x.x, 169.254.x.x, 100.64.x.x, ::1, fe80::, fc00::, 0.0.0.0, :: → all blocked
- `isBlockedAddress`: 8.8.8.8, 1.1.1.1, 2001:4860::8888 → all allowed
- `validateUrl`: scheme validation (ftp://... → throws, javascript://... → throws)
- `validateUrl`: DNS resolution to private IP → throws
- `validateUrl`: `allowPrivate: true` bypasses blocklist
- `validateUrl`: non-existent domain → throws

**`test/tool/ssrf-http.test.ts`** (new file):

- Layer provides working HttpClient for public URLs
- Layer blocks request when DNS resolves to loopback (mock dns.resolve4)
- Redirect chain: public → public → public (allowed, all 3 hops)
- Redirect chain: public → private (blocked on hop 2)
- Max redirects exceeded (11 hops) → error
- `allowPrivate: true` allows localhost fetch

### Integration Tests

**`test/tool/webfetch.test.ts`** (extend existing):

- Webfetch tool with SSRF-safe layer rejects `http://127.0.0.1` URL
- Webfetch tool with `allowPrivate` config allows localhost
- Existing webfetch tests still pass (regression)

### End-to-End Tests

Not applicable — TUI components (cache warning, /copy) are verified manually. SSRF is covered by unit + integration.

### Non-Functional Tests

- **Performance**: DNS lookup adds < 100ms latency to webfetch (acceptable; tool call is I/O-bound anyway)
- **Security**: No private IP reachable from webfetch without explicit config opt-in

## File Changes

### New Files

| File                           | Lines (est.) | Purpose                                |
| ------------------------------ | ------------ | -------------------------------------- |
| `src/tool/url-safety.ts`       | ~60          | BlockList + DNS validation             |
| `src/tool/ssrf-http.ts`        | ~80          | Effect Layer with SSRF-safe HttpClient |
| `test/tool/url-safety.test.ts` | ~80          | Unit tests for blocklist/validation    |
| `test/tool/ssrf-http.test.ts`  | ~70          | Unit tests for layer behavior          |

### Modified Files

| File                                                         | Change                                                                                             | Lines touched                 |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------- |
| `src/tool/registry.ts` (line 309)                            | Replace `FetchHttpClient.layer` with `ssrfSafeLayer()`                                             | 2 lines (import + layer swap) |
| `src/config/config.ts` (experimental block)                  | Add `allow_private_fetch: z.boolean().optional()`                                                  | 1 line                        |
| `src/cli/cmd/tui/context/local.tsx` (model.set, ~line 290)   | Add cache warning toast after `setModelStore`                                                      | ~8 lines                      |
| `src/cli/cmd/tui/context/local.tsx` (variant.set, ~line 350) | Same cache warning for variant changes                                                             | ~8 lines                      |
| `src/cli/cmd/tui/routes/session/index.tsx` (~line 1096)      | Change `/copy` slash `onSelect` to copy last assistant message; rename transcript to `/transcript` | ~5 lines                      |

### NOT Modified (Surgical Constraint)

- `src/tool/webfetch.ts` — unchanged (layer is injected externally)
- `src/tool/research.ts` — unchanged (same layer injection)
- `src/research/engine.ts` — unchanged
- `src/command/index.ts` — unchanged (/copy is client-side CommandOption, not server command)
- `src/cli/cmd/tui/util/clipboard.ts` — unchanged

## Implementation Notes

### Phase 1: SSRF (src/tool/url-safety.ts)

```typescript
import { lookup } from "node:dns/promises"
import { BlockList, isIP } from "node:net"

const blocklist = new BlockList()
// IPv4
blocklist.addRange("10.0.0.0", "10.255.255.255")
blocklist.addRange("172.16.0.0", "172.31.255.255")
blocklist.addRange("192.168.0.0", "192.168.255.255")
blocklist.addRange("127.0.0.0", "127.255.255.255")
blocklist.addRange("169.254.0.0", "169.254.255.255")
blocklist.addRange("100.64.0.0", "100.127.255.255")
blocklist.addSubnet("0.0.0.0", 8)
// IPv6
blocklist.addAddress("::1", "ipv6")
blocklist.addSubnet("fe80::", 10, "ipv6")
blocklist.addSubnet("fc00::", 7, "ipv6")
blocklist.addAddress("::", "ipv6")

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address) === 6 ? "ipv6" : "ipv4"
  return blocklist.check(address, family)
}

export async function validateUrl(url: string, opts?: { allowPrivate?: boolean }) {
  const parsed = new URL(url)
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`Blocked scheme: ${parsed.protocol}`)

  const hostname = parsed.hostname
  // Direct IP check
  if (isIP(hostname)) {
    if (!opts?.allowPrivate && isBlockedAddress(hostname)) throw new Error(`Blocked: ${hostname} is a private address`)
    return { hostname, port: Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80), addresses: [hostname] }
  }

  // DNS resolution
  const results = await lookup(hostname, { all: true })
  const addresses = results.map((r) => r.address)
  if (!opts?.allowPrivate) {
    for (const addr of addresses) {
      if (isBlockedAddress(addr)) throw new Error(`Blocked: ${hostname} resolves to private address ${addr}`)
    }
  }
  return { hostname, port: Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80), addresses }
}
```

### Phase 1: SSRF Layer (src/tool/ssrf-http.ts)

```typescript
import { Layer, Effect } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { validateUrl } from "./url-safety"

const MAX_REDIRECTS = 10

export function ssrfSafeLayer(opts?: { allowPrivate?: boolean }): Layer.Layer<HttpClient.HttpClient> {
  return Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const base = yield* HttpClient.HttpClient
      return HttpClient.make((request) =>
        Effect.gen(function* () {
          const url = request.url.toString()
          yield* Effect.promise(() => validateUrl(url, opts))

          // Execute with manual redirect handling
          let current = request.pipe(HttpClientRequest.setHeader("x-ssrf-validated", "1"))
          let redirects = 0

          while (true) {
            const response = yield* base.execute(current.pipe(/* set redirect: manual if possible */))
            const status = response.status
            if (status < 300 || status >= 400 || redirects >= MAX_REDIRECTS) return response

            const location = response.headers["location"]
            if (!location) return response

            const resolved = new URL(location, url).toString()
            yield* Effect.promise(() => validateUrl(resolved, opts))
            current = HttpClientRequest.get(resolved)
            redirects++
          }
        }),
      )
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer))
}
```

### Phase 2: Cache Warning (in local.tsx model.set)

```typescript
// After setModelStore("model", ...) in model.set():
const prevModel = currentModel() // capture before set
// ... existing setModelStore call ...

// Cache warning: Anthropic prompt cache invalidated on model switch mid-session
const sessionMessages = sync.data.message[route.data.sessionID ?? ""]
if (sessionMessages?.length && prevModel?.providerID === "anthropic") {
  toast.show({
    variant: "warning",
    message: "Model switch invalidates prompt cache — cached tokens will be re-billed",
    duration: 5000,
  })
}
```

### Phase 3: /copy Behavior Change (session/index.tsx)

Swap the `onSelect` of the existing `/copy` CommandOption (line 1096-1123) to use the last-assistant-message logic (currently at line 1052-1093). Rename the old transcript behavior to `slash: { name: "transcript" }`.
