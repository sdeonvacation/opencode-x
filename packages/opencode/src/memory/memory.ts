import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { makeRuntime } from "@/effect/run-service"
import { SessionID } from "../session/schema"
import { Effect, Layer, ServiceMap } from "effect"
import z from "zod"
import { Database, eq, asc, count } from "../storage/db"
import { MemoryTable } from "./memory.sql"

export type MemoryID = string & { readonly __tag: "MemoryID" }
export const MemoryID = {
  generate: (): MemoryID => crypto.randomUUID() as MemoryID,
  zod: z.string().transform((s) => s as MemoryID),
}

const CAP = 20

export namespace Memory {
  export const Info = z.object({
    id: MemoryID.zod,
    session_id: SessionID.zod,
    content: z.string(),
    position: z.number().int(),
  })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define(
      "memory.updated",
      z.object({
        sessionID: SessionID.zod,
        entries: z.array(
          z.object({
            id: z.string(),
            session_id: SessionID.zod,
            content: z.string(),
            position: z.number().int(),
          }),
        ),
      }),
    ),
  }

  export interface Interface {
    readonly list: (sessionID: SessionID) => Effect.Effect<Info[]>
    readonly create: (input: { sessionID: SessionID; content: string }) => Effect.Effect<Info>
    readonly update: (input: { id: MemoryID; sessionID: SessionID; content: string }) => Effect.Effect<Info>
    readonly remove: (input: { id: MemoryID; sessionID: SessionID }) => Effect.Effect<void>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Memory") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service

      const list = Effect.fn("Memory.list")(function* (sessionID: SessionID) {
        const rows = yield* Effect.sync(() =>
          Database.use((db) =>
            db
              .select()
              .from(MemoryTable)
              .where(eq(MemoryTable.session_id, sessionID))
              .orderBy(asc(MemoryTable.position))
              .all(),
          ),
        )
        return rows.map((row) => ({
          id: row.id,
          session_id: row.session_id,
          content: row.content,
          position: row.position,
        }))
      })

      const create = Effect.fn("Memory.create")(function* (input: { sessionID: SessionID; content: string }) {
        const existing = yield* Effect.sync(() =>
          Database.use((db) =>
            db.select({ total: count() }).from(MemoryTable).where(eq(MemoryTable.session_id, input.sessionID)).get(),
          ),
        )
        const total = existing?.total ?? 0
        if (total >= CAP) throw new Error(`Session memory cap of ${CAP} reached`)

        const id = MemoryID.generate()
        const row = yield* Effect.sync(() =>
          Database.transaction((db) => {
            db.insert(MemoryTable)
              .values({
                id,
                session_id: input.sessionID,
                content: input.content,
                position: total,
              })
              .run()
            return db.select().from(MemoryTable).where(eq(MemoryTable.id, id)).get()!
          }),
        )
        const entry: Info = {
          id: row.id,
          session_id: row.session_id,
          content: row.content,
          position: row.position,
        }
        const entries = yield* list(input.sessionID)
        yield* bus.publish(Event.Updated, { sessionID: input.sessionID, entries })
        return entry
      })

      const update = Effect.fn("Memory.update")(function* (input: {
        id: MemoryID
        sessionID: SessionID
        content: string
      }) {
        const existing = yield* Effect.sync(() =>
          Database.use((db) => db.select().from(MemoryTable).where(eq(MemoryTable.id, input.id)).get()),
        )
        if (!existing) throw new Error(`Memory ${input.id} not found`)
        if (existing.session_id !== input.sessionID) throw new Error(`Memory ${input.id} not found`)
        const row = yield* Effect.sync(() =>
          Database.transaction((db) => {
            db.update(MemoryTable).set({ content: input.content }).where(eq(MemoryTable.id, input.id)).run()
            return db.select().from(MemoryTable).where(eq(MemoryTable.id, input.id)).get()!
          }),
        )
        const entry: Info = {
          id: row.id,
          session_id: row.session_id,
          content: row.content,
          position: row.position,
        }
        const entries = yield* list(row.session_id)
        yield* bus.publish(Event.Updated, { sessionID: row.session_id, entries })
        return entry
      })

      const remove = Effect.fn("Memory.remove")(function* (input: { id: MemoryID; sessionID: SessionID }) {
        const existing = yield* Effect.sync(() =>
          Database.use((db) => db.select().from(MemoryTable).where(eq(MemoryTable.id, input.id)).get()),
        )
        if (!existing) throw new Error(`Memory ${input.id} not found`)
        if (existing.session_id !== input.sessionID) throw new Error(`Memory ${input.id} not found`)
        yield* Effect.sync(() =>
          Database.transaction((db) => {
            db.delete(MemoryTable).where(eq(MemoryTable.id, input.id)).run()
            // repack positions for remaining entries to keep them contiguous
            const rest = db
              .select()
              .from(MemoryTable)
              .where(eq(MemoryTable.session_id, existing.session_id))
              .orderBy(asc(MemoryTable.position))
              .all()
            for (let i = 0; i < rest.length; i++) {
              if (rest[i].position !== i)
                db.update(MemoryTable).set({ position: i }).where(eq(MemoryTable.id, rest[i].id)).run()
            }
          }),
        )
        const entries = yield* list(existing.session_id)
        yield* bus.publish(Event.Updated, { sessionID: existing.session_id, entries })
      })

      return Service.of({ list, create, update, remove })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))
  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function list(sessionID: SessionID): Promise<Info[]> {
    return runPromise((svc) => svc.list(sessionID))
  }

  export async function create(input: { sessionID: SessionID; content: string }): Promise<Info> {
    return runPromise((svc) => svc.create(input))
  }

  export async function update(input: { id: MemoryID; sessionID: SessionID; content: string }): Promise<Info> {
    return runPromise((svc) => svc.update(input))
  }

  export async function remove(input: { id: MemoryID; sessionID: SessionID }): Promise<void> {
    return runPromise((svc) => svc.remove(input))
  }
}
