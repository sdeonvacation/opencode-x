import { BlockList, isIP } from "node:net"
import { lookup } from "node:dns/promises"

const blocked = new BlockList()
// IPv4 private/reserved ranges
blocked.addSubnet("127.0.0.0", 8, "ipv4")
blocked.addSubnet("10.0.0.0", 8, "ipv4")
blocked.addSubnet("172.16.0.0", 12, "ipv4")
blocked.addSubnet("192.168.0.0", 16, "ipv4")
blocked.addSubnet("169.254.0.0", 16, "ipv4")
blocked.addSubnet("100.64.0.0", 10, "ipv4")
blocked.addSubnet("0.0.0.0", 8, "ipv4")
// IPv6 private/reserved ranges
blocked.addSubnet("::1", 128, "ipv6")
blocked.addSubnet("fe80::", 10, "ipv6")
blocked.addSubnet("fc00::", 7, "ipv6")
blocked.addSubnet("::", 128, "ipv6")

export function isBlockedAddress(address: string): boolean {
  const kind = isIP(address)
  if (kind === 0) return false
  return blocked.check(address, kind === 4 ? "ipv4" : "ipv6")
}

export async function validateUrl(
  url: string,
  opts?: { allowPrivate?: boolean },
): Promise<{ hostname: string; port: number; addresses: string[] }> {
  const parsed = (() => {
    try {
      return new URL(url)
    } catch {
      throw new Error(`Invalid URL: ${url}`)
    }
  })()

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Blocked protocol: ${parsed.protocol}`)
  }

  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80
  const hostname = parsed.hostname

  if (opts?.allowPrivate) return { hostname, port, addresses: [] }

  // If hostname is already an IP, check directly
  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) throw new Error(`Blocked address: ${hostname}`)
    return { hostname, port, addresses: [hostname] }
  }

  // Resolve DNS and check all addresses
  const results = await (async () => {
    try {
      return await lookup(hostname, { all: true })
    } catch {
      throw new Error(`DNS resolution failed: ${hostname}`)
    }
  })()

  const addresses = results.map((r) => r.address)
  const blockedAddr = addresses.find(isBlockedAddress)
  if (blockedAddr) throw new Error(`Blocked address: ${blockedAddr} (resolved from ${hostname})`)

  return { hostname, port, addresses }
}
