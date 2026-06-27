import { afterEach, describe, expect, mock, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { Loop } from "../../src/loop/loop"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  mock.restore()
  await Instance.disposeAll()
})

describe("session loop routes", () => {
  test("POST /:sessionID/loop creates a loop", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default().app

        const res = await app.request(`/session/${session.id}/loop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "check for errors", interval_ms: 120000 }),
        })

        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.id).toStartWith("loop_")
        expect(body.session_id).toBe(session.id)
        expect(body.prompt).toBe("check for errors")
        expect(body.interval_ms).toBe(120000)
        expect(body.status).toBe("active")
        expect(body.tokens_used).toBe(0)
        expect(body.iteration_count).toBe(0)
        expect(body.model).toBeNull()
        expect(body.token_budget).toBeNull()

        await Session.remove(session.id)
      },
    })
  })

  test("POST /:sessionID/loop with model and token_budget", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default().app

        const res = await app.request(`/session/${session.id}/loop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: "run tests",
            interval_ms: 300000,
            model: "anthropic/claude-sonnet-4-20250514",
            token_budget: 50000,
          }),
        })

        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.model).toBe("anthropic/claude-sonnet-4-20250514")
        expect(body.token_budget).toBe(50000)

        await Session.remove(session.id)
      },
    })
  })

  test("POST /:sessionID/loop returns 400 for interval below minimum", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default().app

        const res = await app.request(`/session/${session.id}/loop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "check", interval_ms: 5000 }),
        })

        expect(res.status).toBe(400)

        await Session.remove(session.id)
      },
    })
  })

  test("POST /:sessionID/loop returns 400 for missing prompt", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default().app

        const res = await app.request(`/session/${session.id}/loop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ interval_ms: 60000 }),
        })

        expect(res.status).toBe(400)

        await Session.remove(session.id)
      },
    })
  })

  test("GET /:sessionID/loops lists loops for session", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default().app

        Loop.create({ sessionID: session.id, prompt: "loop one", intervalMs: 60000 })
        Loop.create({ sessionID: session.id, prompt: "loop two", intervalMs: 120000 })

        const res = await app.request(`/session/${session.id}/loops`)
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toBeArrayOfSize(2)
        expect(body[0].prompt).toBe("loop one")
        expect(body[1].prompt).toBe("loop two")

        await Session.remove(session.id)
      },
    })
  })

  test("GET /:sessionID/loops returns empty array when no loops", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default().app

        const res = await app.request(`/session/${session.id}/loops`)
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body).toEqual([])

        await Session.remove(session.id)
      },
    })
  })

  test("DELETE /:sessionID/loop/:loopID cancels a loop", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default().app

        const loop = Loop.create({ sessionID: session.id, prompt: "to cancel", intervalMs: 60000 })

        const res = await app.request(`/session/${session.id}/loop/${loop.id}`, {
          method: "DELETE",
        })

        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.id).toBe(loop.id)
        expect(body.status).toBe("cancelled")

        const stored = Loop.get(loop.id)
        expect(stored).not.toBeNull()
        expect(stored!.status).toBe("cancelled")

        await Session.remove(session.id)
      },
    })
  })

  test("GET /:sessionID/loop/:loopID/iterations returns iteration info", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default().app

        const loop = Loop.create({ sessionID: session.id, prompt: "iterate", intervalMs: 60000 })

        const res = await app.request(`/session/${session.id}/loop/${loop.id}/iterations`)
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.id).toBe(loop.id)
        expect(body.iteration_count).toBe(0)
        expect(body.last_subagent_session_id).toBeNull()
        expect(body.status).toBe("active")
        expect(body.tokens_used).toBe(0)

        await Session.remove(session.id)
      },
    })
  })

  test("GET /:sessionID/loop/:loopID/iterations returns 404 for unknown loop", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default().app

        const res = await app.request(
          `/session/${session.id}/loop/loop_00000000-0000-0000-0000-000000000000/iterations`,
        )
        expect(res.status).toBe(404)

        await Session.remove(session.id)
      },
    })
  })
})
