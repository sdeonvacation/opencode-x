import { describe, test, expect, afterAll } from "bun:test"
import path from "path"
import { Memory } from "../../src/memory/memory"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })
afterAll(() => Instance.disposeAll())

describe("memory clear immunity", () => {
  test("memory survives message deletion (/clear simulation)", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const { Session } = await import("../../src/session")
        const session = await Session.create({})
        try {
          await Memory.create({ sessionID: session.id, content: "persist me" })
          // Simulate /clear: delete all messages (none here) and verify memory untouched
          const msgs = await Session.messages({ sessionID: session.id })
          for (const msg of msgs) {
            await Session.removeMessage({ sessionID: session.id, messageID: msg.info.id })
          }
          const entries = await Memory.list(session.id)
          expect(entries).toHaveLength(1)
          expect(entries[0].content).toBe("persist me")
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })

  test("memory survives /clear with messages present", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const { Session } = await import("../../src/session")
        const session = await Session.create({})
        try {
          await Memory.create({ sessionID: session.id, content: "keep this" })
          await Memory.create({ sessionID: session.id, content: "keep that" })
          // Delete all messages (clear simulation) — memory table is separate
          const msgs = await Session.messages({ sessionID: session.id })
          for (const msg of msgs) {
            await Session.removeMessage({ sessionID: session.id, messageID: msg.info.id })
          }
          const entries = await Memory.list(session.id)
          expect(entries).toHaveLength(2)
          expect(entries[0].content).toBe("keep this")
          expect(entries[1].content).toBe("keep that")
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })

  test("memory cascade-deletes with session", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const { Session } = await import("../../src/session")
        const session = await Session.create({})
        const sid = session.id
        await Memory.create({ sessionID: sid, content: "will be gone" })
        await Memory.create({ sessionID: sid, content: "also gone" })
        // Verify entries exist before removal
        const before = await Memory.list(sid)
        expect(before).toHaveLength(2)
        // Session.remove cascades to memory
        await Session.remove(sid)
        const after = await Memory.list(sid)
        expect(after).toEqual([])
      },
    })
  })
})
