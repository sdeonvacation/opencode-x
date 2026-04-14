/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { Event, GlobalEvent } from "@opencode-ai/sdk/v2"
import { onMount } from "solid-js"
import { ArgsProvider } from "../../../src/cli/cmd/tui/context/args"
import { ExitProvider } from "../../../src/cli/cmd/tui/context/exit"
import { ProjectProvider, useProject } from "../../../src/cli/cmd/tui/context/project"
import { SDKProvider } from "../../../src/cli/cmd/tui/context/sdk"
import { SyncProvider, useSync } from "../../../src/cli/cmd/tui/context/sync"

type Complete = {
  type: "orchestration.complete"
  properties: {
    sessionID: string
    parentSessionID: string
    agent: string
    durationMs: number
  }
}

const sighup = new Set(process.listeners("SIGHUP"))

afterEach(() => {
  for (const fn of process.listeners("SIGHUP")) {
    if (!sighup.has(fn)) process.off("SIGHUP", fn)
  }
})

function json(data: unknown) {
  return new Response(JSON.stringify(data), {
    headers: {
      "content-type": "application/json",
    },
  })
}

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function data(workspace?: string | null) {
  const tag = workspace ?? "root"
  return {
    session: {
      id: "ses_1",
      title: `session-${tag}`,
      workspaceID: workspace ?? undefined,
      time: {
        updated: 1,
      },
    },
    message: {
      info: {
        id: "msg_1",
        sessionID: "ses_1",
        role: "assistant",
        time: {
          created: 1,
          completed: 1,
        },
      },
      parts: [
        {
          id: "part_1",
          messageID: "msg_1",
          sessionID: "ses_1",
          type: "text",
          text: `part-${tag}`,
        },
      ],
    },
    todo: [
      {
        id: `todo-${tag}`,
        content: `todo-${tag}`,
        status: "pending",
        priority: "medium",
      },
    ],
    diff: [
      {
        file: `${tag}.ts`,
        patch: "",
        additions: 0,
        deletions: 0,
      },
    ],
  }
}

function evt(payload: Event | Complete, input: { directory: string; workspace?: string }): GlobalEvent {
  return {
    directory: input.directory,
    workspace: input.workspace,
    payload: payload as Event,
  }
}

function complete(sessionID: string, parentSessionID: string): Complete {
  return {
    type: "orchestration.complete",
    properties: {
      sessionID,
      parentSessionID,
      agent: "coder",
      durationMs: 1,
    },
  }
}

function tree(workspace?: string | null) {
  const tag = workspace ?? "root"
  return {
    ses_1: {
      session: {
        id: "ses_1",
        title: `session-${tag}`,
        workspaceID: workspace ?? undefined,
        time: { updated: 1 },
      },
      message: {
        info: {
          id: `msg_1_${tag}`,
          sessionID: "ses_1",
          role: "assistant",
          time: { created: 1, completed: 1 },
        },
        parts: [
          { id: `part_1_${tag}`, messageID: `msg_1_${tag}`, sessionID: "ses_1", type: "text", text: `part-${tag}` },
        ],
      },
      todo: [{ id: `todo_1_${tag}`, content: `todo-1-${tag}`, status: "pending", priority: "medium" }],
      diff: [{ file: `${tag}-1.ts`, patch: "", additions: 0, deletions: 0 }],
      children: ["ses_2"],
    },
    ses_2: {
      session: {
        id: "ses_2",
        title: `child-${tag}`,
        parentID: "ses_1",
        workspaceID: workspace ?? undefined,
        time: { updated: 2 },
      },
      message: {
        info: {
          id: `msg_2_${tag}`,
          sessionID: "ses_2",
          role: "assistant",
          time: { created: 2, completed: 2 },
        },
        parts: [
          {
            id: `part_2_${tag}`,
            messageID: `msg_2_${tag}`,
            sessionID: "ses_2",
            type: "patch",
            files: [`child-${tag}.ts`],
          },
        ],
      },
      todo: [{ id: `todo_2_${tag}`, content: `todo-2-${tag}`, status: "pending", priority: "medium" }],
      diff: [{ file: `${tag}-2.ts`, patch: "", additions: 0, deletions: 0 }],
      children: ["ses_3"],
    },
    ses_3: {
      session: {
        id: "ses_3",
        title: `grandchild-${tag}`,
        parentID: "ses_2",
        workspaceID: workspace ?? undefined,
        time: { updated: 3 },
      },
      message: {
        info: {
          id: `msg_3_${tag}`,
          sessionID: "ses_3",
          role: "assistant",
          time: { created: 3, completed: 3 },
        },
        parts: [
          {
            id: `part_3_${tag}`,
            messageID: `msg_3_${tag}`,
            sessionID: "ses_3",
            type: "patch",
            files: [`grandchild-${tag}.ts`],
          },
        ],
      },
      todo: [{ id: `todo_3_${tag}`, content: `todo-3-${tag}`, status: "pending", priority: "medium" }],
      diff: [{ file: `${tag}-3.ts`, patch: "", additions: 0, deletions: 0 }],
      children: [],
    },
  }
}

