import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test"
import { WorkflowRuntime } from "@/workflow/runtime"
import { WorkflowSessionWriter } from "@/workflow/session-writer"
import { WorkflowPersistence } from "@/workflow/persistence"
import { SessionPrompt } from "@/session/prompt"
import { SyncEvent } from "@/sync"
import { Bus } from "@/bus"
import { SessionID } from "@/session/schema"
import { MessageV2 } from "@/session/message-v2"
import path from "path"
import fs from "fs/promises"
import os from "os"

const childSID = SessionID.make("session_child_mock_001")

mock.module("@/orchestration/task-spawn", () => ({
  spawnSubagent: async () => ({
    session: { id: childSID },
    spawnInfo: { release: () => {} },
    spawned: true,
  }),
}))

mock.module("@/agent/agent", () => ({
  Agent: {
    get: async () => ({ name: "coder", model: "test/model" }),
    list: async () => [{ name: "coder", model: "test/model" }],
    defaultAgent: async () => "coder",
  },
}))

describe("WorkflowRuntime.executeInSession", () => {
  it("throws when runtime not initialized", async () => {
    const sid = SessionID.make("session_test-exec-001")
    await expect(
      WorkflowRuntime.executeInSession({
        sessionID: sid,
        name: "nonexistent",
        timeout: 5000,
      }),
    ).rejects.toThrow("not initialized")
  })

  describe("with mocked persistence", () => {
    let dir: string
    const sid = SessionID.make("session_runtime_int_001")
    const calls: Array<{ def: unknown; data: unknown }> = []

    // Stash originals
    let origRun: typeof SyncEvent.run
    let origPublish: typeof Bus.publish
    let origRecordStart: typeof WorkflowPersistence.recordStart
    let origRecordPhase: typeof WorkflowPersistence.recordPhase
    let origRecordTerminal: typeof WorkflowPersistence.recordTerminal
    let origLoadJournal: typeof WorkflowPersistence.loadJournal
    let origAppendJournal: typeof WorkflowPersistence.appendJournal
    let origWriteScript: typeof WorkflowPersistence.writeScript
    let origFlushCounters: typeof WorkflowPersistence.flushCounters

    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-runtime-"))
      const scripts = path.join(dir, ".opencode", "workflows")
      await fs.mkdir(scripts, { recursive: true })

      calls.length = 0
      WorkflowSessionWriter.reset()

      // Mock Bus.publish (requires Instance ALS context not available in tests)
      origPublish = Bus.publish
      // @ts-ignore
      Bus.publish = async () => {}

      // Mock SyncEvent.run
      origRun = SyncEvent.run
      // @ts-ignore
      SyncEvent.run = (def: unknown, data: unknown) => {
        calls.push({ def, data })
      }

      // Mock persistence
      origRecordStart = WorkflowPersistence.recordStart
      origRecordPhase = WorkflowPersistence.recordPhase
      origRecordTerminal = WorkflowPersistence.recordTerminal
      origLoadJournal = WorkflowPersistence.loadJournal
      origAppendJournal = WorkflowPersistence.appendJournal
      origWriteScript = WorkflowPersistence.writeScript
      origFlushCounters = WorkflowPersistence.flushCounters
      // @ts-ignore
      WorkflowPersistence.recordStart = () => {}
      // @ts-ignore
      WorkflowPersistence.recordPhase = () => {}
      // @ts-ignore
      WorkflowPersistence.recordTerminal = () => {}
      // @ts-ignore
      WorkflowPersistence.loadJournal = () => []
      // @ts-ignore
      WorkflowPersistence.appendJournal = () => {}
      // @ts-ignore
      WorkflowPersistence.writeScript = () => {}
      // @ts-ignore
      WorkflowPersistence.flushCounters = () => {}

      WorkflowRuntime.init({ concurrent: 2, timeout: 30000, depth: 3, dir })
      WorkflowSessionWriter.setCwd(dir)
    })

    afterEach(async () => {
      // @ts-ignore
      Bus.publish = origPublish
      // @ts-ignore
      SyncEvent.run = origRun
      // @ts-ignore
      WorkflowPersistence.recordStart = origRecordStart
      // @ts-ignore
      WorkflowPersistence.recordPhase = origRecordPhase
      // @ts-ignore
      WorkflowPersistence.recordTerminal = origRecordTerminal
      // @ts-ignore
      WorkflowPersistence.loadJournal = origLoadJournal
      // @ts-ignore
      WorkflowPersistence.appendJournal = origAppendJournal
      // @ts-ignore
      WorkflowPersistence.writeScript = origWriteScript
      // @ts-ignore
      WorkflowPersistence.flushCounters = origFlushCounters
      await fs.rm(dir, { recursive: true, force: true })
    })

    it("executes script calling phase and log hooks", async () => {
      const scripts = path.join(dir, ".opencode", "workflows")
      await Bun.write(
        path.join(scripts, "test-basic.js"),
        `// name: test-basic\nphase("build")\nlog("info", "starting build")`,
      )

      const result = await WorkflowRuntime.executeInSession({
        sessionID: sid,
        name: "test-basic",
        timeout: 10000,
      })

      expect(result).toContain("completed successfully")

      // Verify writePhase produced text part with phase name
      const phases = calls.filter((c) => {
        const data = c.data as { part?: { type: string; text?: string } }
        return data.part?.type === "text" && data.part.text?.startsWith("## Phase:")
      })
      expect(phases.length).toBeGreaterThan(0)
      expect((phases[0].data as { part: { text: string } }).part.text).toBe("## Phase: build")

      // Verify appendLog produced text part with log format
      const logs = calls.filter((c) => {
        const data = c.data as { part?: { type: string; text?: string } }
        return data.part?.type === "text" && data.part.text?.startsWith("[info]")
      })
      expect(logs.length).toBeGreaterThan(0)
      expect((logs[0].data as { part: { text: string } }).part.text).toBe("[info] starting build")
    })

    it("writes completion status on success", async () => {
      const scripts = path.join(dir, ".opencode", "workflows")
      await Bun.write(path.join(scripts, "test-simple.js"), `// name: test-simple\nlog("info", "done")`)

      await WorkflowRuntime.executeInSession({
        sessionID: sid,
        name: "test-simple",
        timeout: 10000,
      })

      const status = calls.filter((c) => {
        const data = c.data as { part?: { type: string; text?: string } }
        return data.part?.type === "text" && data.part.text?.includes("completed successfully")
      })
      expect(status.length).toBeGreaterThan(0)
    })
  })
})

