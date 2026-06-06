import { describe, test, expect } from "bun:test"
import { Database } from "../../src/storage/db"
import { BranchPRState, type BranchPRRow } from "../../src/orchestration/branch-pr-state"
import { SessionTable } from "../../src/session/session.sql"
import { ProjectTable } from "../../src/project/project.sql"
import { SessionID } from "../../src/session/schema"
import { ProjectID } from "../../src/project/schema"

const PROJECT = ProjectID.make("proj_brpr_test_" + Date.now())

function setup() {
  Database.use((db) =>
    db
      .insert(ProjectTable)
      .values({
        id: PROJECT,
        worktree: "/tmp",
        time_created: Date.now(),
        time_updated: Date.now(),
        sandboxes: [],
      })
      .onConflictDoNothing()
      .run(),
  )
}

function uid() {
  return SessionID.make(crypto.randomUUID())
}

function session(id: SessionID, parent?: SessionID) {
  const now = Date.now()
  Database.use((db) =>
    db
      .insert(SessionTable)
      .values({
        id,
        project_id: PROJECT,
        parent_id: parent ?? null,
        slug: id,
        directory: "/tmp",
        title: "test",
        version: "1",
        time_created: now,
        time_updated: now,
        cost: 0,
        tokens_input: 0,
        tokens_output: 0,
        tokens_reasoning: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
        cost_by_model: null,
      })
      .run(),
  )
  return id
}

describe("orchestration/branch-pr-state", () => {
  setup()

  test("insert and get roundtrip", () => {
    const parent = session(uid())
    const child = session(uid(), parent)
    const id = crypto.randomUUID()

    BranchPRState.insert({
      id,
      session_id: child,
      parent_session_id: parent,
      branch: "opencode/abc12345/test",
      base: "a".repeat(40),
      slug: "test",
      state: "open",
      diff_summary: "1 file changed",
      review_note: null,
      created_at: Date.now(),
    })

    const row = BranchPRState.get(id)
    expect(row).toBeDefined()
    expect(row!.id).toBe(id)
    expect(row!.session_id).toBe(child)
    expect(row!.parent_session_id).toBe(parent)
    expect(row!.branch).toBe("opencode/abc12345/test")
    expect(row!.state).toBe("open")
    expect(row!.diff_summary).toBe("1 file changed")
    expect(row!.merged_at).toBeNull()
  })

  test("update transitions state", () => {
    const parent = session(uid())
    const child = session(uid(), parent)
    const id = crypto.randomUUID()

    BranchPRState.insert({
      id,
      session_id: child,
      parent_session_id: parent,
      branch: "opencode/update01/feat",
      base: "b".repeat(40),
      slug: "feat",
      state: "open",
      diff_summary: null,
      review_note: null,
      created_at: Date.now(),
    })

    const now = Date.now()
    BranchPRState.update({ id, state: "merged", note: "lgtm", mergedAt: now })

    const row = BranchPRState.get(id)
    expect(row!.state).toBe("merged")
    expect(row!.review_note).toBe("lgtm")
    expect(row!.merged_at).toBe(now)
  })

  test("pending returns only open PRs for session", () => {
    const parent = session(uid())
    const child1 = session(uid(), parent)
    const child2 = session(uid(), parent)

    const id1 = crypto.randomUUID()
    const id2 = crypto.randomUUID()
    const id3 = crypto.randomUUID()

    BranchPRState.insert({
      id: id1,
      session_id: child1,
      parent_session_id: parent,
      branch: "opencode/pend01/a",
      base: "c".repeat(40),
      slug: "a",
      state: "open",
      diff_summary: null,
      review_note: null,
      created_at: Date.now(),
    })

    BranchPRState.insert({
      id: id2,
      session_id: child2,
      parent_session_id: parent,
      branch: "opencode/pend01/b",
      base: "d".repeat(40),
      slug: "b",
      state: "open",
      diff_summary: null,
      review_note: null,
      created_at: Date.now(),
    })

    // Merged PR — should not appear
    BranchPRState.insert({
      id: id3,
      session_id: child1,
      parent_session_id: parent,
      branch: "opencode/pend01/c",
      base: "e".repeat(40),
      slug: "c",
      state: "merged",
      diff_summary: null,
      review_note: null,
      created_at: Date.now(),
      merged_at: Date.now(),
    })

    const rows = BranchPRState.pending(parent)
    expect(rows.length).toBe(2)
    expect(rows.map((r) => r.id).sort()).toEqual([id1, id2].sort())
  })

  test("pending returns empty when no open PRs", () => {
    const parent = session(uid())
    const rows = BranchPRState.pending(parent)
    expect(rows).toEqual([])
  })

  test("update to rejected state", () => {
    const parent = session(uid())
    const child = session(uid(), parent)
    const id = crypto.randomUUID()

    BranchPRState.insert({
      id,
      session_id: child,
      parent_session_id: parent,
      branch: "opencode/reject/x",
      base: "f".repeat(40),
      slug: "x",
      state: "open",
      diff_summary: null,
      review_note: null,
      created_at: Date.now(),
    })

    BranchPRState.update({ id, state: "rejected", note: "needs rework" })

    const row = BranchPRState.get(id)
    expect(row!.state).toBe("rejected")
    expect(row!.review_note).toBe("needs rework")
    expect(row!.merged_at).toBeNull()
  })

  test("get returns undefined for missing id", () => {
    const row = BranchPRState.get("nonexistent-id-" + Date.now())
    expect(row).toBeUndefined()
  })

  test("stale returns open PRs older than cutoff", () => {
    const parent = session(uid())
    const child1 = session(uid(), parent)
    const child2 = session(uid(), parent)
    const child3 = session(uid(), parent)

    const old = crypto.randomUUID()
    const recent = crypto.randomUUID()
    const merged = crypto.randomUUID()

    const now = Date.now()
    const oneDay = 24 * 60 * 60 * 1000

    // Old open PR — should appear
    BranchPRState.insert({
      id: old,
      session_id: child1,
      parent_session_id: parent,
      branch: "opencode/stale01/old",
      base: "a".repeat(40),
      slug: "old",
      state: "open",
      diff_summary: null,
      review_note: null,
      created_at: now - oneDay * 3,
    })

    // Recent open PR — should NOT appear
    BranchPRState.insert({
      id: recent,
      session_id: child2,
      parent_session_id: parent,
      branch: "opencode/stale01/recent",
      base: "b".repeat(40),
      slug: "recent",
      state: "open",
      diff_summary: null,
      review_note: null,
      created_at: now - oneDay / 2,
    })

    // Old but merged — should NOT appear
    BranchPRState.insert({
      id: merged,
      session_id: child3,
      parent_session_id: parent,
      branch: "opencode/stale01/merged",
      base: "c".repeat(40),
      slug: "merged",
      state: "merged",
      diff_summary: null,
      review_note: null,
      created_at: now - oneDay * 5,
      merged_at: now - oneDay * 4,
    })

    const cutoff = now - oneDay
    const rows = BranchPRState.stale(cutoff)
    const ids = rows.map((r) => r.id)

    expect(ids).toContain(old)
    expect(ids).not.toContain(recent)
    expect(ids).not.toContain(merged)
  })

  test("stale returns empty when no PRs older than cutoff", () => {
    const rows = BranchPRState.stale(0)
    expect(rows).toEqual([])
  })
})
