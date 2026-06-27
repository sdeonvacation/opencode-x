import { describe, expect, test } from "bun:test"
import { Database } from "../../../src/storage/db"
import { SessionTable } from "../../../src/session/session.sql"
import { ProjectTable } from "../../../src/project/project.sql"
import { Loop } from "../../../src/loop/loop"
import { SessionID } from "../../../src/session/schema"
import { ProjectID } from "../../../src/project/schema"
import { Log } from "../../../src/util/log"

Log.init({ print: false })

const PROJECT = ProjectID.make("proj_loop_status_test_" + Date.now())

function uid() {
  return SessionID.make(crypto.randomUUID())
}

function setupSession(id: SessionID) {
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
  Database.use((db) =>
    db
      .insert(SessionTable)
      .values({
        id,
        project_id: PROJECT,
        parent_id: null,
        slug: id as string,
        directory: "/tmp",
        title: "test",
        version: "1",
        time_created: Date.now(),
        time_updated: Date.now(),
        cost: 0,
        tokens_input: 0,
        tokens_output: 0,
        tokens_reasoning: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
      })
      .onConflictDoNothing()
      .run(),
  )
}

describe("LoopStatus logic", () => {
  test("count active/paused loops only", () => {
    const sid = uid()
    setupSession(sid)

    Loop.create({ sessionID: sid, prompt: "active loop", intervalMs: 60000 })
    Loop.create({ sessionID: sid, prompt: "paused loop", intervalMs: 60000 })
    Loop.create({ sessionID: sid, prompt: "to cancel", intervalMs: 60000 })

    const all = Loop.list(sid)
    expect(all.length).toBe(3)

    // Cancel one
    const toCancel = all.find((l) => l.prompt === "to cancel")!
    Loop.cancel({ id: toCancel.id })

    // Pause one
    const toPause = all.find((l) => l.prompt === "paused loop")!
    Loop.pause({ id: toPause.id })

    // Recount with active/paused filter (same logic as component)
    const updated = Loop.list(sid)
    const count = updated.filter((l) => l.status === "active" || l.status === "paused").length
    expect(count).toBe(2)
  })

  test("returns 0 when no loops exist", () => {
    const sid = uid()
    setupSession(sid)

    const loops = Loop.list(sid)
    const count = loops.filter((l) => l.status === "active" || l.status === "paused").length
    expect(count).toBe(0)
  })

  test("returns 0 when all loops cancelled", () => {
    const sid = uid()
    setupSession(sid)

    Loop.create({ sessionID: sid, prompt: "will cancel", intervalMs: 60000 })
    const loops = Loop.list(sid)
    Loop.cancel({ id: loops[0].id })

    const updated = Loop.list(sid)
    const count = updated.filter((l) => l.status === "active" || l.status === "paused").length
    expect(count).toBe(0)
  })

  test("pluralization: 1 loop vs multiple loops", () => {
    const sid = uid()
    setupSession(sid)

    Loop.create({ sessionID: sid, prompt: "single", intervalMs: 60000 })
    const loops = Loop.list(sid)
    const count = loops.filter((l) => l.status === "active" || l.status === "paused").length
    expect(count).toBe(1)

    // Component renders "loop" for 1, "loops" for >1
    const label = `${count} loop${count > 1 ? "s" : ""}`
    expect(label).toBe("1 loop")

    Loop.create({ sessionID: sid, prompt: "second", intervalMs: 60000 })
    const loops2 = Loop.list(sid)
    const count2 = loops2.filter((l) => l.status === "active" || l.status === "paused").length
    expect(count2).toBe(2)

    const label2 = `${count2} loop${count2 > 1 ? "s" : ""}`
    expect(label2).toBe("2 loops")
  })
})
