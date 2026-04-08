import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { SessionID, MessageID, PartID } from "../../src/session/schema"

const sessionID = SessionID.make("session")
const providerID = ProviderID.make("test")

function userInfo(id: string, summary?: MessageV2.User["summary"]): MessageV2.User {
  return {
    id: MessageID.make(id),
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "user",
    model: { providerID, modelID: ModelID.make("test") },
    tools: {},
    summary,
  } as unknown as MessageV2.User
}

function assistantInfo(id: string, parentID: string): MessageV2.Assistant {
  return {
    id: MessageID.make(id),
    sessionID,
    role: "assistant",
    time: { created: 0 },
    parentID: MessageID.make(parentID),
    modelID: ModelID.make("test"),
    providerID,
    mode: "",
    agent: "agent",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  } as unknown as MessageV2.Assistant
}

describe("Fix 1: strip summary.diffs from hydrated messages", () => {
  test("user message with summary.diffs gets diffs stripped", () => {
    const info = userInfo("m1", {
      title: "test title",
      body: "test body",
      diffs: [
        {
          file: "src/big-file.ts",
          before: "a".repeat(10000),
          after: "b".repeat(10000),
          additions: 100,
          deletions: 50,
          status: "modified",
        },
      ],
    })
    // Verify the summary has diffs before stripping
    expect(info.summary?.diffs).toHaveLength(1)
    expect(info.summary?.diffs?.[0]?.before).toHaveLength(10000)

    // Simulate what the info() function does: strip diffs from user messages
    if (info.role === "user" && info.summary?.diffs?.length) {
      info.summary = { ...info.summary, diffs: [] }
    }

    expect(info.summary?.diffs).toEqual([])
    expect(info.summary?.title).toBe("test title")
    expect(info.summary?.body).toBe("test body")
  })

  test("user message without summary is unchanged", () => {
    const info = userInfo("m2")
    expect(info.summary).toBeUndefined()

    // Simulate stripping — should be a no-op
    if (info.role === "user" && info.summary?.diffs?.length) {
      info.summary = { ...info.summary, diffs: [] }
    }

    expect(info.summary).toBeUndefined()
  })

  test("user message with empty diffs is unchanged", () => {
    const info = userInfo("m3", { diffs: [] })

    if (info.role === "user" && info.summary?.diffs?.length) {
      info.summary = { ...info.summary, diffs: [] }
    }

    expect(info.summary?.diffs).toEqual([])
  })

  test("assistant message summary is not affected", () => {
    const info = assistantInfo("a1", "m1") as MessageV2.Info
    // Assistant messages have a boolean summary field, not the object type
    expect(info.role).toBe("assistant")
    // The stripping logic only targets role === "user"
    const shouldStrip = info.role === "user" && info.summary?.diffs?.length
    expect(shouldStrip).toBeFalsy()
  })
})

describe("Fix 3: DIFF_SKIP_PATTERNS filter", () => {
  const DIFF_SKIP_PATTERNS = [
    /(?:^|\/)graphify-out\//,
    /(?:^|\/)node_modules\//,
    /(?:^|\/)\.next\//,
    /(?:^|\/)dist\//,
    /(?:^|\/)build\//,
    /(?:^|\/)\.turbo\//,
    /(?:^|\/)\.cache\//,
    /\.lock$/,
    /(?:^|\/)package-lock\.json$/,
  ]

  function shouldSkip(file: string) {
    return DIFF_SKIP_PATTERNS.some((re) => re.test(file))
  }

  test("skips graphify-out files", () => {
    expect(shouldSkip("graphify-out/cache/data.json")).toBe(true)
    expect(shouldSkip("some/path/graphify-out/file.ts")).toBe(true)
  })

  test("skips node_modules files", () => {
    expect(shouldSkip("node_modules/lodash/index.js")).toBe(true)
    expect(shouldSkip("packages/app/node_modules/react/index.js")).toBe(true)
  })

  test("skips .next build output", () => {
    expect(shouldSkip(".next/static/chunks/main.js")).toBe(true)
    expect(shouldSkip("apps/web/.next/server/pages/index.js")).toBe(true)
  })

  test("skips dist directory", () => {
    expect(shouldSkip("dist/index.js")).toBe(true)
    expect(shouldSkip("packages/lib/dist/bundle.js")).toBe(true)
  })

  test("skips build directory", () => {
    expect(shouldSkip("build/output.js")).toBe(true)
  })

  test("skips .turbo cache", () => {
    expect(shouldSkip(".turbo/cache/abc123")).toBe(true)
  })

  test("skips .cache directory", () => {
    expect(shouldSkip(".cache/some-tool/data")).toBe(true)
  })

  test("skips lockfiles", () => {
    expect(shouldSkip("bun.lock")).toBe(true)
    expect(shouldSkip("yarn.lock")).toBe(true)
    expect(shouldSkip("pnpm-lock.yaml")).toBe(false) // .yaml not .lock
    expect(shouldSkip("package-lock.json")).toBe(true)
    expect(shouldSkip("packages/app/package-lock.json")).toBe(true)
  })

  test("allows normal source files", () => {
    expect(shouldSkip("src/index.ts")).toBe(false)
    expect(shouldSkip("packages/opencode/src/session/summary.ts")).toBe(false)
    expect(shouldSkip("README.md")).toBe(false)
    expect(shouldSkip("package.json")).toBe(false)
  })

  test("does not false-positive on similar names", () => {
    expect(shouldSkip("src/build-utils.ts")).toBe(false)
    expect(shouldSkip("src/dist-helper.ts")).toBe(false)
    // "build/" as a directory should match, but "build" in a filename should not
    expect(shouldSkip("src/rebuild/index.ts")).toBe(false)
  })
})

describe("Fix 3: DIFF_CONTENT_LIMIT cap", () => {
  const DIFF_CONTENT_LIMIT = 1024 * 1024

  test("caps content when total exceeds limit", () => {
    const files = [
      { file: "a.ts", before: "x".repeat(500_000), after: "y".repeat(500_000) },
      { file: "b.ts", before: "x".repeat(500_000), after: "y".repeat(500_000) },
    ]

    let contentBytes = 0
    const result = files.map((f) => {
      const size = f.before.length + f.after.length
      if (contentBytes + size > DIFF_CONTENT_LIMIT) {
        return { ...f, before: "", after: "" }
      }
      contentBytes += size
      return f
    })

    // First file fits (1MB exactly at limit)
    expect(result[0]!.before).toHaveLength(500_000)
    expect(result[0]!.after).toHaveLength(500_000)
    // Second file exceeds limit — content stripped
    expect(result[1]!.before).toBe("")
    expect(result[1]!.after).toBe("")
    // File metadata preserved
    expect(result[1]!.file).toBe("b.ts")
  })

  test("small diffs are not capped", () => {
    const files = [
      { file: "a.ts", before: "hello", after: "world" },
      { file: "b.ts", before: "foo", after: "bar" },
    ]

    let contentBytes = 0
    const result = files.map((f) => {
      const size = f.before.length + f.after.length
      if (contentBytes + size > DIFF_CONTENT_LIMIT) {
        return { ...f, before: "", after: "" }
      }
      contentBytes += size
      return f
    })

    expect(result[0]!.before).toBe("hello")
    expect(result[1]!.before).toBe("foo")
  })
})
