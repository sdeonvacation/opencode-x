import { describe, expect, test } from "bun:test"
import path from "path"
import { Session } from "../../src/session"
import { Instance } from "../../src/project/instance"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("session cost projector", () => {
  test(
    "session.cost updated after PartUpdated step-finish event",
    async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const session = await Session.create({})

          const messageID = MessageID.ascending()
          await Session.updateMessage({
            id: messageID,
            sessionID: session.id,
            role: "user",
            time: { created: Date.now() },
            agent: "user",
            model: { providerID: "test", modelID: "test" },
            tools: {},
            mode: "",
          } as unknown as MessageV2.Info)

          await Session.updatePart({
            id: PartID.ascending(),
            messageID,
            sessionID: session.id,
            type: "step-finish" as const,
            reason: "stop",
            cost: 0.005,
            tokens: {
              total: 100,
              input: 50,
              output: 40,
              reasoning: 10,
              cache: { read: 0, write: 0 },
            },
          })

          await new Promise((resolve) => setTimeout(resolve, 100))

          const updated = await Session.get(session.id)
          expect(updated.cost).toBeGreaterThanOrEqual(0.005)

          await Session.remove(session.id)
        },
      })
    },
    { timeout: 30000 },
  )
})
