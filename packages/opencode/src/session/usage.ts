import z from "zod"
import { Database, eq } from "@/storage/db"
import { MessageTable, SessionTable } from "./session.sql"
import type { SessionID } from "./schema"

export namespace Usage {
  export const ModelUsage = z.object({
    providerID: z.string(),
    modelID: z.string(),
    cost: z.number(),
    tokens: z.object({
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cache: z.object({
        read: z.number(),
        write: z.number(),
      }),
    }),
    duration: z.number(),
  })
  export type ModelUsage = z.infer<typeof ModelUsage>

  export const Info = z
    .object({
      total: z.object({
        cost: z.number(),
        tokens: z.object({
          input: z.number(),
          output: z.number(),
          reasoning: z.number(),
          cache: z.object({
            read: z.number(),
            write: z.number(),
          }),
        }),
        duration: z.number(),
        wall: z.number(),
      }),
      primary: z.object({
        cost: z.number(),
      }),
      byModel: ModelUsage.array(),
      subagents: z.object({
        cost: z.number(),
        tokens: z.object({
          input: z.number(),
          output: z.number(),
          reasoning: z.number(),
          cache: z.object({
            read: z.number(),
            write: z.number(),
          }),
        }),
        count: z.number(),
        sessions: z.array(
          z.object({
            title: z.string(),
            cost: z.number(),
          }),
        ),
      }),
    })
    .meta({ ref: "SessionUsage" })
  export type Info = z.infer<typeof Info>

  function empty(): {
    cost: number
    tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  } {
    return { cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
  }

  function aggregate(messages: { session_id: SessionID; data: unknown }[]): {
    byModel: ModelUsage[]
    duration: number
    last: number
  } {
    const map = new Map<string, ModelUsage>()
    let duration = 0
    let last = 0

    for (const msg of messages) {
      const data = msg.data as any
      if (data.role !== "assistant") continue

      const key = `${data.providerID}:${data.modelID}`
      let entry = map.get(key)
      if (!entry) {
        entry = {
          providerID: data.providerID,
          modelID: data.modelID,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          duration: 0,
        }
        map.set(key, entry)
      }

      entry.cost += data.cost ?? 0
      entry.tokens.input += data.tokens?.input ?? 0
      entry.tokens.output += data.tokens?.output ?? 0
      entry.tokens.reasoning += data.tokens?.reasoning ?? 0
      entry.tokens.cache.read += data.tokens?.cache?.read ?? 0
      entry.tokens.cache.write += data.tokens?.cache?.write ?? 0

      if (data.time?.created && data.time?.completed) {
        const d = data.time.completed - data.time.created
        entry.duration += d
        duration += d
      }

      if (data.time?.completed && data.time.completed > last) {
        last = data.time.completed
      }
    }

    return { byModel: [...map.values()], duration, last }
  }

  function collectChildren(
    id: SessionID,
    depth: number,
  ): {
    cost: number
    tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
    count: number
    sessions: { title: string; cost: number }[]
  } {
    if (depth > 3) return { ...empty(), count: 0, sessions: [] }

    const children = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.parent_id, id)).all())

    const result = { ...empty(), count: children.length, sessions: [] as { title: string; cost: number }[] }

    for (const child of children) {
      result.cost += child.cost
      result.tokens.input += child.tokens_input
      result.tokens.output += child.tokens_output
      result.tokens.reasoning += child.tokens_reasoning
      result.tokens.cache.read += child.tokens_cache_read
      result.tokens.cache.write += child.tokens_cache_write
      result.sessions.push({ title: child.title, cost: child.cost })

      const nested = collectChildren(child.id, depth + 1)
      result.cost += nested.cost
      result.tokens.input += nested.tokens.input
      result.tokens.output += nested.tokens.output
      result.tokens.reasoning += nested.tokens.reasoning
      result.tokens.cache.read += nested.tokens.cache.read
      result.tokens.cache.write += nested.tokens.cache.write
      result.count += nested.count
      result.sessions.push(...nested.sessions)
    }

    return result
  }

  export async function forSession(sessionID: SessionID): Promise<Info> {
    const messages = Database.use((db) =>
      db.select().from(MessageTable).where(eq(MessageTable.session_id, sessionID)).all(),
    )

    const session = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).all())

    const aggregated = aggregate(messages)
    const subagents = collectChildren(sessionID, 0)

    // Prefer cost_by_model (survives message deletion/compaction); fall back to message aggregation
    const raw = session.length > 0 ? session[0].cost_by_model : null
    const byModel: ModelUsage[] = raw
      ? (() => {
          const durMap = new Map(aggregated.byModel.map((m) => [`${m.providerID}:${m.modelID}`, m.duration]))
          return Object.entries(raw).map(([key, val]) => {
            const [providerID, ...rest] = key.split(":")
            const modelID = rest.join(":")
            return {
              providerID,
              modelID,
              cost: val.cost ?? 0,
              tokens: {
                input: val.tokens_input ?? 0,
                output: val.tokens_output ?? 0,
                reasoning: val.tokens_reasoning ?? 0,
                cache: { read: val.tokens_cache_read ?? 0, write: val.tokens_cache_write ?? 0 },
              },
              duration: durMap.get(key) ?? 0,
            }
          })
        })()
      : aggregated.byModel

    // Use session row cost (monotonic, includes deleted messages) for accurate total
    const sessionCost = session.length > 0 ? session[0].cost : 0
    const wall = session.length > 0 && aggregated.last > 0 ? aggregated.last - session[0].time_created : 0

    return {
      total: {
        cost: sessionCost + subagents.cost,
        tokens: {
          input: (session.length > 0 ? session[0].tokens_input : 0) + subagents.tokens.input,
          output: (session.length > 0 ? session[0].tokens_output : 0) + subagents.tokens.output,
          reasoning: (session.length > 0 ? session[0].tokens_reasoning : 0) + subagents.tokens.reasoning,
          cache: {
            read: (session.length > 0 ? session[0].tokens_cache_read : 0) + subagents.tokens.cache.read,
            write: (session.length > 0 ? session[0].tokens_cache_write : 0) + subagents.tokens.cache.write,
          },
        },
        duration: aggregated.duration,
        wall,
      },
      primary: {
        cost: sessionCost,
      },
      byModel,
      subagents,
    }
  }
}