type Hit = {
  path: string
  workspace?: string
}

function createFetch(
  log: Hit[],
  input?: {
    data?: typeof data
    tree?: typeof tree
  },
) {
  return Object.assign(
    async (reqinput: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(reqinput, init)
      const url = new URL(req.url)
      const workspace = url.searchParams.get("workspace") ?? req.headers.get("x-opencode-workspace") ?? undefined
      const root = input?.data?.(workspace) ?? data(workspace)
      const map = input?.tree?.(workspace) ?? tree(workspace)
      log.push({
        path: url.pathname,
        workspace,
      })

      if (url.pathname === "/config/providers") {
        return json({ providers: [], default: {} })
      }
      if (url.pathname === "/provider") {
        return json({ all: [], default: {}, connected: [] })
      }
      if (url.pathname === "/experimental/console") {
        return json({})
      }
      if (url.pathname === "/agent") {
        return json([])
      }
      if (url.pathname === "/config") {
        return json({})
      }
      if (url.pathname === "/project/current") {
        return json({ id: `proj-${workspace ?? "root"}` })
      }
      if (url.pathname === "/path") {
        return json({
          state: `/tmp/${workspace ?? "root"}/state`,
          config: `/tmp/${workspace ?? "root"}/config`,
          worktree: "/tmp/worktree",
          directory: `/tmp/${workspace ?? "root"}`,
        })
      }
      if (url.pathname === "/session") {
        return json([])
      }
      if (url.pathname === "/command") {
        return json([])
      }
      if (url.pathname === "/lsp") {
        return json([])
      }
      if (url.pathname === "/mcp") {
        return json({})
      }
      if (url.pathname === "/experimental/resource") {
        return json({})
      }
      if (url.pathname === "/formatter") {
        return json([])
      }
      if (url.pathname === "/session/status") {
        return json({})
      }
      if (url.pathname === "/provider/auth") {
        return json({})
      }
      if (url.pathname === "/vcs") {
        return json({ branch: "main" })
      }
      if (url.pathname === "/experimental/workspace") {
        return json([{ id: "ws_a" }, { id: "ws_b" }])
      }
      if (url.pathname === "/session/ses_1") {
        return json(root.session)
      }
      if (url.pathname === "/session/ses_2") {
        return json(map.ses_2.session)
      }
      if (url.pathname === "/session/ses_3") {
        return json(map.ses_3.session)
      }
      if (url.pathname === "/session/ses_1/message") {
        return json([root.message])
      }
      if (url.pathname === "/session/ses_2/message") {
        return json([map.ses_2.message])
      }
      if (url.pathname === "/session/ses_3/message") {
        return json([map.ses_3.message])
      }
      if (url.pathname === "/session/ses_1/todo") {
        return json(root.todo)
      }
      if (url.pathname === "/session/ses_2/todo") {
        return json(map.ses_2.todo)
      }
      if (url.pathname === "/session/ses_3/todo") {
        return json(map.ses_3.todo)
      }
      if (url.pathname === "/session/ses_1/diff") {
        return json(root.diff)
      }
      if (url.pathname === "/session/ses_2/diff") {
        return json(map.ses_2.diff)
      }
      if (url.pathname === "/session/ses_3/diff") {
        return json(map.ses_3.diff)
      }
      if (url.pathname === "/session/ses_1/children") {
        return json(map.ses_1.children.map((id) => map[id as keyof ReturnType<typeof tree>].session))
      }
      if (url.pathname === "/session/ses_2/children") {
        return json(map.ses_2.children.map((id) => map[id as keyof ReturnType<typeof tree>].session))
      }
      if (url.pathname === "/session/ses_3/children") {
        return json([])
      }

      throw new Error(`unexpected request: ${req.method} ${url.pathname}`)
    },
    { preconnect: fetch.preconnect.bind(fetch) },
  ) satisfies typeof fetch
}

