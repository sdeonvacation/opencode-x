import { Hono } from "hono"
import { stream } from "hono/streaming"
import { describeRoute, validator, resolver } from "hono-openapi"
import { SessionID, MessageID, PartID } from "@/session/schema"
import z from "zod"
import { Session } from "../../session"
import { MessageV2 } from "../../session/message-v2"
import { SessionPrompt } from "../../session/prompt"
import { SessionRunState } from "@/session/run-state"
import { SessionCompaction } from "../../session/compaction"
import { SessionRevert } from "../../session/revert"
import { SessionShare } from "@/share/session"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "../../session/todo"
import { Agent } from "../../agent/agent"
import { Snapshot } from "@/snapshot"
import { Command } from "../../command"
import { Log } from "../../util/log"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { errors } from "../error"
import { lazy } from "../../util/lazy"
import { Bus } from "../../bus"
import { NamedError } from "@opencode-ai/util/error"
import { Goal } from "../../goal/goal"
import { Loop } from "../../loop/loop"
import { LoopID } from "../../loop/schema"
import { LoopScheduler } from "../../loop/scheduler"
import { Usage } from "../../session/usage"
import { WorkflowRuntime } from "@/workflow/runtime"
import { WorkflowRuntimeRef } from "@/workflow/runtime-ref"
import { spawnSubagent } from "@/orchestration/task-spawn"
import { BackgroundJob } from "@/background/job"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { Instance } from "@/project/instance"
import { makeRuntime } from "@/effect/run-service"
import { Config } from "@/config/config"
import { Effect } from "effect"
import { SyncEvent } from "@/sync"
import { ulid } from "ulid"

const bgRuntime = makeRuntime(BackgroundJob.Service, BackgroundJob.defaultLayer)

const log = Log.create({ service: "server" })

