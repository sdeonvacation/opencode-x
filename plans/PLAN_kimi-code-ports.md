# Plan: kimi-code Feature Ports (SSRF, Cache-Loss Warning, /copy)

## Overview

Port 3 improvements from kimi-code to opencode-x: (1) SSRF hardening for the webfetch tool and research engine, (2) a toast warning when switching model/effort mid-session would nuke prompt cache, and (3) a `/copy` slash command to copy the last assistant message to clipboard.

## Tech Stack

- TypeScript, Bun, Effect-ts (HttpClient), Solid-based TUI
- `node:dns/promises` + `node:net` BlockList for SSRF
- Existing clipboard utilities (OSC52 + native) for /copy
- Existing toast system + command registry for UX features

## Testing Strategy

- Unit: SSRF blocklist validation (private IPs, redirect chains, DNS rebinding mock), /copy text extraction
- Integration: webfetch tool with mocked DNS resolving to private IPs returns error
- Done when: `bun --cwd packages/opencode test` passes, typecheck clean

## Phases

### Phase 1: SSRF Hardening (Security — Critical)

- Step 1: Create `src/tool/url-safety.ts` — standalone module with:
  - `PRIVATE_ADDRESS_BLOCKLIST` using `node:net` BlockList (loopback, RFC1918, link-local, CGNAT, ULA, unspecified)
  - `isBlockedAddress(address: string): boolean`
  - `resolveSafeFetchTarget(url: string, opts?: { allowPrivate?: boolean }): Promise<{ host, port, addresses? }>` — validates scheme, resolves DNS, checks all resolved IPs
  - `validateRedirectTarget(location: string, opts?): Promise<void>` — re-runs full validation on each redirect hop
- Step 2: Create custom Effect HttpClient middleware (`ssrfSafeClient`) that:
  - Intercepts requests, validates URL via `resolveSafeFetchTarget` before sending
  - Disables automatic redirects (`redirect: "manual"`)
  - Follows redirects manually with per-hop validation (max 10 hops)
  - Optional: DNS pinning via custom `lookup` in undici Agent (skip if Bun doesn't expose this)
- Step 3: Apply `ssrfSafeClient` to:
  - `src/tool/webfetch.ts` — wrap the HttpClient layer
  - `src/tool/research.ts` / `src/research/engine.ts` — same layer wrapping
- Step 4: Add config option `permissions.webfetch.allow_private_addresses: boolean` (default false) for users who legitimately need to fetch localhost (dev tools, local APIs)
- Step 5: Write tests — blocked addresses, redirect chains to private IPs, DNS resolution to loopback, scheme validation, allowPrivate bypass

### Phase 2: Cache-Loss Warning on Model/Effort Switch

- Step 1: In `src/cli/cmd/tui/context/local.tsx`, in the `model.set()` method (line 280), detect when:
  - Session has messages (not fresh)
  - Provider of current model is Anthropic (supports prompt caching)
  - New model differs from current model OR new effort/variant differs
- Step 2: Show a toast warning: "Switching model mid-session invalidates prompt cache. Cached tokens will be re-billed on next turn."
  - Variant: `"warning"`, duration: 5000
  - Only trigger when the previous model was Anthropic-cached (provider `anthropic` or has `scope` in providerOptions)
- Step 3: Same warning for effort/variant changes in the `variant.set()` path (line 350) since thinking effort changes also invalidate cache for Anthropic
- Step 4: Add config `experimental.suppress_cache_warning: boolean` to silence it for power users who know what they're doing

### Phase 3: /copy Slash Command

- Step 1: Register a new built-in command `"copy"` in `src/command/index.ts`:
  - `name: "copy"`
  - `description: "copy last assistant message to clipboard"`
  - `template: ""` (empty — no prompt to send)
  - `source: "command"`
  - Custom execution: this is a client-side action, not a prompt
- Step 2: In the TUI command dispatch (wherever slash commands are handled), intercept `/copy`:
  - Get last assistant message from session messages (filter `role === "assistant"`, last one)
  - Extract text parts only (filter `type === "text"`, join with `\n`, trim)
  - Skip if empty/no assistant messages → toast "No assistant message to copy"
  - Call `Clipboard.write(text)` (existing util in `src/cli/cmd/tui/util/clipboard.ts`)
  - Toast: "Copied to clipboard (N characters)" or "Copied via terminal escape (unverified, N characters)" for OSC52
- Step 3: Handle edge case: if session is streaming (assistant message incomplete), either:
  - Option A: Copy whatever text has accumulated so far
  - Option B: Toast "Wait for response to complete" (kimi-code chose this: idle-only)
  - Go with Option A — user typed /copy, give them what's there

## Risks/Edge cases

- **Bun DNS limitation**: Bun's `fetch` may not support custom `lookup` functions (unlike Node's undici). Fallback: validate before fetch, accept TOCTOU window. Document the DNS-rebinding limitation.
- **Performance of DNS resolution**: Each webfetch call adds a DNS lookup. Acceptable — these are rare tool calls, not hot paths.
- **Cache warning false positives**: Model switch between two non-caching providers shows no warning (correctly). Switch between two Anthropic models still shows warning (correctly — different model = different cache prefix).
- **`/copy` during streaming**: Partial text may be incomplete. Acceptable UX — user explicitly asked for it.
- **Effect HttpClient redirect control**: Need to verify Effect's `HttpClient` supports `redirect: "manual"`. If not, use raw `fetch` with manual redirect loop inside the tool.