function createSource() {
  let fn: ((event: GlobalEvent) => void) | undefined

  return {
    source: {
      subscribe: async (_directory: string | undefined, handler: (event: GlobalEvent) => void) => {
        fn = handler
        return () => {
          if (fn === handler) fn = undefined
        }
      },
    },
    emit(event: GlobalEvent) {
      if (!fn) throw new Error("event source not ready")
      fn(event)
    },
  }
}

async function mount(
  log: Hit[],
  input?: {
    fetch?: typeof fetch
    events?: {
      subscribe: (directory: string | undefined, handler: (event: GlobalEvent) => void) => Promise<() => void>
    }
  },
) {
  let project!: ReturnType<typeof useProject>
  let sync!: ReturnType<typeof useSync>
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  const app = await testRender(() => (
    <SDKProvider
      url="http://test"
      directory="/tmp/root"
      fetch={input?.fetch ?? createFetch(log)}
      events={input?.events ?? { subscribe: async () => () => {} }}
    >
      <ArgsProvider continue={false}>
        <ExitProvider>
          <ProjectProvider>
            <SyncProvider>
              <Probe
                onReady={(ctx) => {
                  project = ctx.project
                  sync = ctx.sync
                  done()
                }}
              />
            </SyncProvider>
          </ProjectProvider>
        </ExitProvider>
      </ArgsProvider>
    </SDKProvider>
  ))

  await ready
  return { app, project, sync }
}

async function waitBoot(log: Hit[], workspace?: string) {
  await wait(() => log.some((item) => item.path === "/experimental/workspace"))
  if (!workspace) return
  await wait(() => log.some((item) => item.path === "/project/current" && item.workspace === workspace))
}

function Probe(props: {
  onReady: (ctx: { project: ReturnType<typeof useProject>; sync: ReturnType<typeof useSync> }) => void
}) {
  const project = useProject()
  const sync = useSync()

  onMount(() => {
    props.onReady({ project, sync })
  })

  return <box />
}

