import { describe, expect, test } from "bun:test"
import { Session } from "../../src/session"
import { toPartialRow } from "../../src/session/projectors"
import { SessionID } from "../../src/session/schema"
import { ProjectID } from "../../src/project/schema"

// ---------------------------------------------------------------------------
// fromRow / toRow round-trip
// ---------------------------------------------------------------------------

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ses_test" as SessionID,
    project_id: "proj_test" as ReturnType<typeof ProjectID.make>,
    workspace_id: null,
    parent_id: null,
    slug: "test",
    directory: "/tmp",
    title: "Test",
    version: "1",
    share_url: null,
    summary_additions: null,
    summary_deletions: null,
    summary_files: null,
    summary_diffs: null,
    revert: null,
    permission: null,
    time_created: 1000,
    time_updated: 2000,
    time_compacting: null,
    time_archived: null,
    cost: 0,
    tokens_input: 0,
    tokens_output: 0,
    tokens_reasoning: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    ...overrides,
  } as Parameters<typeof Session.fromRow>[0]
}

describe("Session.fromRow", () => {
  test("maps zero usage columns", () => {
    const info = Session.fromRow(makeRow())
    expect(info.cost).toBe(0)
    expect(info.tokens.input).toBe(0)
    expect(info.tokens.output).toBe(0)
    expect(info.tokens.reasoning).toBe(0)
    expect(info.tokens.cache.read).toBe(0)
    expect(info.tokens.cache.write).toBe(0)
  })

  test("maps non-zero usage columns", () => {
    const info = Session.fromRow(
      makeRow({
        cost: 1.5,
        tokens_input: 100,
        tokens_output: 200,
        tokens_reasoning: 50,
        tokens_cache_read: 10,
        tokens_cache_write: 20,
      }),
    )
    expect(info.cost).toBe(1.5)
    expect(info.tokens.input).toBe(100)
    expect(info.tokens.output).toBe(200)
    expect(info.tokens.reasoning).toBe(50)
    expect(info.tokens.cache.read).toBe(10)
    expect(info.tokens.cache.write).toBe(20)
  })

  test("null columns default to 0", () => {
    const info = Session.fromRow(
      makeRow({
        cost: null,
        tokens_input: null,
        tokens_output: null,
        tokens_reasoning: null,
        tokens_cache_read: null,
        tokens_cache_write: null,
      }),
    )
    expect(info.cost).toBe(0)
    expect(info.tokens.input).toBe(0)
    expect(info.tokens.cache.read).toBe(0)
  })
})

describe("Session.toRow", () => {
  test("flattens tokens to columns", () => {
    const info = Session.fromRow(
      makeRow({
        cost: 2.5,
        tokens_input: 300,
        tokens_output: 400,
        tokens_reasoning: 75,
        tokens_cache_read: 15,
        tokens_cache_write: 25,
      }),
    )
    const row = Session.toRow(info)
    expect(row.cost).toBe(2.5)
    expect(row.tokens_input).toBe(300)
    expect(row.tokens_output).toBe(400)
    expect(row.tokens_reasoning).toBe(75)
    expect(row.tokens_cache_read).toBe(15)
    expect(row.tokens_cache_write).toBe(25)
  })

  test("round-trip preserves usage", () => {
    const orig = makeRow({ cost: 9.99, tokens_input: 111, tokens_cache_write: 7 })
    const info = Session.fromRow(orig)
    const row = Session.toRow(info)
    expect(row.cost).toBe(9.99)
    expect(row.tokens_input).toBe(111)
    expect(row.tokens_cache_write).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// Session.Info Zod schema
// ---------------------------------------------------------------------------

describe("Session.Info schema", () => {
  test("parses with defaults when cost/tokens absent", () => {
    const raw = {
      id: "ses_test",
      slug: "s",
      projectID: "proj_test",
      directory: "/tmp",
      title: "T",
      version: "1",
      time: { created: 1, updated: 2 },
    }
    const parsed = Session.Info.parse(raw)
    expect(parsed.cost).toBe(0)
    expect(parsed.tokens.input).toBe(0)
    expect(parsed.tokens.cache.read).toBe(0)
  })

  test("parses explicit cost and tokens", () => {
    const raw = {
      id: "ses_test",
      slug: "s",
      projectID: "proj_test",
      directory: "/tmp",
      title: "T",
      version: "1",
      time: { created: 1, updated: 2 },
      cost: 3.14,
      tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 2, write: 3 } },
    }
    const parsed = Session.Info.parse(raw)
    expect(parsed.cost).toBe(3.14)
    expect(parsed.tokens.input).toBe(10)
    expect(parsed.tokens.cache.write).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// toPartialRow — usage fields
// ---------------------------------------------------------------------------

describe("toPartialRow usage fields", () => {
  test("omits usage fields when not in partial", () => {
    const row = toPartialRow({ title: "new title" })
    expect("cost" in row).toBe(false)
    expect("tokens_input" in row).toBe(false)
  })

  test("includes cost when provided", () => {
    const row = toPartialRow({ cost: 5.5 })
    expect(row.cost).toBe(5.5)
  })

  test("includes tokens_input from nested tokens", () => {
    const row = toPartialRow({ tokens: { input: 42 } } as Parameters<typeof toPartialRow>[0])
    expect(row.tokens_input).toBe(42)
  })

  test("includes cache read/write from nested tokens.cache", () => {
    const row = toPartialRow({
      tokens: { cache: { read: 7, write: 8 } },
    } as Parameters<typeof toPartialRow>[0])
    expect(row.tokens_cache_read).toBe(7)
    expect(row.tokens_cache_write).toBe(8)
  })
})
