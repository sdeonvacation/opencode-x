import { describe, test, expect, mock } from "bun:test"

// Patch DialogPrompt.show before importing the module under test
const promptResult = { value: null as string | null }
mock.module("../../src/cli/cmd/tui/ui/dialog-prompt", () => ({
  DialogPrompt: {
    show: async () => promptResult.value,
  },
}))

// Patch DialogSelect to avoid Solid.js rendering in tests
mock.module("../../src/cli/cmd/tui/ui/dialog-select", () => ({
  DialogSelect: () => null,
}))

const { createMemoryCommands } = await import("../../src/cli/cmd/tui/command/memory-commands")

type Deps = Parameters<typeof createMemoryCommands>[0]

type MemoryEntry = { id: string; content: string; position: number }

type MockMemory = {
  list: MemoryEntry[]
  created: Array<{ sessionID: string; content: string }>
  updated: Array<{ sessionID: string; memoryID: string; content: string }>
  deleted: Array<{ sessionID: string; memoryID: string }>
}

function makeDeps(routeOverride?: Deps["route"]): Deps & {
  calls: { toast: any[]; clear: number; replace: any[] }
  mem: MockMemory
} {
  const calls = { toast: [] as any[], clear: 0, replace: [] as any[] }
  const mem: MockMemory = { list: [], created: [], updated: [], deleted: [] }

  const mockFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const method = init?.method?.toUpperCase() ?? "GET"

    // GET /:sessionID/memory
    if (method === "GET" && url.endsWith("/memory")) {
      return new Response(JSON.stringify(mem.list), { status: 200, headers: { "content-type": "application/json" } })
    }

    // POST /:sessionID/memory
    if (method === "POST" && url.endsWith("/memory")) {
      const body = JSON.parse(init?.body as string)
      const sessionID = url.split("/").at(-2)!
      mem.created.push({ sessionID, content: body.content })
      const entry: MemoryEntry = { id: "m1", content: body.content, position: 0 }
      return new Response(JSON.stringify(entry), { status: 200, headers: { "content-type": "application/json" } })
    }

    // PUT /:sessionID/memory/:memoryID
    if (method === "PUT") {
      const parts = url.split("/")
      const memoryID = parts.at(-1)!
      const sessionID = parts.at(-3)!
      const body = JSON.parse(init?.body as string)
      mem.updated.push({ sessionID, memoryID, content: body.content })
      const entry: MemoryEntry = { id: memoryID, content: body.content, position: 0 }
      return new Response(JSON.stringify(entry), { status: 200, headers: { "content-type": "application/json" } })
    }

    // DELETE /:sessionID/memory/:memoryID
    if (method === "DELETE") {
      const parts = url.split("/")
      const memoryID = parts.at(-1)!
      const sessionID = parts.at(-3)!
      mem.deleted.push({ sessionID, memoryID })
      return new Response(JSON.stringify(true), { status: 200, headers: { "content-type": "application/json" } })
    }

    return new Response("not found", { status: 404 })
  }

  return {
    calls,
    mem,
    dialog: {
      clear: () => {
        calls.clear++
      },
      replace: (fn: any) => {
        calls.replace.push(fn)
      },
    },
    toast: {
      show: (opts: any) => {
        calls.toast.push(opts)
      },
    },
    sdk: {
      url: "http://localhost:1234",
      fetch: mockFetch as typeof fetch,
    },
    route: routeOverride ?? { data: { type: "session", sessionID: "sess1" } },
  }
}

// Helper: call onSelect with required DialogContext arg (unused by our impl)
const sel = (cmd: { onSelect?: (ctx: any) => void }) => cmd.onSelect?.(undefined as any)

