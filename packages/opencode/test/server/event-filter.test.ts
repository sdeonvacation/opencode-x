import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Bus } from "../../src/bus"
import { Permission } from "../../src/permission"
import { PermissionID } from "../../src/permission/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionStatus } from "../../src/session/status"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
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

describe("server/event filter", () => {
  test("filters by sessionID query when provided", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const wanted = SessionID.make("session_wanted")
        const other = SessionID.make("session_other")

        const res = await app.request(`/event?directory=${encodeURIComponent(tmp.path)}&sessionID=${wanted}`)
        expect(res.status).toBe(200)
        const reader = res.body!.getReader()

        await nextEvent(reader)

        await Bus.publish(MessageV2.Event.PartDelta, {
          sessionID: other,
          messageID: MessageID.make("message_1"),
          partID: PartID.make("part_1"),
          field: "text",
          delta: "a",
        })
        await Bus.publish(MessageV2.Event.PartDelta, {
          sessionID: wanted,
          messageID: MessageID.make("message_2"),
          partID: PartID.make("part_2"),
          field: "text",
          delta: "b",
        })

        const evt = await nextEvent(reader)
        expect(evt?.type).toBe("message.part.delta")
        expect(evt?.properties.sessionID).toBe(wanted)
      },
    })
  })

  test("filters by type prefix query when provided", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const sessionID = SessionID.make("session_any")

        const res = await app.request(`/event?directory=${encodeURIComponent(tmp.path)}&types=permission`)
        expect(res.status).toBe(200)
        const reader = res.body!.getReader()

        await nextEvent(reader)

        await Bus.publish(MessageV2.Event.PartDelta, {
          sessionID,
          messageID: MessageID.make("message_3"),
          partID: PartID.make("part_3"),
          field: "text",
          delta: "skip",
        })
        await Bus.publish(Permission.Event.Asked, {
          id: PermissionID.make("permission_1"),
          sessionID,
          permission: "bash",
          patterns: ["*"],
          metadata: {},
          always: ["*"],
        })

        const evt = await nextEvent(reader)
        expect(evt?.type).toBe("permission.asked")
      },
    })
  })

  test("control events bypass type filters", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const sessionID = SessionID.make("session_any_3")

        const res = await app.request(`/event?directory=${encodeURIComponent(tmp.path)}&types=permission`)
        expect(res.status).toBe(200)
        const reader = res.body!.getReader()

        await nextEvent(reader)
        await Bus.publish(SessionStatus.Event.Status, { sessionID, status: { type: "idle" } })

        const evt = await nextEvent(reader)
        expect(evt?.type).toBe("session.status")
      },
    })
  })

  test("without filters preserves default behavior", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const sessionID = SessionID.make("session_any_2")

        const res = await app.request(`/event?directory=${encodeURIComponent(tmp.path)}`)
        expect(res.status).toBe(200)
        const reader = res.body!.getReader()

        await nextEvent(reader)
        await Bus.publish(MessageV2.Event.PartDelta, {
          sessionID,
          messageID: MessageID.make("message_4"),
          partID: PartID.make("part_4"),
          field: "text",
          delta: "ok",
        })
        const evt = await nextEvent(reader)
        expect(evt?.type).toBe("message.part.delta")
      },
    })
  })

  test("session and type filters avoid queueing irrelevant events", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const wanted = SessionID.make("session_match")
        const other = SessionID.make("session_other_many")

        const res = await app.request(
          `/event?directory=${encodeURIComponent(tmp.path)}&sessionID=${wanted}&types=permission`,
        )
        expect(res.status).toBe(200)
        const reader = res.body!.getReader()

        await nextEvent(reader)

        for (let i = 0; i < 20; i++) {
          await Bus.publish(MessageV2.Event.PartDelta, {
            sessionID: other,
            messageID: MessageID.make(`message_skip_${i}`),
            partID: PartID.make(`part_skip_${i}`),
            field: "text",
            delta: `skip_${i}`,
          })
        }

        await Bus.publish(Permission.Event.Asked, {
          id: PermissionID.make("permission_match"),
          sessionID: wanted,
          permission: "bash",
          patterns: ["*"],
          metadata: {},
          always: ["*"],
        })

        const evt = await nextEvent(reader)
        expect(evt?.type).toBe("permission.asked")
        expect(evt?.properties.sessionID).toBe(wanted)
      },
    })
  })
})
