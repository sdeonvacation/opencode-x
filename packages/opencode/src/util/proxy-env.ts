// Minimal proxy environment helper for WebSocket connections.

export namespace ProxyEnv {
  export function getProxyForUrl(url: string): string | undefined {
    const parsed = new URL(url)
    const protocol = parsed.protocol

    if (protocol === "https:" || protocol === "wss:") {
      return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
    }
    return process.env.HTTP_PROXY || process.env.http_proxy
  }
}
