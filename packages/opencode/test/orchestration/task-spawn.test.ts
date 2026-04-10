import { describe, expect, test, mock, afterEach, spyOn } from "bun:test"
import { spawnSubagent, type SpawnSubagentInput } from "../../src/orchestration/task-spawn"
import { SpawnLimitError, type SpawnReservation } from "../../src/orchestration/spawn-limits"
import { Agent } from "../../src/agent/agent"
import { ProjectID } from "../../src/project/schema"
import * as SessionModule from "../../src/session"
import * as BusModule from "../../src/bus"
import * as SpawnLimitsModule from "../../src/orchestration/spawn-limits"
import { Permission } from "../../src/permission"
import type { Session } from "../../src/session"
import type { SessionID } from "../../src/session/schema"

type PermissionRule = Permission.Rule
type SessionCreate = typeof SessionModule.Session.create

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSessionID(id: string): SessionID {
  return id as unknown as SessionID
}

function makeSession(id: string): Session.Info {
  return {
    id: makeSessionID(id),
    slug: `slug-${id}`,
    projectID: ProjectID.make("project-test"),
    directory: "/tmp",
    title: "test session",
    version: "1",
    permission: [],
    time: { created: Date.now(), updated: Date.now() },
  }
}

function makeInput(overrides: Partial<SpawnSubagentInput> = {}): SpawnSubagentInput {
  return {
    parentSessionID: makeSessionID("parent-session"),
    agent: { name: "explore", permission: [], mode: "subagent", options: {} } satisfies Agent.Info,
    description: "Explore the codebase",
    canTask: false,
    canTodo: false,
    taskPermissionID: "task",
    maxDepth: 3,
    maxDescendants: 50,
    ...overrides,
  }
}

function mockSessionCreate(fn: SessionCreate["force"]): SessionCreate {
  return Object.assign(((input) => fn(input)) as SessionCreate["force"], {
    force: fn,
    schema: SessionModule.Session.create.schema,
  }) as SessionCreate
}

// ---------------------------------------------------------------------------
// Mocks — we mock the heavy dependencies at module level
// ---------------------------------------------------------------------------

// We need to mock Session.create and Bus.publish.
// Since these are namespace exports we patch them directly.

afterEach(() => {
  mock.restore()
})

describe("orchestration/task-spawn", () => {
  test("returns existing session without spawning when existing is provided", async () => {
    const existing = makeSession("existing-session")
    const result = await spawnSubagent(existing, makeInput())
    expect(result.spawned).toBe(false)
    expect(result.session).toBe(existing)
  })

  test("calls reserveSpawn and Session.create when no existing session", async () => {
    const newSession = makeSession("new-session")
    const spawnInfo = { depth: 1, rootSessionID: "root", release: mock(() => {}) } satisfies SpawnReservation

    const reserveSpawnMock = spyOn(SpawnLimitsModule, "reserveSpawn").mockResolvedValue(spawnInfo)
    const createMock = spyOn(SessionModule.Session, "create").mockImplementation(
      mockSessionCreate(async () => newSession),
    )
    const publishMock = spyOn(BusModule.Bus, "publish").mockResolvedValue()

    const result = await spawnSubagent(undefined, makeInput())
    expect(result.spawned).toBe(true)
    expect(result.session).toBe(newSession)
    expect(reserveSpawnMock).toHaveBeenCalledTimes(1)
    expect(createMock).toHaveBeenCalledTimes(1)
    expect(publishMock).toHaveBeenCalledTimes(1)
  })

  test("SpawnLimitError publishes SpawnRejected event and re-throws", async () => {
    const limitErr = new SpawnLimitError("max_depth", 3, 3)
    const publishMock = spyOn(BusModule.Bus, "publish").mockResolvedValue()

    spyOn(SpawnLimitsModule, "reserveSpawn").mockImplementation(async (_input) => {
      throw limitErr
    })

    await expect(spawnSubagent(undefined, makeInput())).rejects.toThrow(SpawnLimitError)
    expect(publishMock).toHaveBeenCalledTimes(1)
  })

  test("non-SpawnLimitError does not publish SpawnRejected", async () => {
    const genericErr = new Error("network error")
    const publishMock = spyOn(BusModule.Bus, "publish").mockResolvedValue()

    spyOn(SpawnLimitsModule, "reserveSpawn").mockImplementation(async (_input) => {
      throw genericErr
    })

    await expect(spawnSubagent(undefined, makeInput())).rejects.toThrow("network error")
    expect(publishMock).not.toHaveBeenCalled()
  })

  test("session creation failure releases spawn reservation and re-throws", async () => {
    const releaseMock = mock(() => {})
    const spawnInfo = { depth: 1, rootSessionID: "root", release: releaseMock } satisfies SpawnReservation
    const createErr = new Error("db error")

    spyOn(SpawnLimitsModule, "reserveSpawn").mockResolvedValue(spawnInfo)
    spyOn(SessionModule.Session, "create").mockImplementation(
      mockSessionCreate(async () => {
        throw createErr
      }),
    )
    spyOn(BusModule.Bus, "publish").mockResolvedValue()

    await expect(spawnSubagent(undefined, makeInput())).rejects.toThrow("db error")
    expect(releaseMock).toHaveBeenCalledTimes(1)
  })

  test("canTodo=false adds todowrite deny rule", async () => {
    const newSession = makeSession("new-session")
    const spawnInfo = { depth: 1, rootSessionID: "root", release: mock(() => {}) } satisfies SpawnReservation
    let capturedPermission: PermissionRule[] = []

    spyOn(SpawnLimitsModule, "reserveSpawn").mockResolvedValue(spawnInfo)
    spyOn(SessionModule.Session, "create").mockImplementation(
      mockSessionCreate(async (input) => {
        capturedPermission = input?.permission ?? []
        return newSession
      }),
    )
    spyOn(BusModule.Bus, "publish").mockResolvedValue()

    await spawnSubagent(undefined, makeInput({ canTodo: false }))
    expect(capturedPermission.some((r) => r.permission === "todowrite" && r.action === "deny")).toBe(true)
  })

  test("canTodo=true omits todowrite deny rule", async () => {
    const newSession = makeSession("new-session")
    const spawnInfo = { depth: 1, rootSessionID: "root", release: mock(() => {}) } satisfies SpawnReservation
    let capturedPermission: PermissionRule[] = []

    spyOn(SpawnLimitsModule, "reserveSpawn").mockResolvedValue(spawnInfo)
    spyOn(SessionModule.Session, "create").mockImplementation(
      mockSessionCreate(async (input) => {
        capturedPermission = input?.permission ?? []
        return newSession
      }),
    )
    spyOn(BusModule.Bus, "publish").mockResolvedValue()

    await spawnSubagent(undefined, makeInput({ canTodo: true }))
    expect(capturedPermission.some((r) => r.permission === "todowrite")).toBe(false)
  })
})
