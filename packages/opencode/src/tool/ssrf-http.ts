import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { validateUrl } from "./url-safety"

const MAX_REDIRECTS = 10

export function ssrfSafeLayer(opts?: { allowPrivate?: boolean }): Layer.Layer<HttpClient.HttpClient> {
  return Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const base = yield* HttpClient.HttpClient

      return HttpClient.make((request) =>
        Effect.gen(function* () {
          let url = request.url
          let hops = 0

          // Validate initial URL — SSRF violations become defects
          yield* Effect.tryPromise({
            try: () => validateUrl(url, opts),
            catch: (err) => (err instanceof Error ? err : new Error(`SSRF validation failed: ${url}`)),
          }).pipe(Effect.orDie)

          // First request with redirect:manual header hint
          let current = request.pipe(HttpClientRequest.setUrl(url))
          let response = yield* base.execute(current.pipe(HttpClientRequest.setHeader("x-ssrf-redirect", "manual")))

          // Follow redirects manually with per-hop validation
          while (isRedirect(response.status) && hops < MAX_REDIRECTS) {
            const location = response.headers["location"]
            if (!location) break

            url = new URL(location, url).toString()

            yield* Effect.tryPromise({
              try: () => validateUrl(url, opts),
              catch: (err) => (err instanceof Error ? err : new Error(`SSRF validation failed on redirect: ${url}`)),
            }).pipe(Effect.orDie)

            hops++
            current = HttpClientRequest.get(url).pipe(
              HttpClientRequest.setHeaders(request.headers),
              HttpClientRequest.setHeader("x-ssrf-redirect", "manual"),
            )
            response = yield* base.execute(current)
          }

          if (hops >= MAX_REDIRECTS) {
            return yield* Effect.die(new Error(`Too many redirects (${MAX_REDIRECTS})`))
          }

          return response
        }),
      )
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer))
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}
