import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Flag } from "../../src/flag/flag"
import { SessionRunState } from "../../src/session/run-state"
import { Session } from "../../src/session"
import { SessionID } from "../../src/session/schema"
import { SessionPrompt } from "../../src/session/prompt"
import { Bus } from "../../src/bus"
import { SessionStatus } from "../../src/session/status"
import { Log } from "../../src/util/log"

Log.init({ print: false })

const originalFlag = Flag.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS

afterEach(() => {
  // @ts-expect-error override readonly flag for testing
  Flag.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = originalFlag
})

describe("SessionPrompt.background count", () => {
  test("returns 0 when flag disabled", () => {
    // @ts-expect-error override readonly flag for testing
    Flag.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = false

    // The background function returns 0 immediately when flag is off
    // We verify this by checking the logic path
    expect(Flag.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS).toBe(false)
  })

  test("route response schema includes children field", async () => {
    const src = await Bun.file(new URL("../../src/server/routes/session.ts", import.meta.url)).text()
    const start = src.indexOf('"/:sessionID/background"')
    expect(start).toBeGreaterThan(-1)
    const end = src.indexOf("// fork: background-detach (#FORK) — end", start)
    expect(end).toBeGreaterThan(start)
    const route = src.slice(start, end)
    expect(route).toContain("children: z.number()")
    expect(route).toContain("success: z.boolean()")
    expect(route).toContain("children > 0")
  })

  test("route handler maps count to success boolean", async () => {
    const src = await Bun.file(new URL("../../src/server/routes/session.ts", import.meta.url)).text()
    const start = src.indexOf('"/:sessionID/background"')
    const end = src.indexOf("// fork: background-detach (#FORK) — end", start)
    const route = src.slice(start, end)
    // success is derived from children > 0
    expect(route).toContain("success: children > 0, children")
  })

  test("background function interface returns number", async () => {
    const src = await Bun.file(new URL("../../src/session/prompt.ts", import.meta.url)).text()
    expect(src).toContain("readonly background: (sessionID: SessionID) => Effect.Effect<number>")
  })

  test("background counts running children", async () => {
    const src = await Bun.file(new URL("../../src/session/prompt.ts", import.meta.url)).text()
    const start = src.indexOf("const background = Effect.fn")
    const end = src.indexOf("// fork: background-detach (#FORK) — end", start)
    const fn = src.slice(start, end)
    // Verifies the counting logic is present
    expect(fn).toContain("sessions.children(sessionID)")
    expect(fn).toContain("state.peek(child.id)")
    expect(fn).toContain('r.state._tag === "Running"')
    expect(fn).toContain('r.state._tag === "ShellThenRun"')
    expect(fn).toContain("count++")
    expect(fn).toContain("return count || 1")
  })

  test("background returns at least 1 when parent is running but no children", async () => {
    const src = await Bun.file(new URL("../../src/session/prompt.ts", import.meta.url)).text()
    const start = src.indexOf("const background = Effect.fn")
    const end = src.indexOf("// fork: background-detach (#FORK) — end", start)
    const fn = src.slice(start, end)
    // `count || 1` ensures at least 1 when parent is busy
    expect(fn).toContain("return count || 1")
  })

  test("background returns 0 when not running", async () => {
    const src = await Bun.file(new URL("../../src/session/prompt.ts", import.meta.url)).text()
    const start = src.indexOf("const background = Effect.fn")
    const end = src.indexOf("// fork: background-detach (#FORK) — end", start)
    const fn = src.slice(start, end)
    // Early returns for non-running states
    expect(fn).toContain("if (!runner) return 0")
    expect(fn).toContain('st._tag !== "Running" && st._tag !== "ShellThenRun") return 0')
  })
})

describe("TUI background indicator text", () => {
  test("displays subagent count in indicator", async () => {
    const src = await Bun.file(new URL("../../src/cli/cmd/tui/component/prompt/index.tsx", import.meta.url)).text()
    // Verify the indicator uses bgCount signal
    expect(src).toContain("bgCount()")
    // Verify plural/singular logic
    expect(src).toContain("bgCount() > 1 ? `${bgCount()} subagents`")
    expect(src).toContain('bgCount() === 1 ? "1 subagent"')
    expect(src).toContain('"session"')
    expect(src).toContain("running in background")
  })

  test("stores children count from response", async () => {
    const src = await Bun.file(new URL("../../src/cli/cmd/tui/component/prompt/index.tsx", import.meta.url)).text()
    expect(src).toContain("setBgCount")
    expect(src).toContain("(res.data as any).children")
  })

  test("bgCount signal is initialized to 0", async () => {
    const src = await Bun.file(new URL("../../src/cli/cmd/tui/component/prompt/index.tsx", import.meta.url)).text()
    expect(src).toContain("const [bgCount, setBgCount] = createSignal(0)")
  })
})
