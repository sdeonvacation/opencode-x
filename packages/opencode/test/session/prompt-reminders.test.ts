import { expect, test } from "bun:test"
import { Effect } from "effect"

import { Instance } from "../../src/project/instance"
import { ProjectID } from "../../src/project/schema"
import { Agent } from "../../src/agent/agent"
import { Flag } from "../../src/flag/flag"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import BUILD_SWITCH from "../../src/session/prompt/build-switch.txt"
import PROMPT_PLAN from "../../src/session/prompt/plan.txt"
import { insertReminders } from "../../src/session/prompt-reminders"
import { MessageID, SessionID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

function makeSession(): Session.Info {
  return {
    id: SessionID.make("session_test"),
    slug: "reminders",
    projectID: ProjectID.make("project_test"),
    directory: "/tmp",
    title: "Test",
    version: "1",
    time: { created: 1, updated: 1 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

function makeUser(sessionID: SessionID): MessageV2.WithParts {
  return {
    info: {
      id: MessageID.ascending(),
      sessionID,
      role: "user",
      agent: "build",
      model: ref,
      time: { created: Date.now() },
    },
    parts: [],
  }
}

function makeAssistant(sessionID: SessionID, agent: string): MessageV2.WithParts {
  return {
    info: {
      id: MessageID.ascending(),
      sessionID,
      role: "assistant",
      parentID: MessageID.ascending(),
      mode: agent,
      agent,
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      time: { created: Date.now() },
    },
    parts: [],
  }
}

function withPlanMode<T>(value: boolean, fn: () => Promise<T>) {
  const prev = (Flag as any).OPENCODE_EXPERIMENTAL_PLAN_MODE
  ;(Flag as any).OPENCODE_EXPERIMENTAL_PLAN_MODE = value
  return fn().finally(() => {
    ;(Flag as any).OPENCODE_EXPERIMENTAL_PLAN_MODE = prev
  })
}

function run(input: Parameters<typeof insertReminders>[1], options?: { exists?: boolean }) {
  const updatePartCalls: MessageV2.Part[] = []
  const ensured: string[] = []
  return Effect.runPromise(
    insertReminders(
      {
        sessions: {
          updatePart(part) {
            updatePartCalls.push(part)
            return Effect.succeed(part)
          },
        },
        fsys: {
          existsSafe: () => Effect.succeed(options?.exists ?? false),
          ensureDir: (dir) => {
            ensured.push(dir)
            return Effect.void
          },
        },
      },
      input,
    ),
  ).then((result) => ({ result, updatePartCalls, ensured }))
}

test("insertReminders injects plan reminder for plan agent", async () => {
  await withPlanMode(false, async () => {
    const session = makeSession()
    const user = makeUser(session.id)
    const { result } = await run({
      messages: [user],
      agent: { name: "plan" } as Agent.Info,
      session,
    })

    expect(result.changed).toBe(true)
    const part = user.parts.at(-1)
    expect(part?.type).toBe("text")
    if (!part || part.type !== "text") return
    expect(part.text).toBe(PROMPT_PLAN)
  })
})

test("insertReminders injects build switch after plan response", async () => {
  await withPlanMode(false, async () => {
    const session = makeSession()
    const user = makeUser(session.id)
    const assistant = makeAssistant(session.id, "plan")
    const { result } = await run({
      messages: [assistant, user],
      agent: { name: "build" } as Agent.Info,
      session,
    })

    expect(result.changed).toBe(true)
    const part = user.parts.at(-1)
    expect(part?.type).toBe("text")
    if (!part || part.type !== "text") return
    expect(part.text).toBe(BUILD_SWITCH)
  })
})

test("insertReminders leaves unrelated agents unchanged", async () => {
  await withPlanMode(false, async () => {
    const session = makeSession()
    const user = makeUser(session.id)
    const { result } = await run({
      messages: [user],
      agent: { name: "general" } as Agent.Info,
      session,
    })

    expect(result.changed).toBe(false)
    expect(user.parts).toHaveLength(0)
  })
})

test("insertReminders injects build switch via persisted part when plan file exists", async () => {
  await withPlanMode(true, async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = makeSession()
        const user = makeUser(session.id)
        const assistant = makeAssistant(session.id, "plan")
        const { result, updatePartCalls } = await run(
          {
            messages: [assistant, user],
            agent: { name: "build" } as Agent.Info,
            session,
          },
          { exists: true },
        )

        expect(result.changed).toBe(true)
        expect(updatePartCalls).toHaveLength(1)
        const part = updatePartCalls[0]
        expect(part.type).toBe("text")
        if (part.type !== "text") return
        expect(part.text).toContain(BUILD_SWITCH)
        expect(part.text).toContain(Session.plan(session))
      },
    })
  })
})

test("insertReminders creates plan reminder and ensures plan directory in experimental mode", async () => {
  await withPlanMode(true, async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = makeSession()
        const user = makeUser(session.id)
        const { result, updatePartCalls, ensured } = await run(
          {
            messages: [user],
            agent: { name: "plan" } as Agent.Info,
            session,
          },
          { exists: false },
        )

        expect(result.changed).toBe(true)
        expect(updatePartCalls).toHaveLength(1)
        const part = updatePartCalls[0]
        if (part.type !== "text") return
        expect(part.text).toContain("<system-reminder>")
        expect(part.text).toContain(Session.plan(session))
        expect(ensured).toHaveLength(1)
      },
    })
  })
})
