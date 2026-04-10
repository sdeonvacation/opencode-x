import { Session } from "../session"
import type { SessionID } from "../session/schema"
import type { Agent } from "../agent/agent"
import { Bus } from "../bus"
import { OrchestrationEvent } from "./events"
import * as SpawnLimits from "./spawn-limits"
import type { SpawnReservation } from "./spawn-limits"

export type SpawnSubagentInput = {
  parentSessionID: SessionID
  agent: Agent.Info
  description: string
  canTask: boolean
  canTodo: boolean
  /** Permission ID used for the task tool (typically "task"). */
  taskPermissionID: string
  primaryTools?: string[]
  maxDepth: number
  maxDescendants: number
}

export type SpawnResult =
  | { session: Session.Info; spawned: false }
  | { session: Session.Info; spawnInfo: SpawnReservation; spawned: true }

/**
 * Either wrap an existing session (resume path) or reserve a spawn slot,
 * create a new child session with the appropriate permission rules, and
 * publish the `OrchestrationEvent.Spawn` bus event.
 *
 * On `SpawnLimitError` the rejection event is published before re-throwing.
 * On session-creation failure the spawn reservation is released before re-throwing.
 */
export async function spawnSubagent(
  existing: Session.Info | undefined,
  input: SpawnSubagentInput,
): Promise<SpawnResult> {
  if (existing) {
    return { session: existing, spawned: false }
  }

  const spawnInfo = await SpawnLimits.reserveSpawn({
    sessionID: input.parentSessionID,
    parentID: input.parentSessionID,
    maxDepth: input.maxDepth,
    maxDescendants: input.maxDescendants,
  }).catch(async (err) => {
    if (err instanceof SpawnLimits.SpawnLimitError) {
      await Bus.publish(OrchestrationEvent.SpawnRejected, {
        sessionID: String(input.parentSessionID),
        agent: input.agent.name,
        reason: err.reason,
        limit: err.limit,
        current: err.current,
      })
    }
    throw err
  })

  try {
    const session = await Session.create({
      parentID: input.parentSessionID,
      title: input.description + ` (@${input.agent.name} subagent)`,
      permission: [
        ...(input.canTodo ? [] : [{ permission: "todowrite", pattern: "*", action: "deny" as const }]),
        ...(input.canTask ? [] : [{ permission: input.taskPermissionID, pattern: "*", action: "deny" as const }]),
        ...(input.primaryTools?.map((item) => ({ permission: item, pattern: "*", action: "allow" as const })) ?? []),
      ],
    })

    await Bus.publish(OrchestrationEvent.Spawn, {
      sessionID: String(session.id),
      parentSessionID: String(input.parentSessionID),
      agent: input.agent.name,
      depth: spawnInfo.depth,
    })

    return { session, spawnInfo, spawned: true }
  } catch (err) {
    spawnInfo.release()
    throw err
  }
}
