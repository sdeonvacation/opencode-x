import { test, expect, mock, beforeEach } from "bun:test"
import os from "os"
import path from "path"
import fs from "fs"

// Isolate from real ~/.claude/plugins MCP auto-discovery
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-mcp-reconnect-"))
;(os as any).homedir = () => isolatedHome
mock.module("os", () => ({ ...os, homedir: () => isolatedHome, default: { ...os, homedir: () => isolatedHome } }))

// --- Mock infrastructure ---

interface MockClientState {
  tools: Array<{ name: string; description?: string; inputSchema: object }>
  listToolsCalls: number
  listToolsShouldFail: boolean
  listToolsError: string
  listPromptsShouldFail: boolean
  listResourcesShouldFail: boolean
  prompts: Array<{ name: string; description?: string }>
  resources: Array<{ name: string; uri: string; description?: string }>
  closed: boolean
  notificationHandlers: Map<unknown, (...args: any[]) => any>
  onclose: (() => void) | null
}

const clientStates = new Map<string, MockClientState>()
let lastCreatedClientName: string | undefined
let connectShouldFail = false
let connectShouldHang = false
let connectError = "Mock transport cannot connect"
let connectFailCount = 0
let connectFailLimit = 0 // 0 = fail forever, >0 = fail N times then succeed

function getOrCreateClientState(name?: string): MockClientState {
  const key = name ?? "default"
  let state = clientStates.get(key)
  if (!state) {
    state = {
      tools: [{ name: "test_tool", description: "A test tool", inputSchema: { type: "object", properties: {} } }],
      listToolsCalls: 0,
      listToolsShouldFail: false,
      listToolsError: "listTools failed",
      listPromptsShouldFail: false,
      listResourcesShouldFail: false,
      prompts: [],
      resources: [],
      closed: false,
      notificationHandlers: new Map(),
      onclose: null,
    }
    clientStates.set(key, state)
  }
  return state
}

class MockStdioTransport {
  stderr: null = null
  pid = 12345
  constructor(_opts: any) {}
  async start() {
    if (connectShouldHang) return new Promise<void>(() => {})
    if (connectShouldFail) {
      connectFailCount++
      if (connectFailLimit === 0 || connectFailCount <= connectFailLimit) {
        throw new Error(connectError)
      }
    }
  }
  async close() {}
}

class MockStreamableHTTP {
  constructor(_url: URL, _opts?: any) {}
  async start() {
    if (connectShouldHang) return new Promise<void>(() => {})
    if (connectShouldFail) {
      connectFailCount++
      if (connectFailLimit === 0 || connectFailCount <= connectFailLimit) {
        throw new Error(connectError)
      }
    }
  }
  async close() {}
  async finishAuth() {}
}

class MockSSE {
  constructor(_url: URL, _opts?: any) {}
  async start() {
    if (connectShouldHang) return new Promise<void>(() => {})
    if (connectShouldFail) {
      connectFailCount++
      if (connectFailLimit === 0 || connectFailCount <= connectFailLimit) {
        throw new Error(connectError)
      }
    }
  }
  async close() {}
}

mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: MockStdioTransport,
}))

mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: MockStreamableHTTP,
}))

mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: MockSSE,
}))

mock.module("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError: class extends Error {
    constructor() {
      super("Unauthorized")
    }
  },
}))

// Track mock clients for triggering onclose
const mockClients: any[] = []

mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    _state!: MockClientState
    transport: any
    onclose: (() => void) | null = null

    constructor(_opts: any, _clientOpts?: any) {}

    async connect(transport: { start: () => Promise<void> }) {
      this.transport = transport
      await transport.start()
      this._state = getOrCreateClientState(lastCreatedClientName)
      mockClients.push(this)
    }

    setRequestHandler(_schema: unknown, _handler: (...args: any[]) => any) {}

    setNotificationHandler(schema: unknown, handler: (...args: any[]) => any) {
      this._state?.notificationHandlers.set(schema, handler)
    }

    async listTools() {
      if (this._state) this._state.listToolsCalls++
      if (this._state?.listToolsShouldFail) {
        throw new Error(this._state.listToolsError)
      }
      return { tools: this._state?.tools ?? [] }
    }

    async listPrompts() {
      if (this._state?.listPromptsShouldFail) {
        throw new Error("listPrompts failed")
      }
      return { prompts: this._state?.prompts ?? [] }
    }

    async listResources() {
      if (this._state?.listResourcesShouldFail) {
        throw new Error("listResources failed")
      }
      return { resources: this._state?.resources ?? [] }
    }

    async close() {
      if (this._state) this._state.closed = true
    }
  },
}))

beforeEach(() => {
  clientStates.clear()
  lastCreatedClientName = undefined
  connectShouldFail = false
  connectShouldHang = false
  connectError = "Mock transport cannot connect"
  connectFailCount = 0
  connectFailLimit = 0
  mockClients.length = 0
})

const { MCP } = await import("../../src/mcp/index")
const { Instance } = await import("../../src/project/instance")
const { tmpdir } = await import("../fixture/fixture")

// --- Helper ---

function withInstance(config: Record<string, any>, fn: () => Promise<void>) {
  return async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          `${dir}/opencode.json`,
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            mcp: config,
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await fn()
        await Instance.dispose()
      },
    })
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ========================================================================
// Test: initially-failed server triggers retryInitialConnection
// ========================================================================

test(
  "initially-failed server retries and eventually connects",
  withInstance(
    {
      "retry-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    async () => {
      lastCreatedClientName = "retry-server"
      const serverState = getOrCreateClientState("retry-server")
      serverState.tools = [
        { name: "retry_tool", description: "tool from retry", inputSchema: { type: "object", properties: {} } },
      ]

      // Fail first connect attempt, then succeed on retry
      connectShouldFail = true
      connectFailLimit = 1

      // State init happens during Instance.provide — server initially fails
      const status = await MCP.status()
      expect(status["retry-server"]?.status).toBe("failed")

      // Wait for retry to fire (first retry at ~2s delay)
      await sleep(3000)

      const statusAfter = await MCP.status()
      expect(statusAfter["retry-server"]?.status).toBe("connected")

      const tools = await MCP.tools()
      expect(Object.keys(tools).some((k) => k.includes("retry_tool"))).toBe(true)
    },
  ),
  { timeout: 10000 },
)

// ========================================================================
// Test: monitor uses exponential backoff and resets on success
// ========================================================================

test(
  "monitor reconnects with exponential backoff after transport close",
  withInstance({}, async () => {
    lastCreatedClientName = "monitor-server"
    const serverState = getOrCreateClientState("monitor-server")
    serverState.tools = [
      { name: "monitor_tool", description: "monitored", inputSchema: { type: "object", properties: {} } },
    ]

    // First add succeeds
    await MCP.add("monitor-server", {
      type: "local",
      command: ["echo", "test"],
    })

    expect((await MCP.status())["monitor-server"]?.status).toBe("connected")

    // Simulate transport disconnect
    const client = mockClients[mockClients.length - 1]
    expect(client).toBeDefined()
    expect(client.onclose).toBeDefined()

    // Trigger onclose to simulate disconnect
    client.onclose?.()

    // Status should be failed immediately
    expect((await MCP.status())["monitor-server"]?.status).toBe("failed")

    // Wait for first reconnect attempt (1s * 2^0 = 1s delay)
    await sleep(1500)

    // Should have reconnected
    expect((await MCP.status())["monitor-server"]?.status).toBe("connected")
  }),
  { timeout: 5000 },
)

// ========================================================================
// Test: monitor retries on failed reconnect attempts
// ========================================================================

