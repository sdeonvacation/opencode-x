import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test"
import { WorkflowSessionWriter } from "@/workflow/session-writer"
import { SyncEvent } from "@/sync"
import { MessageV2 } from "@/session/message-v2"
import { SessionID } from "@/session/schema"

// Mock SyncEvent.run to capture calls without DB
const calls: Array<{ def: unknown; data: unknown }> = []
const origRun = SyncEvent.run
beforeEach(() => {
  calls.length = 0
  WorkflowSessionWriter.reset()
  WorkflowSessionWriter.setCwd("/tmp/test")
  // @ts-ignore - monkey-patch for test
  SyncEvent.run = (def: unknown, data: unknown) => {
    calls.push({ def, data })
  }
})

const sid = SessionID.make("session_test-writer-001")

describe("WorkflowSessionWriter", () => {
  describe("writePhase", () => {
    it("creates a new message and text part", () => {
      WorkflowSessionWriter.writePhase(sid, "build")
      // First call: message creation (Updated event)
      expect(calls.length).toBe(2)
      expect(calls[0].def).toBe(MessageV2.Event.Updated)
      expect(calls[1].def).toBe(MessageV2.Event.PartUpdated)
      const part = (calls[1].data as any).part
      expect(part.type).toBe("text")
      expect(part.text).toBe("## Phase: build")
      expect(part.synthetic).toBe(true)
    })

    it("creates a fresh message each call", () => {
      WorkflowSessionWriter.writePhase(sid, "phase1")
      WorkflowSessionWriter.writePhase(sid, "phase2")
      // Each writePhase = 1 Updated + 1 PartUpdated = 2 calls each
      expect(calls.length).toBe(4)
      const msg1 = (calls[0].data as any).info.id
      const msg2 = (calls[2].data as any).info.id
      expect(msg1).not.toBe(msg2)
    })
  })

  describe("appendLog", () => {
    it("reuses current message if session matches", () => {
      WorkflowSessionWriter.writePhase(sid, "setup")
      calls.length = 0
      WorkflowSessionWriter.appendLog(sid, "info", "hello world")
      // Should only emit PartUpdated (reuses existing message)
      expect(calls.length).toBe(1)
      expect(calls[0].def).toBe(MessageV2.Event.PartUpdated)
      const part = (calls[0].data as any).part
      expect(part.text).toBe("[info] hello world")
    })

    it("creates new message if no current exists", () => {
      WorkflowSessionWriter.appendLog(sid, "warn", "oops")
      // Should emit Updated + PartUpdated
      expect(calls.length).toBe(2)
      expect(calls[0].def).toBe(MessageV2.Event.Updated)
      expect(calls[1].def).toBe(MessageV2.Event.PartUpdated)
    })

    it("creates new message if session differs", () => {
      const other = SessionID.make("session_test-writer-002")
      WorkflowSessionWriter.writePhase(sid, "x")
      calls.length = 0
      WorkflowSessionWriter.appendLog(other, "error", "bad")
      // New session → new message
      expect(calls.length).toBe(2)
      expect(calls[0].def).toBe(MessageV2.Event.Updated)
    })
  })

  describe("writeTool", () => {
    it("emits a tool part with correct state shape", () => {
      WorkflowSessionWriter.writePhase(sid, "exec")
      calls.length = 0
      WorkflowSessionWriter.writeTool(sid, {
        tool: "bash",
        args: { command: "ls" },
        output: "file.txt",
        title: "ls",
        duration: 50,
      })
      expect(calls.length).toBe(1)
      expect(calls[0].def).toBe(MessageV2.Event.PartUpdated)
      const part = (calls[0].data as any).part
      expect(part.type).toBe("tool")
      expect(part.tool).toBe("bash")
      expect(part.state.status).toBe("completed")
      expect(part.state.input).toEqual({ command: "ls" })
      expect(part.state.output).toBe("file.txt")
      expect(part.state.title).toBe("ls")
      expect(part.state.time.end - part.state.time.start).toBe(50)
    })
  })

  describe("writeStatus", () => {
    it("writes completed status", () => {
      WorkflowSessionWriter.writeStatus(sid, "completed")
      expect(calls.length).toBe(2)
      const part = (calls[1].data as any).part
      expect(part.text).toContain("completed successfully")
    })

    it("writes failed status with error", () => {
      WorkflowSessionWriter.writeStatus(sid, "failed", "timeout exceeded")
      expect(calls.length).toBe(2)
      const part = (calls[1].data as any).part
      expect(part.text).toContain("failed")
      expect(part.text).toContain("timeout exceeded")
    })
  })

  describe("reset", () => {
    it("clears current message state", () => {
      WorkflowSessionWriter.writePhase(sid, "a")
      WorkflowSessionWriter.reset()
      calls.length = 0
      // After reset, appendLog should create new message
      WorkflowSessionWriter.appendLog(sid, "info", "after reset")
      expect(calls.length).toBe(2) // Updated + PartUpdated
    })
  })

  describe("message shape", () => {
    it("creates assistant message with workflow provider", () => {
      WorkflowSessionWriter.writePhase(sid, "test")
      const msg = (calls[0].data as any).info
      expect(msg.role).toBe("assistant")
      expect(msg.providerID).toBe("workflow")
      expect(msg.modelID).toBe("workflow")
      expect(msg.mode).toBe("workflow")
      expect(msg.cost).toBe(0)
      expect(msg.tokens.input).toBe(0)
      expect(msg.tokens.output).toBe(0)
    })
  })
})
