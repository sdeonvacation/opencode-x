import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Memory, MemoryID } from "../../memory/memory"
import { SessionID } from "../../session/schema"
import { errors } from "../error"
import { lazy } from "../../util/lazy"

export const MemoryRoutes = lazy(() =>
  new Hono()
    .get(
      "/:sessionID/memory",
      describeRoute({
        summary: "List memory entries",
        description: "Retrieve all memory entries associated with a specific session.",
        operationId: "session.memory.list",
        responses: {
          200: {
            description: "Memory entries",
            content: {
              "application/json": {
                schema: resolver(z.array(Memory.Info)),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ sessionID: SessionID.zod })),
      async (c) => {
        const entries = await Memory.list(c.req.valid("param").sessionID)
        return c.json(entries)
      },
    )
    .post(
      "/:sessionID/memory",
      describeRoute({
        summary: "Create memory entry",
        description: "Create a new memory entry for a specific session.",
        operationId: "session.memory.create",
        responses: {
          200: {
            description: "Created memory entry",
            content: {
              "application/json": {
                schema: resolver(Memory.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ sessionID: SessionID.zod })),
      validator("json", z.object({ content: z.string().min(1) })),
      async (c) => {
        const entry = await Memory.create({
          sessionID: c.req.valid("param").sessionID,
          content: c.req.valid("json").content,
        })
        return c.json(entry)
      },
    )
    .put(
      "/:sessionID/memory/:memoryID",
      describeRoute({
        summary: "Update memory entry",
        description: "Update the content of an existing memory entry.",
        operationId: "session.memory.update",
        responses: {
          200: {
            description: "Updated memory entry",
            content: {
              "application/json": {
                schema: resolver(Memory.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
          memoryID: z.string(),
        }),
      ),
      validator("json", z.object({ content: z.string().min(1) })),
      async (c) => {
        try {
          const { sessionID, memoryID } = c.req.valid("param")
          const entry = await Memory.update({
            id: memoryID as MemoryID,
            sessionID,
            content: c.req.valid("json").content,
          })
          return c.json(entry)
        } catch (err) {
          if (err instanceof Error && err.message.includes("not found")) return c.json({ message: err.message }, 404)
          throw err
        }
      },
    )
    .delete(
      "/:sessionID/memory/:memoryID",
      describeRoute({
        summary: "Delete memory entry",
        description: "Delete a specific memory entry from a session.",
        operationId: "session.memory.delete",
        responses: {
          200: {
            description: "Memory entry deleted",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
          memoryID: z.string(),
        }),
      ),
      async (c) => {
        try {
          const { sessionID, memoryID } = c.req.valid("param")
          await Memory.remove({ id: memoryID as MemoryID, sessionID })
          return c.json(true)
        } catch (err) {
          if (err instanceof Error && err.message.includes("not found")) return c.json({ message: err.message }, 404)
          throw err
        }
      },
    ),
)
