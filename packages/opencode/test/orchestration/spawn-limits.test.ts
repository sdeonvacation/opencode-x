import { describe, expect, spyOn, test } from "bun:test"
import { Session } from "../../src/session"
import { SessionID } from "../../src/session/schema"
import {
  assertCanSpawn,
  getDepth,
  registerSpawn,
  reserveSpawn,
  releaseSpawn,
  SpawnLimitError,
} from "../../src/orchestration/spawn-limits"

describe("orchestration/spawn-limits", () => {
  test("returns depth zero when parent is undefined", async () => {
    const root = SessionID.make(`session_root_${crypto.randomUUID()}`)
    const result = await assertCanSpawn({
      sessionID: root,
      maxDepth: 3,
      maxDescendants: 2,
    })

    expect(result).toEqual({
      depth: 0,
      rootSessionID: String(root),
    })
  })

  test("walks parent chain to compute depth and root session", async () => {
    const root = SessionID.make(`session_root_${crypto.randomUUID()}`)
    const child = SessionID.make(`session_child_${crypto.randomUUID()}`)
    const grandchild = SessionID.make(`session_grandchild_${crypto.randomUUID()}`)
    const get = spyOn(Session, "get").mockImplementation((async (id: Parameters<typeof Session.get>[0]) => {
      if (id === grandchild) return { id: grandchild, parentID: child } as never
      if (id === child) return { id: child, parentID: root } as never
      if (id === root) return { id: root } as never
      throw new Error(`Unknown session ${id}`)
    }) as unknown as typeof Session.get)

    try {
      expect(await getDepth(grandchild)).toBe(2)
      await expect(
        assertCanSpawn({
          sessionID: root,
          parentID: grandchild,
          maxDepth: 3,
          maxDescendants: 10,
        }),
      ).resolves.toEqual({
        depth: 3,
        rootSessionID: String(root),
      })
    } finally {
      get.mockRestore()
    }
  })

  test("rejects when max depth is reached", async () => {
    const root = SessionID.make(`session_root_${crypto.randomUUID()}`)
    const level1 = SessionID.make(`session_level1_${crypto.randomUUID()}`)
    const level2 = SessionID.make(`session_level2_${crypto.randomUUID()}`)
    const level3 = SessionID.make(`session_level3_${crypto.randomUUID()}`)
    const get = spyOn(Session, "get").mockImplementation((async (id: Parameters<typeof Session.get>[0]) => {
      if (id === level3) return { id: level3, parentID: level2 } as never
      if (id === level2) return { id: level2, parentID: level1 } as never
      if (id === level1) return { id: level1, parentID: root } as never
      if (id === root) return { id: root } as never
      throw new Error(`Unknown session ${id}`)
    }) as unknown as typeof Session.get)

    try {
      await expect(
        assertCanSpawn({
          sessionID: root,
          parentID: level3,
          maxDepth: 3,
          maxDescendants: 10,
        }),
      ).rejects.toEqual(new SpawnLimitError("max_depth", 3, 3))
    } finally {
      get.mockRestore()
    }
  })

  test("enforces descendant limit and allows reuse after release", async () => {
    const root = `root_${crypto.randomUUID()}`
    registerSpawn(root)
    registerSpawn(root)

    await expect(
      assertCanSpawn({
        sessionID: SessionID.make(root),
        maxDepth: 3,
        maxDescendants: 2,
      }),
    ).rejects.toEqual(new SpawnLimitError("max_descendants", 2, 2))

    releaseSpawn(root)

    await expect(
      assertCanSpawn({
        sessionID: SessionID.make(root),
        maxDepth: 3,
        maxDescendants: 2,
      }),
    ).resolves.toEqual({
      depth: 0,
      rootSessionID: root,
    })

    releaseSpawn(root)
  })

  test("tracks descendants independently per root", async () => {
    const rootA = `root_a_${crypto.randomUUID()}`
    const rootB = `root_b_${crypto.randomUUID()}`
    registerSpawn(rootA)

    try {
      await expect(
        assertCanSpawn({
          sessionID: SessionID.make(rootA),
          maxDepth: 3,
          maxDescendants: 1,
        }),
      ).rejects.toEqual(new SpawnLimitError("max_descendants", 1, 1))

      await expect(
        assertCanSpawn({
          sessionID: SessionID.make(rootB),
          maxDepth: 3,
          maxDescendants: 1,
        }),
      ).resolves.toEqual({
        depth: 0,
        rootSessionID: rootB,
      })
    } finally {
      releaseSpawn(rootA)
    }
  })

  test("reserveSpawn increments before returning and releases idempotently", async () => {
    const root = `root_${crypto.randomUUID()}`
    const reservation = await reserveSpawn({
      sessionID: SessionID.make(root),
      maxDepth: 3,
      maxDescendants: 1,
    })

    try {
      await expect(
        assertCanSpawn({
          sessionID: SessionID.make(root),
          maxDepth: 3,
          maxDescendants: 1,
        }),
      ).rejects.toEqual(new SpawnLimitError("max_descendants", 1, 1))
    } finally {
      reservation.release()
      reservation.release()
    }

    await expect(
      assertCanSpawn({
        sessionID: SessionID.make(root),
        maxDepth: 3,
        maxDescendants: 1,
      }),
    ).resolves.toEqual({
      depth: 0,
      rootSessionID: root,
    })
  })
})
