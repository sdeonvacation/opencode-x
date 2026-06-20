import { describe, test, expect, afterAll } from "bun:test"
import path from "path"
import { Memory, MemoryID } from "../../src/memory/memory"
import { SessionID } from "../../src/session/schema"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })
afterAll(() => Instance.disposeAll())

describe("MemoryID", () => {
  test("generate returns a string branded as MemoryID", () => {
    const id = MemoryID.generate()
    expect(typeof id).toBe("string")
    expect(id.length).toBeGreaterThan(0)
  })

  test("generate returns unique IDs", () => {
    const a = MemoryID.generate()
    const b = MemoryID.generate()
    expect(a).not.toBe(b)
  })

  test("zod schema parses a string as MemoryID", () => {
    const result = MemoryID.zod.safeParse("some-id")
    expect(result.success).toBe(true)
  })

  test("zod schema rejects non-string", () => {
    const result = MemoryID.zod.safeParse(42)
    expect(result.success).toBe(false)
  })
})

describe("Memory.Info schema", () => {
  test("parses valid entry", () => {
    const result = Memory.Info.safeParse({
      id: "abc",
      session_id: "ses_test",
      content: "remember this",
      position: 0,
    })
    expect(result.success).toBe(true)
  })

  test("rejects missing content", () => {
    const result = Memory.Info.safeParse({
      id: "abc",
      session_id: "ses_test",
      position: 0,
    })
    expect(result.success).toBe(false)
  })

  test("rejects non-integer position", () => {
    const result = Memory.Info.safeParse({
      id: "abc",
      session_id: "ses_test",
      content: "x",
      position: 1.5,
    })
    expect(result.success).toBe(false)
  })
})

describe("Memory.Event.Updated", () => {
  test("has correct event type", () => {
    expect(Memory.Event.Updated.type).toBe("memory.updated")
  })

  test("properties schema validates correct payload", () => {
    const result = Memory.Event.Updated.properties.safeParse({
      sessionID: "ses_test",
      entries: [],
    })
    expect(result.success).toBe(true)
  })
})

describe("Memory service", () => {
  test("list returns empty array for new session", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const sid = SessionID.make("ses_mem_test_list")
        const entries = await Memory.list(sid)
        expect(entries).toEqual([])
      },
    })
  })

  test("create adds an entry and returns it", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const { Session } = await import("../../src/session")
        const session = await Session.create({})
        try {
          const entry = await Memory.create({ sessionID: session.id, content: "test memory" })
          expect(entry.content).toBe("test memory")
          expect(entry.session_id).toBe(session.id)
          expect(entry.position).toBe(0)
          expect(typeof entry.id).toBe("string")
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })

  test("list returns entries ordered by position", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const { Session } = await import("../../src/session")
        const session = await Session.create({})
        try {
          await Memory.create({ sessionID: session.id, content: "first" })
          await Memory.create({ sessionID: session.id, content: "second" })
          await Memory.create({ sessionID: session.id, content: "third" })
          const entries = await Memory.list(session.id)
          expect(entries).toHaveLength(3)
          expect(entries[0].content).toBe("first")
          expect(entries[1].content).toBe("second")
          expect(entries[2].content).toBe("third")
          expect(entries[0].position).toBe(0)
          expect(entries[1].position).toBe(1)
          expect(entries[2].position).toBe(2)
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })

  test("update changes content of existing entry", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const { Session } = await import("../../src/session")
        const session = await Session.create({})
        try {
          const entry = await Memory.create({ sessionID: session.id, content: "original" })
          const updated = await Memory.update({ id: entry.id, sessionID: session.id, content: "updated" })
          expect(updated.content).toBe("updated")
          expect(updated.id).toBe(entry.id)
          expect(updated.position).toBe(entry.position)
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })

  test("update throws for non-existent ID", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const id = MemoryID.generate()
        const fakeSessionID = "ses_fake" as import("../../src/session/schema").SessionID
        await expect(Memory.update({ id, sessionID: fakeSessionID, content: "x" })).rejects.toThrow(
          `Memory ${id} not found`,
        )
      },
    })
  })

  test("remove deletes an entry", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const { Session } = await import("../../src/session")
        const session = await Session.create({})
        try {
          const entry = await Memory.create({ sessionID: session.id, content: "to delete" })
          await Memory.remove({ id: entry.id, sessionID: session.id })
          const entries = await Memory.list(session.id)
          expect(entries).toHaveLength(0)
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })

  test("remove repacks positions after deletion", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const { Session } = await import("../../src/session")
        const session = await Session.create({})
        try {
          const a = await Memory.create({ sessionID: session.id, content: "a" })
          await Memory.create({ sessionID: session.id, content: "b" })
          const c = await Memory.create({ sessionID: session.id, content: "c" })
          // remove middle entry
          await Memory.remove({ id: a.id, sessionID: session.id })
          const entries = await Memory.list(session.id)
          expect(entries).toHaveLength(2)
          expect(entries[0].position).toBe(0)
          expect(entries[1].position).toBe(1)
          expect(entries[1].id).toBe(c.id)
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })

  test("remove throws for non-existent ID", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const id = MemoryID.generate()
        const fakeSessionID = "ses_fake" as import("../../src/session/schema").SessionID
        await expect(Memory.remove({ id, sessionID: fakeSessionID })).rejects.toThrow(`Memory ${id} not found`)
      },
    })
  })

  test("create enforces 20-entry cap", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const { Session } = await import("../../src/session")
        const session = await Session.create({})
        try {
          for (let i = 0; i < 20; i++) {
            await Memory.create({ sessionID: session.id, content: `entry ${i}` })
          }
          await expect(Memory.create({ sessionID: session.id, content: "overflow" })).rejects.toThrow(
            "Session memory cap of 20 reached",
          )
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })

  test("create publishes memory.updated event", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const { Session } = await import("../../src/session")
        const { Bus } = await import("../../src/bus")
        const session = await Session.create({})
        try {
          let fired = false
          const unsub = Bus.subscribe(Memory.Event.Updated, (evt) => {
            fired = true
            expect(evt.properties.sessionID).toBe(session.id)
            expect(evt.properties.entries).toHaveLength(1)
          })
          await Memory.create({ sessionID: session.id, content: "event test" })
          await new Promise((r) => setTimeout(r, 50))
          unsub()
          expect(fired).toBe(true)
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })

  test("cascade delete removes memories when session deleted", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const { Session } = await import("../../src/session")
        const session = await Session.create({})
        await Memory.create({ sessionID: session.id, content: "will be deleted" })
        await Session.remove(session.id)
        // After session removal, listing should return empty (FK cascade)
        const entries = await Memory.list(session.id)
        expect(entries).toEqual([])
      },
    })
  })
})