describe("SyncProvider", () => {
  test("re-runs bootstrap requests when the active workspace changes", async () => {
    const log: Hit[] = []
    const { app, project } = await mount(log)

    try {
      await waitBoot(log)
      log.length = 0

      project.workspace.set("ws_a")

      await waitBoot(log, "ws_a")

      expect(log.some((item) => item.path === "/path" && item.workspace === "ws_a")).toBe(true)
      expect(log.some((item) => item.path === "/config" && item.workspace === "ws_a")).toBe(true)
      expect(log.some((item) => item.path === "/command" && item.workspace === "ws_a")).toBe(true)
    } finally {
      app.renderer.destroy()
    }
  })

  test("clears full-sync cache when the active workspace changes", async () => {
    const log: Hit[] = []
    const { app, project, sync } = await mount(log)

    try {
      await waitBoot(log)

      log.length = 0
      project.workspace.set("ws_a")
      await waitBoot(log, "ws_a")
      expect(project.workspace.current()).toBe("ws_a")

      log.length = 0
      await sync.session.sync("ses_1")

      expect(log.filter((item) => item.path === "/session/ses_1" && item.workspace === "ws_a")).toHaveLength(1)
      expect(sync.data.todo.ses_1[0]?.content).toBe("todo-ws_a")
      expect(sync.data.message.ses_1[0]?.id).toBe("msg_1")
      expect(sync.data.part.msg_1[0]).toMatchObject({ type: "text", text: "part-ws_a" })
      expect(sync.data.session_diff.ses_1[0]?.file).toBe("ws_a.ts")

      log.length = 0
      project.workspace.set("ws_b")
      await waitBoot(log, "ws_b")
      expect(project.workspace.current()).toBe("ws_b")

      log.length = 0
      await sync.session.sync("ses_1")
      await wait(() => log.some((item) => item.path === "/session/ses_1" && item.workspace === "ws_b"))

      expect(log.filter((item) => item.path === "/session/ses_1" && item.workspace === "ws_b")).toHaveLength(1)
      expect(sync.data.todo.ses_1[0]?.content).toBe("todo-ws_b")
      expect(sync.data.message.ses_1[0]?.id).toBe("msg_1")
      expect(sync.data.part.msg_1[0]).toMatchObject({ type: "text", text: "part-ws_b" })
      expect(sync.data.session_diff.ses_1[0]?.file).toBe("ws_b.ts")
    } finally {
      app.renderer.destroy()
    }
  })

  test("syncs descendant sessions with the root session", async () => {
    const log: Hit[] = []
    const { app, sync } = await mount(log)

    try {
      await waitBoot(log)

      log.length = 0
      await sync.session.sync("ses_1")

      expect(sync.data.message.ses_2?.[0]?.id).toBe("msg_2_root")
      expect(sync.data.message.ses_3?.[0]?.id).toBe("msg_3_root")
      expect(sync.data.part.msg_2_root?.[0]).toEqual(
        expect.objectContaining({ type: "patch", files: ["child-root.ts"] }),
      )
      expect(sync.data.part.msg_3_root?.[0]).toEqual(
        expect.objectContaining({ type: "patch", files: ["grandchild-root.ts"] }),
      )
      expect(sync.data.session.find((item) => item.id === "ses_2")?.parentID).toBe("ses_1")
      expect(sync.data.session.find((item) => item.id === "ses_3")?.parentID).toBe("ses_2")
      expect(log.filter((item) => item.path === "/session/ses_1/children")).toHaveLength(1)
      expect(log.filter((item) => item.path === "/session/ses_2/children")).toHaveLength(1)
    } finally {
      app.renderer.destroy()
    }
  })

  test("force-syncs parent tree on orchestration completion", async () => {
    const log: Hit[] = []
    const source = createSource()
    const live = tree()
    live.ses_2.message.parts = [
      { id: "part_2_root", messageID: "msg_2_root", sessionID: "ses_2", type: "patch", files: ["working.txt"] },
    ]
    const { app, sync } = await mount(log, {
      fetch: createFetch(log, { tree: () => live }),
      events: source.source,
    })

    try {
      await waitBoot(log)

      log.length = 0
      await sync.session.sync("ses_1")
      expect(sync.data.part.msg_2_root?.[0]).toEqual(expect.objectContaining({ type: "patch", files: ["working.txt"] }))

      live.ses_2.message.parts = [
        { id: "part_2_root", messageID: "msg_2_root", sessionID: "ses_2", type: "patch", files: ["dummy.txt"] },
      ]
      log.length = 0
      source.emit(evt(complete("ses_2", "ses_1"), { directory: "/tmp/root" }))

      await wait(
        () =>
          sync.data.part.msg_2_root?.[0]?.type === "patch" &&
          sync.data.part.msg_2_root?.[0]?.files?.[0] === "dummy.txt",
      )

      expect(sync.data.part.msg_2_root?.[0]).toEqual(expect.objectContaining({ type: "patch", files: ["dummy.txt"] }))
      expect(log.filter((item) => item.path === "/session/ses_1")).toHaveLength(1)
      expect(log.filter((item) => item.path === "/session/ses_2/message")).toHaveLength(1)
    } finally {
      app.renderer.destroy()
    }
  })
})
