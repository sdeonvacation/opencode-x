import { afterEach, describe, expect, mock, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { Goal } from "../../src/goal/goal"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  mock.restore()
  await Instance.disposeAll()
})

describe("session goal route", () => {
  test("POST /:sessionID/goal creates a goal", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default().app

        const res = await app.request(`/session/${session.id}/goal`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ objective: "fix the login bug" }),
        })

        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.id).toStartWith("goal_")
        expect(body.session_id).toBe(session.id)
        expect(body.objective).toBe("fix the login bug")
        expect(body.status).toBe("active")
        expect(body.tokens_used).toBe(0)
        expect(body.turns_used).toBe(0)

        const stored = Goal.get(session.id)
        expect(stored).not.toBeNull()
        expect(stored!.objective).toBe("fix the login bug")

        await Session.remove(session.id)
      },
    })
  })

  test("POST /:sessionID/goal returns 400 for missing objective", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const app = Server.Default().app

        const res = await app.request(`/session/${session.id}/goal`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })

        expect(res.status).toBe(400)

        await Session.remove(session.id)
      },
    })
  })

  test("POST /:sessionID/goal with invalid sessionID returns 400", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app

        const res = await app.request(`/session/invalid/goal`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ objective: "test" }),
        })

        expect(res.status).toBe(400)
      },
    })
  })
})
