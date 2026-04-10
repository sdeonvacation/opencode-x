import { afterEach, describe, expect, test } from "bun:test"
import { Bus } from "../../src/bus"
import { Permission } from "../../src/permission"
import { PermissionID } from "../../src/permission/schema"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

async function nextEvent(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder()
  let buf = ""
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) return undefined
    buf += decoder.decode(chunk.value, { stream: true })
    const split = buf.indexOf("\n\n")
    if (split === -1) continue
    const block = buf.slice(0, split)
    buf = buf.slice(split + 2)
    const line = block
      .split("\n")
      .find((item) => item.startsWith("data:"))
      ?.replace(/^data:\s*/, "")
    if (!line) continue
    return JSON.parse(line) as { type: string; properties: Record<string, unknown> }
  }
}

async function takeEvents(reader: ReadableStreamDefaultReader<Uint8Array>, count: number) {
  const out: { type: string; properties: Record<string, unknown> }[] = []
  while (out.length < count) {
    const evt = await nextEvent(reader)
    if (!evt) break
    out.push(evt)
  }
  return out
}

describe("server/event SSE perf proxies", () => {
  test("session+type filters deliver only relevant/control events under noisy bus traffic", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const wanted = SessionID.make("session_perf_match")
        const other = SessionID.make("session_perf_other")

        const res = await app.request(
          `/event?directory=${encodeURIComponent(tmp.path)}&sessionID=${wanted}&types=permission`,
        )
        expect(res.status).toBe(200)
        const reader = res.body!.getReader()

        await nextEvent(reader)

        for (let i = 0; i < 30; i++) {
          await Bus.publish(MessageV2.Event.PartDelta, {
            sessionID: other,
            messageID: MessageID.make(`msg_skip_${i}`),
            partID: PartID.make(`part_skip_${i}`),
            field: "text",
            delta: `skip_${i}`,
          })
        }

        await Bus.publish(SessionStatus.Event.Status, { sessionID: wanted, status: { type: "idle" } })
        await Bus.publish(Permission.Event.Asked, {
          id: PermissionID.make("perm_match_1"),
          sessionID: wanted,
          permission: "bash",
          patterns: ["*"],
          metadata: {},
          always: ["*"],
        })
        await Bus.publish(Permission.Event.Asked, {
          id: PermissionID.make("perm_match_2"),
          sessionID: wanted,
          permission: "read",
          patterns: ["*"],
          metadata: {},
          always: ["*"],
        })

        const observed = await takeEvents(reader, 3)
        expect(observed.map((evt) => evt.type)).toEqual(["session.status", "permission.asked", "permission.asked"])
        expect(observed.filter((evt) => evt.type === "message.part.delta")).toHaveLength(0)
      },
    })
  })

  test("without filters stream delivers all published events (baseline count)", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const sessionID = SessionID.make("session_perf_all")

        const res = await app.request(`/event?directory=${encodeURIComponent(tmp.path)}`)
        expect(res.status).toBe(200)
        const reader = res.body!.getReader()

        await nextEvent(reader)

        for (let i = 0; i < 5; i++) {
          await Bus.publish(MessageV2.Event.PartDelta, {
            sessionID,
            messageID: MessageID.make(`msg_all_${i}`),
            partID: PartID.make(`part_all_${i}`),
            field: "text",
            delta: `delta_${i}`,
          })
        }
        await Bus.publish(Permission.Event.Asked, {
          id: PermissionID.make("perm_all"),
          sessionID,
          permission: "bash",
          patterns: ["*"],
          metadata: {},
          always: ["*"],
        })

        const observed = await takeEvents(reader, 6)
        expect(observed).toHaveLength(6)
        expect(observed.filter((evt) => evt.type === "message.part.delta")).toHaveLength(5)
        expect(observed.filter((evt) => evt.type === "permission.asked")).toHaveLength(1)
      },
    })
  })
})