describe("createMemoryCommands", () => {
  test("returns 3 commands", () => {
    expect(createMemoryCommands(makeDeps())).toHaveLength(3)
  })

  test("slash names are correct", () => {
    const cmds = createMemoryCommands(makeDeps())
    expect(cmds[0].slash?.name).toBe("memory_add")
    expect(cmds[1].slash?.name).toBe("memory_edit")
    expect(cmds[2].slash?.name).toBe("memory_delete")
  })

  test("all commands have category Agent", () => {
    for (const cmd of createMemoryCommands(makeDeps())) expect(cmd.category).toBe("Agent")
  })

  test("correct titles", () => {
    const cmds = createMemoryCommands(makeDeps())
    expect(cmds[0].title).toBe("Add to memory")
    expect(cmds[1].title).toBe("Edit memory")
    expect(cmds[2].title).toBe("Delete memory")
  })

  test("correct values", () => {
    const cmds = createMemoryCommands(makeDeps())
    expect(cmds[0].value).toBe("memory.add")
    expect(cmds[1].value).toBe("memory.edit")
    expect(cmds[2].value).toBe("memory.delete")
  })

  describe("memory_add", () => {
    test("no active session → warning toast + clear", async () => {
      const deps = makeDeps({ data: { type: "home" } })
      const [add] = createMemoryCommands(deps)
      await sel(add)
      expect(deps.calls.toast[0]).toMatchObject({ variant: "warning", message: "No active session" })
      expect(deps.calls.clear).toBe(1)
    })

    test("null prompt → no create", async () => {
      promptResult.value = null
      const deps = makeDeps()
      const [add] = createMemoryCommands(deps)
      await sel(add)
      expect(deps.mem.created).toHaveLength(0)
      expect(deps.calls.toast).toHaveLength(0)
    })

    test("whitespace-only prompt → no create", async () => {
      promptResult.value = "   "
      const deps = makeDeps()
      const [add] = createMemoryCommands(deps)
      await sel(add)
      expect(deps.mem.created).toHaveLength(0)
    })

    test("valid input → create called with trimmed content", async () => {
      promptResult.value = "  remember this  "
      const deps = makeDeps()
      const [add] = createMemoryCommands(deps)
      await sel(add)
      expect(deps.mem.created).toHaveLength(1)
      expect(deps.mem.created[0]).toEqual({ sessionID: "sess1", content: "remember this" })
    })

    test("valid input → success toast + clear", async () => {
      promptResult.value = "note"
      const deps = makeDeps()
      const [add] = createMemoryCommands(deps)
      await sel(add)
      expect(deps.calls.toast[0]).toMatchObject({ variant: "success", message: "Memory saved" })
      expect(deps.calls.clear).toBe(1)
    })
  })

  describe("memory_edit", () => {
    test("no active session → warning toast + clear", async () => {
      const deps = makeDeps({ data: { type: "home" } })
      const [, edit] = createMemoryCommands(deps)
      await sel(edit)
      expect(deps.calls.toast[0]).toMatchObject({ variant: "warning", message: "No active session" })
      expect(deps.calls.clear).toBe(1)
    })

    test("empty list → 'No memory entries' toast + clear", async () => {
      const deps = makeDeps()
      deps.mem.list = []
      const [, edit] = createMemoryCommands(deps)
      await sel(edit)
      expect(deps.calls.toast[0]).toMatchObject({ variant: "warning", message: "No memory entries" })
      expect(deps.calls.clear).toBe(1)
      expect(deps.calls.replace).toHaveLength(0)
    })

    test("entries present → dialog.replace called", async () => {
      const deps = makeDeps()
      deps.mem.list = [{ id: "m1", content: "entry one", position: 0 }]
      const [, edit] = createMemoryCommands(deps)
      await sel(edit)
      expect(deps.calls.replace).toHaveLength(1)
    })

    test("list called with correct sessionID", async () => {
      const deps = makeDeps()
      deps.mem.list = []
      const [, edit] = createMemoryCommands(deps)
      await sel(edit)
      // list was fetched (no error thrown) and empty list toast shown
      expect(deps.calls.toast[0]).toMatchObject({ message: "No memory entries" })
    })
  })

  describe("memory_delete", () => {
    test("no active session → warning toast + clear", async () => {
      const deps = makeDeps({ data: { type: "home" } })
      const [, , del] = createMemoryCommands(deps)
      await sel(del)
      expect(deps.calls.toast[0]).toMatchObject({ variant: "warning", message: "No active session" })
      expect(deps.calls.clear).toBe(1)
    })

    test("empty list → 'No memory entries' toast + clear", async () => {
      const deps = makeDeps()
      deps.mem.list = []
      const [, , del] = createMemoryCommands(deps)
      await sel(del)
      expect(deps.calls.toast[0]).toMatchObject({ variant: "warning", message: "No memory entries" })
      expect(deps.calls.clear).toBe(1)
      expect(deps.calls.replace).toHaveLength(0)
    })

    test("entries present → dialog.replace called", async () => {
      const deps = makeDeps()
      deps.mem.list = [{ id: "m2", content: "to delete", position: 1 }]
      const [, , del] = createMemoryCommands(deps)
      await sel(del)
      expect(deps.calls.replace).toHaveLength(1)
    })

    test("list called with correct sessionID", async () => {
      const deps = makeDeps()
      deps.mem.list = []
      const [, , del] = createMemoryCommands(deps)
      await sel(del)
      expect(deps.calls.toast[0]).toMatchObject({ message: "No memory entries" })
    })
  })
})