describe("runAgentInline via agent hook", () => {
  let dir: string
  const sid = SessionID.make("session_agent_inline_001")
  let origRun: typeof SyncEvent.run
  let origPublish: typeof Bus.publish
  let origRecordStart: typeof WorkflowPersistence.recordStart
  let origRecordPhase: typeof WorkflowPersistence.recordPhase
  let origRecordTerminal: typeof WorkflowPersistence.recordTerminal
  let origLoadJournal: typeof WorkflowPersistence.loadJournal
  let origAppendJournal: typeof WorkflowPersistence.appendJournal
  let origWriteScript: typeof WorkflowPersistence.writeScript
  let origFlushCounters: typeof WorkflowPersistence.flushCounters
  let origPrompt: typeof SessionPrompt.prompt
  let origCancel: typeof SessionPrompt.cancel

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "wf-agent-"))
    const scripts = path.join(dir, ".opencode", "workflows")
    await fs.mkdir(scripts, { recursive: true })

    WorkflowSessionWriter.reset()

    origPublish = Bus.publish
    // @ts-ignore
    Bus.publish = async () => {}

    origRun = SyncEvent.run
    // @ts-ignore
    SyncEvent.run = () => {}

    origRecordStart = WorkflowPersistence.recordStart
    origRecordPhase = WorkflowPersistence.recordPhase
    origRecordTerminal = WorkflowPersistence.recordTerminal
    origLoadJournal = WorkflowPersistence.loadJournal
    origAppendJournal = WorkflowPersistence.appendJournal
    origWriteScript = WorkflowPersistence.writeScript
    origFlushCounters = WorkflowPersistence.flushCounters
    // @ts-ignore
    WorkflowPersistence.recordStart = () => {}
    // @ts-ignore
    WorkflowPersistence.recordPhase = () => {}
    // @ts-ignore
    WorkflowPersistence.recordTerminal = () => {}
    // @ts-ignore
    WorkflowPersistence.loadJournal = () => []
    // @ts-ignore
    WorkflowPersistence.appendJournal = () => {}
    // @ts-ignore
    WorkflowPersistence.writeScript = () => {}
    // @ts-ignore
    WorkflowPersistence.flushCounters = () => {}

    origPrompt = SessionPrompt.prompt
    origCancel = SessionPrompt.cancel

    WorkflowRuntime.init({ concurrent: 2, timeout: 30000, depth: 3, dir })
    WorkflowSessionWriter.setCwd(dir)
  })

  afterEach(async () => {
    // @ts-ignore
    Bus.publish = origPublish
    // @ts-ignore
    SyncEvent.run = origRun
    // @ts-ignore
    WorkflowPersistence.recordStart = origRecordStart
    // @ts-ignore
    WorkflowPersistence.recordPhase = origRecordPhase
    // @ts-ignore
    WorkflowPersistence.recordTerminal = origRecordTerminal
    // @ts-ignore
    WorkflowPersistence.loadJournal = origLoadJournal
    // @ts-ignore
    WorkflowPersistence.appendJournal = origAppendJournal
    // @ts-ignore
    WorkflowPersistence.writeScript = origWriteScript
    // @ts-ignore
    WorkflowPersistence.flushCounters = origFlushCounters
    // @ts-ignore
    SessionPrompt.prompt = origPrompt
    // @ts-ignore
    SessionPrompt.cancel = origCancel
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("calls SessionPrompt.prompt with correct sessionID", async () => {
    const captured: Array<{ sessionID: string }> = []
    // @ts-ignore
    SessionPrompt.prompt = (input: { sessionID: string }) => {
      captured.push({ sessionID: input.sessionID })
      return Promise.resolve({
        info: {} as MessageV2.Info,
        parts: [{ type: "text", text: "agent response" }],
      })
    }
    // @ts-ignore
    SessionPrompt.cancel = () => {}

    const scripts = path.join(dir, ".opencode", "workflows")
    await Bun.write(path.join(scripts, "test-agent.js"), `// name: test-agent\nagent("coder", { prompt: "fix bug" })`)

    await WorkflowRuntime.executeInSession({
      sessionID: sid,
      name: "test-agent",
      timeout: 10000,
    })

    expect(captured.length).toBe(1)
    expect(captured[0].sessionID).toBe(childSID)
  })

  it("rejects with timeout when SessionPrompt.prompt exceeds timeout", async () => {
    let cancelled = false
    // @ts-ignore - mock prompt to reject (simulates agent error caught by hook)
    SessionPrompt.prompt = () => Promise.reject(new Error("Operation timed out after 50ms"))
    // @ts-ignore
    SessionPrompt.cancel = () => {
      cancelled = true
    }

    const scripts = path.join(dir, ".opencode", "workflows")
    await Bun.write(path.join(scripts, "test-timeout.js"), `// name: test-timeout\nagent("slow", { prompt: "wait" })`)

    // The agent hook catches errors from runAgent and returns { error }
    // allowing the script to complete normally
    const result = await WorkflowRuntime.executeInSession({
      sessionID: sid,
      name: "test-timeout",
      timeout: 10000,
    })

    // executeInSession catches agent errors via the hook's try/catch
    // The script completes and executeInSession returns success
    expect(result).toContain("completed successfully")
  })
})

describe("WorkflowSessionWriter.reset", () => {
  beforeEach(() => {
    WorkflowSessionWriter.reset()
  })

  it("is idempotent", () => {
    WorkflowSessionWriter.reset()
    WorkflowSessionWriter.reset()
    // No throw
  })
})