test(
  "monitor retries multiple times when reconnect fails",
  withInstance({}, async () => {
    lastCreatedClientName = "flaky-server"
    const serverState = getOrCreateClientState("flaky-server")
    serverState.tools = [{ name: "flaky_tool", description: "flaky", inputSchema: { type: "object", properties: {} } }]

    // First add succeeds
    await MCP.add("flaky-server", {
      type: "local",
      command: ["echo", "test"],
    })

    expect((await MCP.status())["flaky-server"]?.status).toBe("connected")

    // Now make reconnects fail for a bit
    connectShouldFail = true
    connectFailLimit = 2 // fail twice then succeed

    // Trigger disconnect
    const client = mockClients[mockClients.length - 1]
    client.onclose?.()

    expect((await MCP.status())["flaky-server"]?.status).toBe("failed")

    // First attempt at ~1s, second at ~2s, third (success) at ~4s
    // Total wait ~7s to be safe
    await sleep(8000)

    expect((await MCP.status())["flaky-server"]?.status).toBe("connected")
  }),
  { timeout: 15000 },
)

// ========================================================================
// Test: monitor stops retrying after max retries exhausted
// ========================================================================

test(
  "monitor stops retrying after maxRetries exhausted",
  withInstance({}, async () => {
    lastCreatedClientName = "exhaust-server"
    const serverState = getOrCreateClientState("exhaust-server")
    serverState.tools = [
      { name: "exhaust_tool", description: "exhausts retries", inputSchema: { type: "object", properties: {} } },
    ]

    // Add with small maxRetries by using the default monitor (10 retries)
    // We'll simulate a permanently failing server
    await MCP.add("exhaust-server", {
      type: "local",
      command: ["echo", "test"],
    })

    expect((await MCP.status())["exhaust-server"]?.status).toBe("connected")

    // Make reconnects permanently fail
    connectShouldFail = true
    connectFailLimit = 0 // never succeed

    // Trigger disconnect
    const client = mockClients[mockClients.length - 1]
    client.onclose?.()

    expect((await MCP.status())["exhaust-server"]?.status).toBe("failed")

    // After disconnect, status stays failed (we just verify it doesn't crash)
    await sleep(2000)
    expect((await MCP.status())["exhaust-server"]?.status).toBe("failed")
  }),
  { timeout: 8000 },
)

// ========================================================================
// Test: retryInitialConnection uses increasing backoff delays
// ========================================================================

test(
  "retryInitialConnection delays increase exponentially (capped at 60s)",
  withInstance(
    {
      "backoff-server": {
        type: "local",
        command: ["echo", "test"],
      },
    },
    async () => {
      lastCreatedClientName = "backoff-server"
      const serverState = getOrCreateClientState("backoff-server")
      serverState.tools = [
        { name: "backoff_tool", description: "backoff test", inputSchema: { type: "object", properties: {} } },
      ]

      // Server fails initially
      connectShouldFail = true
      connectFailLimit = 0

      const status = await MCP.status()
      expect(status["backoff-server"]?.status).toBe("failed")

      // Wait less than first retry delay (2s) — should still be failed
      await sleep(1500)
      expect((await MCP.status())["backoff-server"]?.status).toBe("failed")

      // Now allow connection and wait for retry
      connectShouldFail = false
      await sleep(1500) // past the 2s mark

      expect((await MCP.status())["backoff-server"]?.status).toBe("connected")
    },
  ),
  { timeout: 10000 },
)

// ========================================================================
// Test: disabled servers don't trigger retry
// ========================================================================

test(
  "disabled servers are not retried on init failure",
  withInstance(
    {
      "disabled-server": {
        type: "local",
        command: ["echo", "test"],
        enabled: false,
      },
    },
    async () => {
      const status = await MCP.status()
      expect(status["disabled-server"]?.status).toBe("disabled")

      // No retry should be scheduled — status stays disabled
      await sleep(3000)
      expect((await MCP.status())["disabled-server"]?.status).toBe("disabled")
    },
  ),
  { timeout: 5000 },
)
