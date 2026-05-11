import { afterEach, describe, expect, test } from "bun:test"
import { Session } from "../../src/session"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

describe("memory routes", () => {
  describe("GET /:sessionID/memory", () => {
    test("returns empty array for session with no entries", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const app = Server.Default().app
          const res = await app.request(`/session/${session.id}/memory`)
          expect(res.status).toBe(200)
          const body = await res.json()
          expect(body).toEqual([])
          await Session.remove(session.id)
        },
      })
    })
  })

  describe("POST /:sessionID/memory", () => {
    test("creates a memory entry and returns it", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const app = Server.Default().app
          const res = await app.request(`/session/${session.id}/memory`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "remember this" }),
          })
          expect(res.status).toBe(200)
          const body = await res.json()
          expect(body.content).toBe("remember this")
          expect(body.session_id).toBe(session.id)
          expect(typeof body.id).toBe("string")
          expect(body.position).toBe(0)
          await Session.remove(session.id)
        },
      })
    })

    test("returns 400 for empty content", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const app = Server.Default().app
          const res = await app.request(`/session/${session.id}/memory`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "" }),
          })
          expect(res.status).toBe(400)
          await Session.remove(session.id)
        },
      })
    })

    test("list returns created entries in order", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const app = Server.Default().app
          await app.request(`/session/${session.id}/memory`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "first" }),
          })
          await app.request(`/session/${session.id}/memory`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "second" }),
          })
          const res = await app.request(`/session/${session.id}/memory`)
          expect(res.status).toBe(200)
          const body = await res.json()
          expect(body).toHaveLength(2)
          expect(body[0].content).toBe("first")
          expect(body[1].content).toBe("second")
          await Session.remove(session.id)
        },
      })
    })
  })

  describe("PUT /:sessionID/memory/:memoryID", () => {
    test("updates content of existing entry", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const app = Server.Default().app
          const create = await app.request(`/session/${session.id}/memory`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "original" }),
          })
          const entry = await create.json()
          const res = await app.request(`/session/${session.id}/memory/${entry.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "updated" }),
          })
          expect(res.status).toBe(200)
          const updated = await res.json()
          expect(updated.content).toBe("updated")
          expect(updated.id).toBe(entry.id)
          await Session.remove(session.id)
        },
      })
    })

    test("returns 404 for non-existent memoryID", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const app = Server.Default().app
          const res = await app.request(`/session/${session.id}/memory/nonexistent-id`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "updated" }),
          })
          expect(res.status).toBe(404)
          await Session.remove(session.id)
        },
      })
    })

    test("returns 400 for empty content", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const app = Server.Default().app
          const create = await app.request(`/session/${session.id}/memory`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "original" }),
          })
          const entry = await create.json()
          const res = await app.request(`/session/${session.id}/memory/${entry.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "" }),
          })
          expect(res.status).toBe(400)
          await Session.remove(session.id)
        },
      })
    })
  })

  describe("DELETE /:sessionID/memory/:memoryID", () => {
    test("deletes existing entry and returns true", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const app = Server.Default().app
          const create = await app.request(`/session/${session.id}/memory`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "to delete" }),
          })
          const entry = await create.json()
          const res = await app.request(`/session/${session.id}/memory/${entry.id}`, {
            method: "DELETE",
          })
          expect(res.status).toBe(200)
          const body = await res.json()
          expect(body).toBe(true)
          // verify gone
          const list = await app.request(`/session/${session.id}/memory`)
          const entries = await list.json()
          expect(entries).toHaveLength(0)
          await Session.remove(session.id)
        },
      })
    })

    test("returns 404 for non-existent memoryID", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const app = Server.Default().app
          const res = await app.request(`/session/${session.id}/memory/nonexistent-id`, {
            method: "DELETE",
          })
          expect(res.status).toBe(404)
          await Session.remove(session.id)
        },
      })
    })

    test("repacks positions after delete", async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})
          const app = Server.Default().app
          const c1 = await (
            await app.request(`/session/${session.id}/memory`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: "first" }),
            })
          ).json()
          await app.request(`/session/${session.id}/memory`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "second" }),
          })
          // delete first entry
          await app.request(`/session/${session.id}/memory/${c1.id}`, { method: "DELETE" })
          const list = await app.request(`/session/${session.id}/memory`)
          const entries = await list.json()
          expect(entries).toHaveLength(1)
          expect(entries[0].content).toBe("second")
          expect(entries[0].position).toBe(0)
          await Session.remove(session.id)
        },
      })
    })
  })
})