export const SessionRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List sessions",
        description: "Get a list of all OpenCode sessions, sorted by most recently updated.",
        operationId: "session.list",
        responses: {
          200: {
            description: "List of sessions",
            content: {
              "application/json": {
                schema: resolver(Session.Info.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          directory: z.string().optional().meta({ description: "Filter sessions by project directory" }),
          roots: z.coerce.boolean().optional().meta({ description: "Only return root sessions (no parentID)" }),
          start: z.coerce
            .number()
            .optional()
            .meta({ description: "Filter sessions updated on or after this timestamp (milliseconds since epoch)" }),
          search: z.string().optional().meta({ description: "Filter sessions by title (case-insensitive)" }),
          limit: z.coerce.number().optional().meta({ description: "Maximum number of sessions to return" }),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const sessions: Session.Info[] = []
        for await (const session of Session.list({
          directory: query.directory,
          roots: query.roots,
          start: query.start,
          search: query.search,
          limit: query.limit,
        })) {
          sessions.push(session)
        }
        return c.json(sessions)
      },
    )
    .get(
      "/status",
      describeRoute({
        summary: "Get session status",
        description: "Retrieve the current status of all sessions, including active, idle, and completed states.",
        operationId: "session.status",
        responses: {
          200: {
            description: "Get session status",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), SessionStatus.Info)),
              },
            },
          },
          ...errors(400),
        },
      }),
      async (c) => {
        const result = await SessionStatus.list()
        return c.json(Object.fromEntries(result))
      },
    )
    .get(
      "/:sessionID",
      describeRoute({
        summary: "Get session",
        description: "Retrieve detailed information about a specific OpenCode session.",
        tags: ["Session"],
        operationId: "session.get",
        responses: {
          200: {
            description: "Get session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.get.schema,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const session = await Session.get(sessionID)
        return c.json(session)
      },
    )
    .get(
      "/:sessionID/children",
      describeRoute({
        summary: "Get session children",
        tags: ["Session"],
        description: "Retrieve all child sessions that were forked from the specified parent session.",
        operationId: "session.children",
        responses: {
          200: {
            description: "List of children",
            content: {
              "application/json": {
                schema: resolver(Session.Info.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.children.schema,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const session = await Session.children(sessionID)
        return c.json(session)
      },
    )
    .get(
      "/:sessionID/todo",
      describeRoute({
        summary: "Get session todos",
        description: "Retrieve the todo list associated with a specific session, showing tasks and action items.",
        operationId: "session.todo",
        responses: {
          200: {
            description: "Todo list",
            content: {
              "application/json": {
                schema: resolver(Todo.Info.array()),
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
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const todos = await Todo.get(sessionID)
        return c.json(todos)
      },
    )
    .delete(
      "/:sessionID/todo",
      describeRoute({
        summary: "Clear session todos",
        description: "Clear all todos associated with a specific session.",
        operationId: "session.clearTodo",
        responses: {
          200: {
            description: "Todos cleared",
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
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        Todo.update({ sessionID, todos: [] })
        return c.json(true)
      },
    )
    .post(
      "/",
      describeRoute({
        summary: "Create session",
        description: "Create a new OpenCode session for interacting with AI assistants and managing conversations.",
        operationId: "session.create",
        responses: {
          ...errors(400),
          200: {
            description: "Successfully created session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
        },
      }),
      validator("json", Session.create.schema),
      async (c) => {
        const body = c.req.valid("json") ?? {}
        const session = await SessionShare.create(body)
        return c.json(session)
      },
    )
    .delete(
      "/:sessionID",
      describeRoute({
        summary: "Delete session",
        description: "Delete a session and permanently remove all associated data, including messages and history.",
        operationId: "session.delete",
        responses: {
          200: {
            description: "Successfully deleted session",
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
          sessionID: Session.remove.schema,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        LoopScheduler.stop(sessionID)
        await Session.remove(sessionID)
        return c.json(true)
      },
    )
    .patch(
      "/:sessionID",
      describeRoute({
        summary: "Update session",
        description: "Update properties of an existing session, such as title or other metadata.",
        operationId: "session.update",
        responses: {
          200: {
            description: "Successfully updated session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
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
        }),
      ),
      validator(
        "json",
        z.object({
          title: z.string().optional(),
          permission: Permission.Ruleset.optional(),
          time: z
            .object({
              archived: z.number().optional(),
            })
            .optional(),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const updates = c.req.valid("json")
        const current = await Session.get(sessionID)

        if (updates.title !== undefined) {
          await Session.setTitle({ sessionID, title: updates.title })
        }
        if (updates.permission !== undefined) {
          await Session.setPermission({
            sessionID,
            permission: Permission.merge(current.permission ?? [], updates.permission),
          })
        }
        if (updates.time?.archived !== undefined) {
          await Session.setArchived({ sessionID, time: updates.time.archived })
        }

        const session = await Session.get(sessionID)
        return c.json(session)
      },
    )
    // TODO(v2): remove this dedicated route and rely on the normal `/init` command flow.
    .post(
      "/:sessionID/init",
      describeRoute({
        summary: "Initialize session",
        description:
          "Analyze the current application and create an AGENTS.md file with project-specific agent configurations.",
        operationId: "session.init",
        responses: {
          200: {
            description: "200",
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
        }),
      ),
      validator(
        "json",
        z.object({
          modelID: ModelID.zod,
          providerID: ProviderID.zod,
          messageID: MessageID.zod,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        await SessionPrompt.command({
          sessionID,
          messageID: body.messageID,
          model: body.providerID + "/" + body.modelID,
          command: Command.Default.INIT,
          arguments: "",
        })
        return c.json(true)
      },
    )
    .post(
      "/:sessionID/fork",
      describeRoute({
        summary: "Fork session",
        description: "Create a new session by forking an existing session at a specific message point.",
        operationId: "session.fork",
        responses: {
          200: {
            description: "200",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: Session.fork.schema.shape.sessionID,
        }),
      ),
      validator("json", Session.fork.schema.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const result = await Session.fork({ ...body, sessionID })
        return c.json(result)
      },
    )
    .post(
      "/:sessionID/abort",
      describeRoute({
        summary: "Abort session",
        description: "Abort an active session and stop any ongoing AI processing or command execution.",
        operationId: "session.abort",
        responses: {
          200: {
            description: "Aborted session",
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
        }),
      ),
      async (c) => {
        await SessionPrompt.cancel(c.req.valid("param").sessionID)
        return c.json(true)
      },
    )
    // fork: background-detach (#FORK) — begin
    .post(
      "/:sessionID/background",
      describeRoute({
        summary: "Push session to background",
        description: "Detach the current running session to background, freeing the prompt input.",
        operationId: "session.background",
        responses: {
          200: {
            description: "Background detach result",
            content: {
              "application/json": {
                schema: resolver(z.object({ success: z.boolean(), children: z.number() })),
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
        }),
      ),
      async (c) => {
        const children = await SessionPrompt.background(c.req.valid("param").sessionID)
        return c.json({ success: children > 0, children })
      },
    )
    // fork: background-detach (#FORK) — end
    .post(
      "/:sessionID/share",
      describeRoute({
        summary: "Share session",
        description: "Create a shareable link for a session, allowing others to view the conversation.",
        operationId: "session.share",
        responses: {
          200: {
            description: "Successfully shared session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
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
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        await SessionShare.share(sessionID)
        const session = await Session.get(sessionID)
        return c.json(session)
      },
    )
    .get(
      "/:sessionID/diff",
      describeRoute({
        summary: "Get message diff",
        description: "Get the file changes (diff) that resulted from a specific user message in the session.",
        operationId: "session.diff",
        responses: {
          200: {
            description: "Successfully retrieved diff",
            content: {
              "application/json": {
                schema: resolver(Snapshot.FileDiff.array()),
              },
            },
          },
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionSummary.DiffInput.shape.sessionID,
        }),
      ),
      validator(
        "query",
        z.object({
          messageID: SessionSummary.DiffInput.shape.messageID,
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const params = c.req.valid("param")
        const result = await SessionSummary.diff({
          sessionID: params.sessionID,
          messageID: query.messageID,
        })
        return c.json(result)
      },
    )
    .delete(
      "/:sessionID/share",
      describeRoute({
        summary: "Unshare session",
        description: "Remove the shareable link for a session, making it private again.",
        operationId: "session.unshare",
        responses: {
          200: {
            description: "Successfully unshared session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
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
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        await SessionShare.unshare(sessionID)
        const session = await Session.get(sessionID)
        return c.json(session)
      },
    )
    .post(
      "/:sessionID/summarize",
      describeRoute({
        summary: "Summarize session",
        description: "Generate a concise summary of the session using AI compaction to preserve key information.",
        operationId: "session.summarize",
        responses: {
          200: {
            description: "Summarized session",
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
        }),
      ),
      validator(
        "json",
        z.object({
          providerID: ProviderID.zod,
          modelID: ModelID.zod,
          auto: z.boolean().optional().default(false),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const session = await Session.get(sessionID)
        const msgs = await Session.messages({ sessionID })
        let currentAgent = await Agent.defaultAgent()
        for (let i = msgs.length - 1; i >= 0; i--) {
          const info = msgs[i].info
          if (info.role === "user") {
            currentAgent = info.agent || (await Agent.defaultAgent())
            break
          }
        }
        await SessionCompaction.resolveModel({
          model: {
            providerID: body.providerID,
            modelID: body.modelID,
          },
        })
        await SessionRevert.cleanup(session)
        await SessionCompaction.create({
          sessionID,
          agent: currentAgent,
          model: {
            providerID: body.providerID,
            modelID: body.modelID,
          },
          auto: body.auto,
        })
        await SessionCompaction.run({ sessionID })
        return c.json(true)
      },
    )
    .get(
      "/:sessionID/message",
      describeRoute({
        summary: "Get session messages",
        description: "Retrieve all messages in a session, including user prompts and AI responses.",
        operationId: "session.messages",
        responses: {
          200: {
            description: "List of messages",
            content: {
              "application/json": {
                schema: resolver(MessageV2.WithParts.array()),
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
        }),
      ),
      validator(
        "query",
        z
          .object({
            limit: z.coerce
              .number()
              .int()
              .min(0)
              .optional()
              .meta({ description: "Maximum number of messages to return" }),
            before: z
              .string()
              .optional()
              .meta({ description: "Opaque cursor for loading older messages" })
              .refine(
                (value) => {
                  if (!value) return true
                  try {
                    MessageV2.cursor.decode(value)
                    return true
                  } catch {
                    return false
                  }
                },
                { message: "Invalid cursor" },
              ),
          })
          .refine((value) => !value.before || value.limit !== undefined, {
            message: "before requires limit",
            path: ["before"],
          }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const sessionID = c.req.valid("param").sessionID
        if (query.limit === undefined) {
          await Session.get(sessionID)
          const messages = await Session.messages({ sessionID })
          return c.json(messages)
        }

        if (query.limit === 0) {
          await Session.get(sessionID)
          const messages = await Session.messages({ sessionID })
          return c.json(messages)
        }

        const page = await MessageV2.page({
          sessionID,
          limit: query.limit,
          before: query.before,
        })
        if (page.cursor) {
          const url = new URL(c.req.url)
          url.searchParams.set("limit", query.limit.toString())
          url.searchParams.set("before", page.cursor)
          c.header("Access-Control-Expose-Headers", "Link, X-Next-Cursor")
          c.header("Link", `<${url.toString()}>; rel=\"next\"`)
          c.header("X-Next-Cursor", page.cursor)
        }
        return c.json(page.items)
      },
    )
    .get(
      "/:sessionID/message/:messageID",
      describeRoute({
        summary: "Get message",
        description: "Retrieve a specific message from a session by its message ID.",
        operationId: "session.message",
        responses: {
          200: {
            description: "Message",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    info: MessageV2.Info,
                    parts: MessageV2.Part.array(),
                  }),
                ),
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
          messageID: MessageID.zod,
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        const message = await MessageV2.get({
          sessionID: params.sessionID,
          messageID: params.messageID,
        })
        return c.json(message)
      },
    )
    .delete(
      "/:sessionID/message/:messageID",
      describeRoute({
        summary: "Delete message",
        description:
          "Permanently delete a specific message (and all of its parts) from a session. This does not revert any file changes that may have been made while processing the message.",
        operationId: "session.deleteMessage",
        responses: {
          200: {
            description: "Successfully deleted message",
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
          messageID: MessageID.zod,
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        await SessionRunState.assertNotBusy(params.sessionID)
        await Session.removeMessage({
          sessionID: params.sessionID,
          messageID: params.messageID,
        })
        return c.json(true)
      },
    )
    .delete(
      "/:sessionID/message/:messageID/part/:partID",
      describeRoute({
        description: "Delete a part from a message",
        operationId: "part.delete",
        responses: {
          200: {
            description: "Successfully deleted part",
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
          messageID: MessageID.zod,
          partID: PartID.zod,
        }),
      ),
      async (c) => {
        const params = c.req.valid("param")
        await Session.removePart({
          sessionID: params.sessionID,
          messageID: params.messageID,
          partID: params.partID,
        })
        return c.json(true)
      },
    )
    .patch(
      "/:sessionID/message/:messageID/part/:partID",
      describeRoute({
        description: "Update a part in a message",
        operationId: "part.update",
        responses: {
          200: {
            description: "Successfully updated part",
            content: {
              "application/json": {
                schema: resolver(MessageV2.Part),
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
          messageID: MessageID.zod,
          partID: PartID.zod,
        }),
      ),
      validator("json", MessageV2.Part),
      async (c) => {
        const params = c.req.valid("param")
        const body = c.req.valid("json")
        if (body.id !== params.partID || body.messageID !== params.messageID || body.sessionID !== params.sessionID) {
          throw new Error(
            `Part mismatch: body.id='${body.id}' vs partID='${params.partID}', body.messageID='${body.messageID}' vs messageID='${params.messageID}', body.sessionID='${body.sessionID}' vs sessionID='${params.sessionID}'`,
          )
        }
        const part = await Session.updatePart(body)
        return c.json(part)
      },
    )
    .post(
      "/:sessionID/message",
      describeRoute({
        summary: "Send message",
        description: "Create and send a new message to a session, streaming the AI response.",
        operationId: "session.prompt",
        responses: {
          200: {
            description: "Created message",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    info: MessageV2.Assistant,
                    parts: MessageV2.Part.array(),
                  }),
                ),
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
        }),
      ),
      validator("json", SessionPrompt.PromptInput.omit({ sessionID: true })),
      async (c) => {
        c.status(200)
        c.header("Content-Type", "application/json")
        return stream(c, async (stream) => {
          const sessionID = c.req.valid("param").sessionID
          const body = c.req.valid("json")
          const msg = await SessionPrompt.prompt({ ...body, sessionID })
          stream.write(JSON.stringify(msg))
        })
      },
    )
    .post(
      "/:sessionID/complete",
      describeRoute({
        summary: "Complete message",
        description: "Create and complete a message directly without agent loop overhead.",
        operationId: "session.complete",
        responses: {
          200: {
            description: "Created message",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    info: MessageV2.Assistant,
                    parts: MessageV2.Part.array(),
                  }),
                ),
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
        }),
      ),
      validator("json", SessionPrompt.CompleteInput.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const msg = await SessionPrompt.complete({ ...body, sessionID })
        return c.json(msg)
      },
    )
    .post(
      "/:sessionID/prompt_async",
      describeRoute({
        summary: "Send async message",
        description:
          "Create and send a new message to a session asynchronously, starting the session if needed and returning immediately.",
        operationId: "session.prompt_async",
        responses: {
          204: {
            description: "Prompt accepted",
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator("json", SessionPrompt.PromptInput.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        SessionPrompt.prompt({ ...body, sessionID }).catch((err) => {
          log.error("prompt_async failed", { sessionID, error: err })
          Bus.publish(Session.Event.Error, {
            sessionID,
            error: new NamedError.Unknown({ message: err instanceof Error ? err.message : String(err) }).toObject(),
          })
        })

        return c.body(null, 204)
      },
    )
    .post(
      "/:sessionID/command",
      describeRoute({
        summary: "Send command",
        description: "Send a new command to a session for execution by the AI assistant.",
        operationId: "session.command",
        responses: {
          200: {
            description: "Created message",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    info: MessageV2.Assistant,
                    parts: MessageV2.Part.array(),
                  }),
                ),
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
        }),
      ),
      validator("json", SessionPrompt.CommandInput.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const msg = await SessionPrompt.command({ ...body, sessionID })
        return c.json(msg)
      },
    )
    .post(
      "/:sessionID/shell",
      describeRoute({
        summary: "Run shell command",
        description: "Execute a shell command within the session context and return the AI's response.",
        operationId: "session.shell",
        responses: {
          200: {
            description: "Created message",
            content: {
              "application/json": {
                schema: resolver(MessageV2.WithParts),
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
        }),
      ),
      validator("json", SessionPrompt.ShellInput.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const msg = await SessionPrompt.shell({ ...body, sessionID })
        return c.json(msg)
      },
    )
    .post(
      "/:sessionID/revert",
      describeRoute({
        summary: "Revert message",
        description: "Revert a specific message in a session, undoing its effects and restoring the previous state.",
        operationId: "session.revert",
        responses: {
          200: {
            description: "Updated session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
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
        }),
      ),
      validator("json", SessionRevert.RevertInput.omit({ sessionID: true })),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        log.info("revert", c.req.valid("json"))
        const session = await SessionRevert.revert({
          sessionID,
          ...c.req.valid("json"),
        })
        return c.json(session)
      },
    )
    .post(
      "/:sessionID/unrevert",
      describeRoute({
        summary: "Restore reverted messages",
        description: "Restore all previously reverted messages in a session.",
        operationId: "session.unrevert",
        responses: {
          200: {
            description: "Updated session",
            content: {
              "application/json": {
                schema: resolver(Session.Info),
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
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const session = await SessionRevert.unrevert({ sessionID })
        return c.json(session)
      },
    )
    .post(
      "/:sessionID/permissions/:permissionID",
      describeRoute({
        summary: "Respond to permission",
        deprecated: true,
        description: "Approve or deny a permission request from the AI assistant.",
        operationId: "permission.respond",
        responses: {
          200: {
            description: "Permission processed successfully",
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
          permissionID: PermissionID.zod,
        }),
      ),
      validator("json", z.object({ response: Permission.Reply })),
      async (c) => {
        const params = c.req.valid("param")
        Permission.reply({
          requestID: params.permissionID,
          reply: c.req.valid("json").response,
        })
        return c.json(true)
      },
    )
    .post(
      "/:sessionID/goal",
      describeRoute({
        summary: "Create goal",
        description: "Create a goal for the session to work toward autonomously.",
        operationId: "session.goal",
        responses: {
          200: {
            description: "Goal created",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    id: z.string(),
                    session_id: z.string(),
                    objective: z.string(),
                    status: z.string(),
                    token_budget: z.number().nullable(),
                    tokens_used: z.number(),
                    turns_used: z.number(),
                    time_used_secs: z.number(),
                    created_at: z.number(),
                    completed_at: z.number().nullable(),
                  }),
                ),
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
        }),
      ),
      validator(
        "json",
        z.object({
          objective: z.string(),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const goal = Goal.create({ sessionID, objective: body.objective })
        return c.json(goal)
      },
    )
    .get(
      "/:sessionID/usage",
      describeRoute({
        summary: "Get session usage",
        description: "Get per-model token usage and cost breakdown for a session.",
        operationId: "session.usage",
        responses: {
          200: {
            description: "Session usage breakdown",
            content: {
              "application/json": {
                schema: resolver(Usage.Info),
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
        }),
      ),
      async (c) => {
        const id = c.req.valid("param").sessionID
        const usage = await Usage.forSession(id)
        return c.json(usage)
      },
    )
    .post(
      "/:sessionID/workflow/start",
      validator("param", z.object({ sessionID: SessionID.zod })),
      validator(
        "json",
        z.object({
          name: z.string(),
          args: z.record(z.string(), z.unknown()).optional(),
          max_concurrent_agents: z.number().int().positive().optional(),
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        try {
          const ref = WorkflowRuntimeRef.get()
          if (!ref) return c.json({ error: "Workflow engine not initialized" }, 400)

          const cfg = await Config.get()
          const agent = await Agent.get("build")

          const subagent = await spawnSubagent(undefined, {
            parentSessionID: sessionID,
            agent,
            description: `workflow:${body.name}`,
            canTask: false,
            canTodo: false,
            taskPermissionID: "workflow",
            maxDepth: cfg.experimental?.max_subagent_depth ?? 3,
            maxDescendants: 50,
          })

          const session = subagent.session
          const timeout = cfg.experimental?.workflow_agent_timeout_ms ?? 600_000

          // Write synthetic tool part into parent session so TUI can render/navigate
          const now = Date.now()
          const msgID = MessageID.ascending()
          const msg: MessageV2.Assistant = {
            id: msgID,
            sessionID,
            role: "assistant",
            time: { created: now, completed: now },
            parentID: MessageID.make("00000000000000000000000000"),
            modelID: ModelID.make("workflow"),
            providerID: ProviderID.make("workflow"),
            mode: "workflow",
            agent: "build",
            path: { cwd: ".", root: "." },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          }
          SyncEvent.run(MessageV2.Event.Updated, { sessionID, info: msg })

          const part: MessageV2.ToolPart = {
            id: PartID.ascending(),
            sessionID,
            messageID: msgID,
            type: "tool",
            callID: ulid(),
            tool: "workflow",
            state: {
              status: "completed",
              input: { script: body.name, description: `workflow:${body.name}`, subagent_type: "workflow" },
              output: "Workflow launched in background",
              title: `workflow:${body.name}`,
              metadata: { sessionId: session.id, background: true },
              time: { start: now, end: now },
            },
          }
          SyncEvent.run(MessageV2.Event.PartUpdated, { sessionID, part, time: now })

          const run = Instance.bind(async (): Promise<string> => {
            return WorkflowRuntime.executeInSession({
              sessionID: session.id,
              parentSessionID: sessionID,
              name: body.name,
              args: body.args,
              timeout,
              concurrent: body.max_concurrent_agents,
            })
          })

          const inject = Instance.bind(async (state: "completed" | "error", text: string) => {
            await Bus.publish(TuiEvent.BackgroundTaskUpdate, {
              sessionID,
              taskID: session.id,
              title: `workflow:${body.name}`,
              state,
            })
            await Bus.publish(TuiEvent.ToastShow, {
              title: state === "completed" ? "Workflow complete" : "Workflow failed",
              message:
                state === "completed" ? `Workflow "${body.name}" finished.` : `Workflow "${body.name}" failed: ${text}`,
              variant: state === "completed" ? "success" : "error",
              duration: 5000,
            })
          })

          const makeRun = () =>
            Effect.tryPromise({
              try: () => run(),
              catch: (err) => err,
            }).pipe(
              Effect.tap((text) => Effect.promise(() => inject("completed", text)).pipe(Effect.ignore)),
              Effect.catch((cause: unknown) =>
                Effect.gen(function* () {
                  const msg = cause instanceof Error ? cause.message : String(cause)
                  yield* Effect.promise(() => inject("error", msg)).pipe(Effect.ignore)
                  return yield* Effect.fail(cause)
                }),
              ),
            )

          await bgRuntime.runPromise((svc) =>
            svc.start({
              id: session.id,
              type: "workflow",
              title: `workflow:${body.name}`,
              metadata: {
                sessionId: session.id,
                background: true,
              },
              run: makeRun(),
            }),
          )

          await Bus.publish(TuiEvent.BackgroundTaskUpdate, {
            sessionID,
            taskID: session.id,
            title: `workflow:${body.name}`,
            state: "running",
          })

          if (subagent.spawned) subagent.spawnInfo.release()

          return c.json({ id: session.id })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (msg.includes("Parse error") || msg.includes("not found") || msg.includes("not initialized"))
            return c.json({ error: msg }, 400)
          throw err
        }
      },
    )
    .get("/:sessionID/workflow/list", validator("param", z.object({ sessionID: SessionID.zod })), async (c) => {
      const runs = WorkflowRuntime.list(c.req.valid("param").sessionID)
      return c.json(runs)
    })
    .get(
      "/:sessionID/workflow/:runID",
      validator("param", z.object({ sessionID: SessionID.zod, runID: z.string() })),
      async (c) => {
        const run = WorkflowRuntime.status(c.req.valid("param").runID)
        if (!run) return c.json({ error: "Not found" }, 404)
        return c.json(run)
      },
    )
    .post(
      "/:sessionID/workflow/:runID/cancel",
      validator("param", z.object({ sessionID: SessionID.zod, runID: z.string() })),
      async (c) => {
        WorkflowRuntime.cancel(c.req.valid("param").runID)
        return c.json({ ok: true })
      },
    )
    .post(
      "/:sessionID/loop",
      describeRoute({
        summary: "Create loop",
        description: "Create a recurring loop that spawns subagent iterations on a schedule.",
        operationId: "session.loop.create",
        responses: {
          200: {
            description: "Loop created",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    id: z.string(),
                    session_id: z.string(),
                    prompt: z.string(),
                    interval_ms: z.number(),
                    status: z.string(),
                    model: z.string().nullable(),
                    token_budget: z.number().nullable(),
                    tokens_used: z.number(),
                    iteration_count: z.number(),
                    next_run_at: z.number(),
                    last_run_at: z.number().nullable(),
                    last_subagent_session_id: z.string().nullable(),
                    expires_at: z.number(),
                    created_at: z.number(),
                  }),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator(
        "json",
        z.object({
          prompt: z.string().min(1),
          interval_ms: z.number().int().min(60000),
          model: z.string().optional(),
          token_budget: z.number().int().positive().optional(),
        }),
      ),
      async (c) => {
        const cfg = await Config.get()
        if (cfg.experimental?.loop === false) return c.json({ error: "Loop feature disabled" }, 400)
        const sessionID = c.req.valid("param").sessionID
        const body = c.req.valid("json")
        const minInterval = cfg.loop?.min_interval_ms ?? 60000
        if (body.interval_ms < minInterval) {
          return c.json({ error: `Minimum interval is ${minInterval}ms` }, 400)
        }
        const loop = Loop.create({
          sessionID,
          prompt: body.prompt,
          intervalMs: body.interval_ms,
          model: body.model,
          tokenBudget: body.token_budget ?? cfg.loop?.token_budget,
          maxLoops: cfg.loop?.max_concurrent,
          expiryMs: cfg.loop?.max_expiry_days ? cfg.loop.max_expiry_days * 86_400_000 : undefined,
        })
        LoopScheduler.start(sessionID)
        return c.json(loop)
      },
    )
    .get(
      "/:sessionID/loops",
      describeRoute({
        summary: "List loops",
        description: "List all loops for a session.",
        operationId: "session.loop.list",
        responses: {
          200: {
            description: "List of loops",
            content: {
              "application/json": {
                schema: resolver(
                  z.array(
                    z.object({
                      id: z.string(),
                      session_id: z.string(),
                      prompt: z.string(),
                      interval_ms: z.number(),
                      status: z.string(),
                      model: z.string().nullable(),
                      token_budget: z.number().nullable(),
                      tokens_used: z.number(),
                      iteration_count: z.number(),
                      next_run_at: z.number(),
                      last_run_at: z.number().nullable(),
                      last_subagent_session_id: z.string().nullable(),
                      expires_at: z.number(),
                      created_at: z.number(),
                    }),
                  ),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      async (c) => {
        const sessionID = c.req.valid("param").sessionID
        const loops = Loop.list(sessionID)
        return c.json(loops)
      },
    )
    .delete(
      "/:sessionID/loop/:loopID",
      describeRoute({
        summary: "Cancel loop",
        description: "Cancel an active loop by ID.",
        operationId: "session.loop.cancel",
        responses: {
          200: {
            description: "Loop cancelled",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    id: z.string(),
                    session_id: z.string(),
                    prompt: z.string(),
                    interval_ms: z.number(),
                    status: z.string(),
                    model: z.string().nullable(),
                    token_budget: z.number().nullable(),
                    tokens_used: z.number(),
                    iteration_count: z.number(),
                    next_run_at: z.number(),
                    last_run_at: z.number().nullable(),
                    last_subagent_session_id: z.string().nullable(),
                    expires_at: z.number(),
                    created_at: z.number(),
                  }),
                ),
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
          loopID: LoopID.zod,
        }),
      ),
      async (c) => {
        const { loopID } = c.req.valid("param")
        const loop = Loop.get(loopID)
        if (!loop) return c.json({ error: "Loop not found" }, 404)
        const cancelled = Loop.cancel({ id: loopID })
        return c.json(cancelled)
      },
    )
    .get(
      "/:sessionID/loop/:loopID/iterations",
      describeRoute({
        summary: "Get loop iterations",
        description: "Get iteration info for a loop, including last subagent session.",
        operationId: "session.loop.iterations",
        responses: {
          200: {
            description: "Loop iteration info",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    id: z.string(),
                    iteration_count: z.number(),
                    last_subagent_session_id: z.string().nullable(),
                    status: z.string(),
                    tokens_used: z.number(),
                  }),
                ),
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
          loopID: LoopID.zod,
        }),
      ),
      async (c) => {
        const { loopID } = c.req.valid("param")
        const loop = Loop.get(loopID)
        if (!loop) return c.json({ error: "Loop not found" }, 404)
        return c.json({
          id: loop.id,
          iteration_count: loop.iteration_count,
          last_subagent_session_id: loop.last_subagent_session_id,
          status: loop.status,
          tokens_used: loop.tokens_used,
        })
      },
    )
    .post(
      "/:sessionID/loop/:loopID/pause",
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
          loopID: LoopID.zod,
        }),
      ),
      async (c) => {
        const { loopID } = c.req.valid("param")
        const loop = Loop.get(loopID)
        if (!loop) return c.json({ error: "Loop not found" }, 404)
        if (loop.status !== "active") return c.json({ error: "Loop is not active" }, 400)
        const paused = Loop.pause({ id: loopID })
        return c.json(paused)
      },
    )
    .post(
      "/:sessionID/loop/:loopID/resume",
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
          loopID: LoopID.zod,
        }),
      ),
      async (c) => {
        const { loopID } = c.req.valid("param")
        const loop = Loop.get(loopID)
        if (!loop) return c.json({ error: "Loop not found" }, 404)
        if (loop.status !== "paused") return c.json({ error: "Loop is not paused" }, 400)
        const resumed = Loop.resume({ id: loopID })
        return c.json(resumed)
      },
    ),
)
