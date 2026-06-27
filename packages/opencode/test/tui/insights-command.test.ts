import { describe, test, expect } from "bun:test"
import { createInsightsCommand, type InsightsCommandDeps } from "../../src/cli/cmd/tui/command/insights-command"

function makeDeps(fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>): InsightsCommandDeps & {
  calls: { toast: any[]; clear: number }
} {
  const calls = { toast: [] as any[], clear: 0 }

  const defaultFetch = async (_url: string, _init?: RequestInit): Promise<Response> => {
    return new Response(
      JSON.stringify({ reportPath: "/tmp/insights.md", sessionCount: 5, analyzedCount: 4, totalCost: 1.23 }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  }

  return {
    sdk: {
      url: "http://localhost:1234",
      fetch: (fetchImpl ?? defaultFetch) as typeof fetch,
    },
    toast: {
      show: (opts: any) => calls.toast.push(opts),
    },
    dialog: {
      clear: () => {
        calls.clear++
      },
      replace: () => {},
    },
    calls,
  }
}

describe("createInsightsCommand", () => {
  test("returns correct command metadata", () => {
    const deps = makeDeps()
    const cmd = createInsightsCommand(deps)
    expect(cmd.title).toBe("View insights in a browser, default: 7 days")
    expect(cmd.value).toBe("insights.generate")
    expect(cmd.slash).toEqual({ name: "insights" })
    expect(cmd.category).toBe("Tools")
    expect(cmd.onSelect).toBeDefined()
  })

  test("onSelect clears dialog and shows progress toast", async () => {
    const deps = makeDeps()
    const cmd = createInsightsCommand(deps)
    await cmd.onSelect!({} as any)
    expect(deps.calls.clear).toBe(1)
    expect(deps.calls.toast[0]).toEqual({ variant: "info", message: "Generating insights report...", duration: 0 })
  })

  test("onSelect shows success toast on successful response", async () => {
    const deps = makeDeps()
    const cmd = createInsightsCommand(deps)
    await cmd.onSelect!({} as any)
    const successToast = deps.calls.toast[1]
    expect(successToast.variant).toBe("success")
    expect(successToast.message).toContain("5 sessions")
    expect(successToast.message).toContain("$1.23")
  })

  test("onSelect calls correct endpoint with POST", async () => {
    let captured: { url: string; method?: string; body?: string } | undefined
    const deps = makeDeps(async (url, init) => {
      captured = { url, method: init?.method, body: init?.body as string }
      return new Response(
        JSON.stringify({ reportPath: "/tmp/r.md", sessionCount: 2, analyzedCount: 2, totalCost: 0.5 }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    })
    const cmd = createInsightsCommand(deps)
    await cmd.onSelect!({} as any)
    expect(captured!.url).toBe("http://localhost:1234/insights")
    expect(captured!.method).toBe("POST")
    expect(JSON.parse(captured!.body!)).toEqual({})
  })

  test("onSelect shows error toast on HTTP failure", async () => {
    const deps = makeDeps(async () => new Response("Server error", { status: 500 }))
    const cmd = createInsightsCommand(deps)
    await cmd.onSelect!({} as any)
    const errorToast = deps.calls.toast[1]
    expect(errorToast.variant).toBe("error")
    expect(errorToast.message).toContain("Server error")
  })

  test("onSelect shows error toast on network failure", async () => {
    const deps = makeDeps(async () => {
      throw new Error("Network timeout")
    })
    const cmd = createInsightsCommand(deps)
    await cmd.onSelect!({} as any)
    const errorToast = deps.calls.toast[1]
    expect(errorToast.variant).toBe("error")
    expect(errorToast.message).toBe("Network timeout")
  })

  test("onSelect shows generic message when error has no message", async () => {
    const deps = makeDeps(async () => {
      throw {}
    })
    const cmd = createInsightsCommand(deps)
    await cmd.onSelect!({} as any)
    const errorToast = deps.calls.toast[1]
    expect(errorToast.variant).toBe("error")
    expect(errorToast.message).toBe("Insights generation failed")
  })
})
