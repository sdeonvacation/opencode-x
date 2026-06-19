import { describe, it, expect, afterAll } from "bun:test"
import { WorkflowPersistence } from "@/workflow/persistence"
import { WorkflowRunID } from "@/workflow/schema"
import { Global } from "@/global"
import path from "path"
import { rmSync, existsSync, mkdirSync, writeFileSync } from "fs"

// DB-dependent tests (recordStart, recordPhase, list, load, etc.) require
// full Instance.provide + Database setup. Skipped here — use integration harness.

const id = WorkflowRunID.make("wfrun_test-persistence-" + Date.now())
const dir = path.join(Global.Path.data, "workflow", id)

afterAll(() => {
  // cleanup test artifacts
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
})

describe("WorkflowPersistence.journal", () => {
  it("appendJournal + loadJournal round-trip", () => {
    const entry: WorkflowPersistence.JournalEntry = {
      type: "log",
      timestamp: Date.now(),
      data: { msg: "hello" },
    }
    WorkflowPersistence.appendJournal(id, entry)
    const entries = WorkflowPersistence.loadJournal(id)
    expect(entries).toHaveLength(1)
    expect(entries[0].type).toBe("log")
    expect(entries[0].data).toEqual({ msg: "hello" })
  })

  it("appends multiple entries", () => {
    const entry: WorkflowPersistence.JournalEntry = {
      type: "agent_start",
      timestamp: Date.now(),
      data: { agent: "coder" },
    }
    WorkflowPersistence.appendJournal(id, entry)
    const entries = WorkflowPersistence.loadJournal(id)
    expect(entries).toHaveLength(2)
    expect(entries[1].type).toBe("agent_start")
  })

  it("loadJournal returns empty array for nonexistent file", () => {
    const fake = WorkflowRunID.make("wfrun_nonexistent-" + Date.now())
    const entries = WorkflowPersistence.loadJournal(fake)
    expect(entries).toEqual([])
  })

  it("loadJournal skips malformed lines", () => {
    const malformed = WorkflowRunID.make("wfrun_malformed-" + Date.now())
    const target = path.join(Global.Path.data, "workflow", malformed, "journal.jsonl")
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(
      target,
      '{"type":"log","timestamp":1,"data":{}}\nnot json\n{"type":"phase","timestamp":2,"data":{}}\n',
    )
    try {
      const entries = WorkflowPersistence.loadJournal(malformed)
      expect(entries).toHaveLength(2)
      expect(entries[0].type).toBe("log")
      expect(entries[1].type).toBe("phase")
    } finally {
      rmSync(path.dirname(target), { recursive: true, force: true })
    }
  })

  it("clearJournal removes journal file", () => {
    // id already has journal from previous tests
    WorkflowPersistence.clearJournal(id)
    const entries = WorkflowPersistence.loadJournal(id)
    expect(entries).toEqual([])
  })
})

describe("WorkflowPersistence.script", () => {
  const script = "console.log('test-script-" + Date.now() + "')"
  const sha = new Bun.CryptoHasher("sha256").update(script).digest("hex")
  const target = path.join(Global.Path.data, "workflow", "scripts", sha + ".js")

  afterAll(() => {
    if (existsSync(target)) rmSync(target)
  })

  it("writeScript + readScript round-trip", () => {
    WorkflowPersistence.writeScript(sha, script)
    const content = WorkflowPersistence.readScript(sha)
    expect(content).toBe(script)
  })

  it("writeScript is idempotent (no overwrite)", () => {
    WorkflowPersistence.writeScript(sha, "different content")
    const content = WorkflowPersistence.readScript(sha)
    // original content preserved since file already exists
    expect(content).toBe(script)
  })

  it("readScript returns undefined for missing sha", () => {
    const missing = WorkflowPersistence.readScript("deadbeef" + Date.now())
    expect(missing).toBeUndefined()
  })
})

describe("WorkflowPersistence DB operations", () => {
  it.skip("recordStart requires Instance.provide + Database", () => {})
  it.skip("recordPhase requires Instance.provide + Database", () => {})
  it.skip("flushCounters requires Instance.provide + Database", () => {})
  it.skip("recordTerminal requires Instance.provide + Database", () => {})
  it.skip("list requires Instance.provide + Database", () => {})
  it.skip("load requires Instance.provide + Database", () => {})
})
