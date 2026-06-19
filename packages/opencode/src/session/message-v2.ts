import { BusEvent } from "@/bus/bus-event"
import { SessionID, MessageID, PartID } from "./schema"
import z from "zod"
import { NamedError } from "@opencode-ai/util/error"
import { APICallError, convertToModelMessages, LoadAPIKeyError, type ModelMessage, type UIMessage } from "ai"
import { LSP } from "../lsp"
import { Snapshot } from "@/snapshot"
import { SyncEvent } from "../sync"
import { Database, NotFoundError, and, desc, eq, gt, inArray, lt, or } from "@/storage/db"
import { MessageTable, PartTable, SessionTable } from "./session.sql"
import { ProviderError } from "@/provider/error"
import { iife } from "@/util/iife"
import { errorMessage } from "@/util/error"
import type { SystemError } from "bun"
import type { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { Effect } from "effect"

/** Error shape thrown by Bun's fetch() when gzip/br decompression fails mid-stream */
interface FetchDecompressionError extends Error {
  code: "ZlibError"
  errno: number
  path: string
}

export namespace MessageV2 {
  export const SYNTHETIC_ATTACHMENT_PROMPT = "Attached media from tool result:"

  export function isMedia(mime: string) {
    return mime.startsWith("image/") || mime === "application/pdf"
  }

  export const OutputLengthError = NamedError.create("MessageOutputLengthError", z.object({}))
  export const AbortedError = NamedError.create("MessageAbortedError", z.object({ message: z.string() }))
  export const StructuredOutputError = NamedError.create(
    "StructuredOutputError",
    z.object({
      message: z.string(),
      retries: z.number(),
    }),
  )
  export const ContentFilterError = NamedError.create(
    "ContentFilterError",
    z.object({
      message: z.string(),
    }),
  )
  export const AuthError = NamedError.create(
    "ProviderAuthError",
    z.object({
      providerID: z.string(),
      message: z.string(),
    }),
  )
  export const APIError = NamedError.create(
    "APIError",
    z.object({
      message: z.string(),
      statusCode: z.number().optional(),
      isRetryable: z.boolean(),
      responseHeaders: z.record(z.string(), z.string()).optional(),
      responseBody: z.string().optional(),
      metadata: z.record(z.string(), z.string()).optional(),
    }),
  )
  export type APIError = z.infer<typeof APIError.Schema>
  export const ContextOverflowError = NamedError.create(
    "ContextOverflowError",
    z.object({ message: z.string(), responseBody: z.string().optional() }),
  )

  export const OutputFormatText = z
    .object({
      type: z.literal("text"),
    })
    .meta({
      ref: "OutputFormatText",
    })

  export const OutputFormatJsonSchema = z
    .object({
      type: z.literal("json_schema"),
      schema: z.record(z.string(), z.any()).meta({ ref: "JSONSchema" }),
      retryCount: z.number().int().min(0).default(2),
    })
    .meta({
      ref: "OutputFormatJsonSchema",
    })

  export const Format = z.discriminatedUnion("type", [OutputFormatText, OutputFormatJsonSchema]).meta({
    ref: "OutputFormat",
  })
  export type OutputFormat = z.infer<typeof Format>

  const PartBase = z.object({
    id: PartID.zod,
    sessionID: SessionID.zod,
    messageID: MessageID.zod,
  })

  export const SnapshotPart = PartBase.extend({
    type: z.literal("snapshot"),
    snapshot: z.string(),
  }).meta({
    ref: "SnapshotPart",
  })
  export type SnapshotPart = z.infer<typeof SnapshotPart>

  export const PatchPart = PartBase.extend({
    type: z.literal("patch"),
    hash: z.string(),
    files: z.string().array(),
  }).meta({
    ref: "PatchPart",
  })
  export type PatchPart = z.infer<typeof PatchPart>

  export const TextPart = PartBase.extend({
    type: z.literal("text"),
    text: z.string(),
    synthetic: z.boolean().optional(),
    ignored: z.boolean().optional(),
    time: z
      .object({
        start: z.number(),
        end: z.number().optional(),
      })
      .optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  }).meta({
    ref: "TextPart",
  })
  export type TextPart = z.infer<typeof TextPart>

  export const ReasoningPart = PartBase.extend({
    type: z.literal("reasoning"),
    text: z.string(),
    metadata: z.record(z.string(), z.any()).optional(),
    time: z.object({
      start: z.number(),
      end: z.number().optional(),
    }),
  }).meta({
    ref: "ReasoningPart",
  })
  export type ReasoningPart = z.infer<typeof ReasoningPart>

  const FilePartSourceBase = z.object({
    text: z
      .object({
        value: z.string(),
        start: z.number().int(),
        end: z.number().int(),
      })
      .meta({
        ref: "FilePartSourceText",
      }),
  })

  export const FileSource = FilePartSourceBase.extend({
    type: z.literal("file"),
    path: z.string(),
  }).meta({
    ref: "FileSource",
  })

  export const SymbolSource = FilePartSourceBase.extend({
    type: z.literal("symbol"),
    path: z.string(),
    range: LSP.Range,
    name: z.string(),
    kind: z.number().int(),
  }).meta({
    ref: "SymbolSource",
  })

  export const ResourceSource = FilePartSourceBase.extend({
    type: z.literal("resource"),
    clientName: z.string(),
    uri: z.string(),
  }).meta({
    ref: "ResourceSource",
  })

  export const FilePartSource = z.discriminatedUnion("type", [FileSource, SymbolSource, ResourceSource]).meta({
    ref: "FilePartSource",
  })

  export const FilePart = PartBase.extend({
    type: z.literal("file"),
    mime: z.string(),
    filename: z.string().optional(),
    url: z.string(),
    source: FilePartSource.optional(),
  }).meta({
    ref: "FilePart",
  })
  export type FilePart = z.infer<typeof FilePart>

  export const AgentPart = PartBase.extend({
    type: z.literal("agent"),
    name: z.string(),
    source: z
      .object({
        value: z.string(),
        start: z.number().int(),
        end: z.number().int(),
      })
      .optional(),
  }).meta({
    ref: "AgentPart",
  })
  export type AgentPart = z.infer<typeof AgentPart>

  export const CompactionPart = PartBase.extend({
    type: z.literal("compaction"),
    auto: z.boolean(),
    overflow: z.boolean().optional(),
    tail_start_id: MessageID.zod.optional(),
  }).meta({
    ref: "CompactionPart",
  })
  export type CompactionPart = z.infer<typeof CompactionPart>

  export const SubtaskPart = PartBase.extend({
    type: z.literal("subtask"),
    prompt: z.string(),
    description: z.string(),
    agent: z.string(),
    model: z
      .object({
        providerID: ProviderID.zod,
        modelID: ModelID.zod,
      })
      .optional(),
    command: z.string().optional(),
  }).meta({
    ref: "SubtaskPart",
  })
  export type SubtaskPart = z.infer<typeof SubtaskPart>

  export const RetryPart = PartBase.extend({
    type: z.literal("retry"),
    attempt: z.number(),
    error: APIError.Schema,
    time: z.object({
      created: z.number(),
    }),
  }).meta({
    ref: "RetryPart",
  })
  export type RetryPart = z.infer<typeof RetryPart>

  export const StepStartPart = PartBase.extend({
    type: z.literal("step-start"),
    snapshot: z.string().optional(),
  }).meta({
    ref: "StepStartPart",
  })
  export type StepStartPart = z.infer<typeof StepStartPart>

  export const StepFinishPart = PartBase.extend({
    type: z.literal("step-finish"),
    reason: z.string(),
    snapshot: z.string().optional(),
    cost: z.number(),
    response_id: z.string().optional(),
    tokens: z.object({
      total: z.number().optional(),
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cache: z.object({
        read: z.number(),
        write: z.number(),
      }),
    }),
  }).meta({
    ref: "StepFinishPart",
  })
  export type StepFinishPart = z.infer<typeof StepFinishPart>

  export const ToolStatePending = z
    .object({
      status: z.literal("pending"),
      input: z.record(z.string(), z.any()),
      raw: z.string(),
    })
    .meta({
      ref: "ToolStatePending",
    })

  export type ToolStatePending = z.infer<typeof ToolStatePending>

  export const ToolStateRunning = z
    .object({
      status: z.literal("running"),
      input: z.record(z.string(), z.any()),
      title: z.string().optional(),
      metadata: z.record(z.string(), z.any()).optional(),
      time: z.object({
        start: z.number(),
      }),
    })
    .meta({
      ref: "ToolStateRunning",
    })
  export type ToolStateRunning = z.infer<typeof ToolStateRunning>

  export const ToolStateCompleted = z
    .object({
      status: z.literal("completed"),
      input: z.record(z.string(), z.any()),
      output: z.string(),
      title: z.string(),
      metadata: z.record(z.string(), z.any()),
      time: z.object({
        start: z.number(),
        end: z.number(),
        compacted: z.number().optional(),
      }),
      attachments: FilePart.array().optional(),
    })
    .meta({
      ref: "ToolStateCompleted",
    })
  export type ToolStateCompleted = z.infer<typeof ToolStateCompleted>

  function truncateToolOutput(text: string, maxChars?: number) {
    if (!maxChars || text.length <= maxChars) return text
    const omitted = text.length - maxChars
    return `${text.slice(0, maxChars)}\n[Tool output truncated for compaction: omitted ${omitted} chars]`
  }

  // [fork-perf] strip-thinking
  // Strips inline <thinking>...</thinking> blocks from assistant text parts.
  // These are transient CoT emitted by models without extended-thinking enabled
  // (e.g. claude-opus-4-6/4-7 in standard mode). They add ~300-1000 input tokens
  // per turn without aiding the model's next reasoning step.
  // Unclosed tags (streaming partial) are stripped to end-of-string via (?:</thinking>|$).
  export function stripThinkingTags(text: string): string {
    return text.replace(/<thinking>[\s\S]*?(?:<\/thinking>|$)/g, "").trim()
  }

  export const ToolStateError = z
    .object({
      status: z.literal("error"),
      input: z.record(z.string(), z.any()),
      error: z.string(),
      metadata: z.record(z.string(), z.any()).optional(),
      time: z.object({
        start: z.number(),
        end: z.number(),
      }),
    })
    .meta({
      ref: "ToolStateError",
    })
  export type ToolStateError = z.infer<typeof ToolStateError>

  export const ToolState = z
    .discriminatedUnion("status", [ToolStatePending, ToolStateRunning, ToolStateCompleted, ToolStateError])
    .meta({
      ref: "ToolState",
    })

  export const ToolPart = PartBase.extend({
    type: z.literal("tool"),
    callID: z.string(),
    tool: z.string(),
    state: ToolState,
    metadata: z.record(z.string(), z.any()).optional(),
  }).meta({
    ref: "ToolPart",
  })
  export type ToolPart = z.infer<typeof ToolPart>

  const Base = z.object({
    id: MessageID.zod,
    sessionID: SessionID.zod,
  })

  export const User = Base.extend({
    role: z.literal("user"),
    time: z.object({
      created: z.number(),
    }),
    format: Format.optional(),
    summary: z
      .object({
        title: z.string().optional(),
        body: z.string().optional(),
        diffs: Snapshot.FileDiff.array(),
      })
      .optional(),
    agent: z.string(),
    model: z.object({
      providerID: ProviderID.zod,
      modelID: ModelID.zod,
      variant: z.string().optional(),
    }),
    system: z.string().optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
  }).meta({
    ref: "UserMessage",
  })
  export type User = z.infer<typeof User>

  export const Part = z
    .discriminatedUnion("type", [
      TextPart,
      SubtaskPart,
      ReasoningPart,
      FilePart,
      ToolPart,
      StepStartPart,
      StepFinishPart,
      SnapshotPart,
      PatchPart,
      AgentPart,
      RetryPart,
      CompactionPart,
    ])
    .meta({
      ref: "Part",
    })
  export type Part = z.infer<typeof Part>

  export const Assistant = Base.extend({
    role: z.literal("assistant"),
    time: z.object({
      created: z.number(),
      completed: z.number().optional(),
    }),
    error: z
      .discriminatedUnion("name", [
        AuthError.Schema,
        NamedError.Unknown.Schema,
        OutputLengthError.Schema,
        AbortedError.Schema,
        StructuredOutputError.Schema,
        ContentFilterError.Schema,
        ContextOverflowError.Schema,
        APIError.Schema,
      ])
      .optional(),
    parentID: MessageID.zod,
    modelID: ModelID.zod,
    providerID: ProviderID.zod,
    /**
     * @deprecated
     */
    mode: z.string(),
    agent: z.string(),
    path: z.object({
      cwd: z.string(),
      root: z.string(),
    }),
    summary: z.boolean().optional(),
    cost: z.number(),
    tokens: z.object({
      total: z.number().optional(),
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cache: z.object({
        read: z.number(),
        write: z.number(),
      }),
    }),
    compaction: z
      .object({
        total: z.number(),
        savings: z.number().optional(),
        sent: z.number().optional(),
        tail: z.number().optional(),
        budget: z.number().optional(),
        msgs: z.number(),
      })
      .optional(),
    structured: z.any().optional(),
    variant: z.string().optional(),
    finish: z.string().optional(),
  }).meta({
    ref: "AssistantMessage",
  })
  export type Assistant = z.infer<typeof Assistant>

  export const Info = z.discriminatedUnion("role", [User, Assistant]).meta({
    ref: "Message",
  })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: SyncEvent.define({
      type: "message.updated",
      version: 1,
      aggregate: "sessionID",
      schema: z.object({
        sessionID: SessionID.zod,
        info: Info,
      }),
    }),
    Removed: SyncEvent.define({
      type: "message.removed",
      version: 1,
      aggregate: "sessionID",
      schema: z.object({
        sessionID: SessionID.zod,
        messageID: MessageID.zod,
      }),
    }),
    PartUpdated: SyncEvent.define({
      type: "message.part.updated",
      version: 1,
      aggregate: "sessionID",
      schema: z.object({
        sessionID: SessionID.zod,
        part: Part,
        time: z.number(),
      }),
    }),
    PartDelta: BusEvent.define(
      "message.part.delta",
      z.object({
        sessionID: SessionID.zod,
        messageID: MessageID.zod,
        partID: PartID.zod,
        field: z.string(),
        delta: z.string(),
      }),
    ),
    PartRemoved: SyncEvent.define({
      type: "message.part.removed",
      version: 1,
      aggregate: "sessionID",
      schema: z.object({
        sessionID: SessionID.zod,
        messageID: MessageID.zod,
        partID: PartID.zod,
      }),
    }),
  }

  export const WithParts = z.object({
    info: Info,
    parts: z.array(Part),
  })
  export type WithParts = z.infer<typeof WithParts>

  const Cursor = z.object({
    id: MessageID.zod,
    time: z.number(),
  })
  type Cursor = z.infer<typeof Cursor>

  export const cursor = {
    encode(input: Cursor) {
      return Buffer.from(JSON.stringify(input)).toString("base64url")
    },
    decode(input: string) {
      return Cursor.parse(JSON.parse(Buffer.from(input, "base64url").toString("utf8")))
    },
  }

  const info = (row: typeof MessageTable.$inferSelect) => {
    const result = {
      ...row.data,
      id: row.id,
      sessionID: row.session_id,
    } as MessageV2.Info
    // Strip heavy summary.diffs from memory — can be 50+ MB per message.
    // TUI fetches diffs via dedicated session.diff() endpoint instead.
    if (result.role === "user" && result.summary?.diffs?.length) {
      result.summary = { ...result.summary, diffs: [] }
    }
    return result
  }

  const part = (row: typeof PartTable.$inferSelect) =>
    ({
      ...row.data,
      id: row.id,
      sessionID: row.session_id,
      messageID: row.message_id,
    }) as MessageV2.Part

  const older = (row: Cursor) =>
    or(
      lt(MessageTable.time_created, row.time),
      and(eq(MessageTable.time_created, row.time), lt(MessageTable.id, row.id)),
    )

  function hydrate(rows: (typeof MessageTable.$inferSelect)[]) {
    const ids = rows.map((row) => row.id)
    const partByMessage = new Map<string, MessageV2.Part[]>()
    if (ids.length > 0) {
      const partRows = Database.use((db) =>
        db
          .select()
          .from(PartTable)
          .where(inArray(PartTable.message_id, ids))
          .orderBy(PartTable.message_id, PartTable.id)
          .all(),
      )
      for (const row of partRows) {
        const next = part(row)
        const list = partByMessage.get(row.message_id)
        if (list) list.push(next)
        else partByMessage.set(row.message_id, [next])
      }
    }

    return rows.map((row) => ({
      info: info(row),
      parts: partByMessage.get(row.id) ?? [],
    }))
  }

  function providerMeta(metadata: Record<string, any> | undefined) {
    if (!metadata) return undefined
    // [fork-perf] strip non-provider-namespaced flags. `terminal` is set by
    // hybrid-compression / coalescer (processor.ts) — it's a fork-internal
    // signal, not a provider option. Leaving it in produces
    // `providerOptions: { terminal: true }` which fails AI SDK's
    // ModelMessage[] schema validation and triggers an infinite retry loop.
    const { providerExecuted: _, terminal: __, ...rest } = metadata
    return Object.keys(rest).length > 0 ? rest : undefined
  }

  export const toModelMessagesEffect = Effect.fnUntraced(function* (
    input: WithParts[],
    model: Provider.Model,
    options?: { stripMedia?: boolean; toolOutputMaxChars?: number; stripThinkingText?: boolean }, // [fork-perf] strip-thinking
  ) {
    const result: UIMessage[] = []
    const toolNames = new Set<string>()
    // Track media from tool results that need to be injected as user messages
    // for providers that don't support that media type in tool results.
    //
    // OpenAI-compatible APIs only support string content in tool results, so we need
    // to extract media and inject as user messages. Some SDKs only support a subset
    // of media in tool results; e.g. Bedrock supports images but not PDFs there.
    //
    // Only apply this workaround if the model actually supports that media input -
    // otherwise unsupportedParts() will turn it into a user-visible error.
    const supportsMediaInToolResult = (attachment: { mime: string }) => {
      if (model.api.npm === "@ai-sdk/anthropic") return true
      if (model.api.npm === "@ai-sdk/openai") return true
      if (model.api.npm === "@ai-sdk/amazon-bedrock") return attachment.mime.startsWith("image/")
      if (model.api.npm === "@ai-sdk/google-vertex/anthropic") return true
      if (model.api.npm === "@ai-sdk/google") {
        const id = model.api.id.toLowerCase()
        return id.includes("gemini-3") && !id.includes("gemini-2")
      }
      return false
    }

    const toModelOutput = (options: { toolCallId: string; input: unknown; output: unknown }) => {
      const output = options.output
      if (typeof output === "string") {
        return { type: "text", value: output }
      }

      if (typeof output === "object") {
        const outputObject = output as {
          text: string
          attachments?: Array<{ mime: string; url: string }>
        }
        const attachments = (outputObject.attachments ?? []).filter((attachment) => {
          return attachment.url.startsWith("data:") && attachment.url.includes(",")
        })

        return {
          type: "content",
          value: [
            { type: "text", text: outputObject.text },
            ...attachments.map((attachment) => ({
              type: "media",
              mediaType: attachment.mime,
              data: iife(() => {
                const commaIndex = attachment.url.indexOf(",")
                return commaIndex === -1 ? attachment.url : attachment.url.slice(commaIndex + 1)
              }),
            })),
          ],
        }
      }

      return { type: "json", value: output as never }
    }

    for (const msg of input) {
      if (msg.parts.length === 0) continue

      if (msg.info.role === "user") {
        const userMessage: UIMessage = {
          id: msg.info.id,
          role: "user",
          parts: [],
        }
        for (const part of msg.parts) {
          // User message parts should never be empty
          if (part.type === "text" && !part.ignored && part.text !== "")
            userMessage.parts.push({
              type: "text",
              text: part.text,
            })
          if (part.type === "file" && part.mime !== "text/plain" && part.mime !== "application/x-directory") {
            if (options?.stripMedia && isMedia(part.mime)) {
              userMessage.parts.push({
                type: "text",
                text: `[Attached ${part.mime}: ${part.filename ?? "file"}]`,
              })
            } else {
              userMessage.parts.push({
                type: "file",
                url: part.url,
                mediaType: part.mime,
                filename: part.filename,
              })
            }
          }

          if (part.type === "compaction") {
            userMessage.parts.push({
              type: "text",
              text: "What did we do so far?",
            })
          }
          if (part.type === "subtask") {
            userMessage.parts.push({
              type: "text",
              text: "The following tool was executed by the user",
            })
          }
        }
        if (userMessage.parts.length > 0) result.push(userMessage)
      }

      if (msg.info.role === "assistant") {
        const differentModel = `${model.providerID}/${model.id}` !== `${msg.info.providerID}/${msg.info.modelID}`
        const media: Array<{ mime: string; url: string; filename?: string }> = []

        if (
          msg.info.error &&
          !(
            MessageV2.AbortedError.isInstance(msg.info.error) &&
            msg.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning")
          )
        ) {
          continue
        }
        const assistantMessage: UIMessage = {
          id: msg.info.id,
          role: "assistant",
          parts: [],
        }
        const hasSignedReasoning = msg.parts.some((part) => {
          if (part.type !== "reasoning") return false
          return part.metadata?.anthropic?.signature != null || part.metadata?.bedrock?.signature != null
        })
        for (const part of msg.parts) {
          if (part.type === "text") {
            const rawText = part.text === "" && hasSignedReasoning ? " " : part.text
            // [fork-perf] strip-thinking: remove inline CoT tags from assistant text before sending to model
            const text = options?.stripThinkingText ? stripThinkingTags(rawText) : rawText
            assistantMessage.parts.push({
              type: "text",
              text,
              ...(differentModel ? {} : { providerMetadata: part.metadata }),
            })
          }
          if (part.type === "step-start")
            assistantMessage.parts.push({
              type: "step-start",
            })
          if (part.type === "tool") {
            toolNames.add(part.tool)
            if (part.state.status === "completed") {
              const outputText = part.state.time.compacted
                ? "[Old tool result content cleared]"
                : truncateToolOutput(part.state.output, options?.toolOutputMaxChars)
              const attachments = part.state.time.compacted || options?.stripMedia ? [] : (part.state.attachments ?? [])

              // For providers that don't support media in tool results, extract media files
              // (images, PDFs) to be sent as a separate user message
              const mediaAttachments = attachments.filter((a) => isMedia(a.mime))
              const extractedMedia = mediaAttachments.filter((a) => !supportsMediaInToolResult(a))
              if (extractedMedia.length > 0) {
                media.push(...extractedMedia)
              }
              const finalAttachments = attachments.filter((a) => !isMedia(a.mime) || supportsMediaInToolResult(a))

              const output =
                finalAttachments.length > 0
                  ? {
                      text: outputText,
                      attachments: finalAttachments,
                    }
                  : outputText

              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-available",
                toolCallId: part.callID,
                input: part.state.input,
                output,
                ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
              })
            }
            if (part.state.status === "error") {
              const output = part.state.metadata?.interrupted === true ? part.state.metadata.output : undefined
              if (typeof output === "string") {
                assistantMessage.parts.push({
                  type: ("tool-" + part.tool) as `tool-${string}`,
                  state: "output-available",
                  toolCallId: part.callID,
                  input: part.state.input,
                  output,
                  ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                  ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
                })
              } else {
                assistantMessage.parts.push({
                  type: ("tool-" + part.tool) as `tool-${string}`,
                  state: "output-error",
                  toolCallId: part.callID,
                  input: part.state.input,
                  errorText: part.state.error,
                  ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                  ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
                })
              }
            }
            // Handle pending/running tool calls to prevent dangling tool_use blocks
            // Anthropic/Claude APIs require every tool_use to have a corresponding tool_result
            if (part.state.status === "pending" || part.state.status === "running")
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-error",
                toolCallId: part.callID,
                input: part.state.input,
                errorText: "[Tool execution was interrupted]",
                ...(part.metadata?.providerExecuted ? { providerExecuted: true } : {}),
                ...(differentModel ? {} : { callProviderMetadata: providerMeta(part.metadata) }),
              })
          }
          if (part.type === "reasoning") {
            // [fork-perf] thinking-integrity: skip empty-text reasoning parts that carry only a
            // signature (e.g. proxies emitting signature_delta without thinking_delta).
            // Anthropic rejects on replay with `messages.X.content.Y: thinking blocks cannot be
            // modified` because empty text + signature does not match original response.
            const hasSig = part.metadata?.anthropic?.signature != null || part.metadata?.bedrock?.signature != null
            if (!part.text && hasSig) continue
            assistantMessage.parts.push({
              type: "reasoning",
              text: part.text,
              ...(differentModel ? {} : { providerMetadata: part.metadata }),
            })
          }
        }
        if (assistantMessage.parts.length > 0) {
          result.push(assistantMessage)
          // Inject pending media as a user message for providers that don't support
          // media (images, PDFs) in tool results
          if (media.length > 0) {
            result.push({
              id: MessageID.ascending(),
              role: "user",
              parts: [
                {
                  type: "text" as const,
                  text: SYNTHETIC_ATTACHMENT_PROMPT,
                },
                ...media.map((attachment) => ({
                  type: "file" as const,
                  url: attachment.url,
                  mediaType: attachment.mime,
                  filename: attachment.filename,
                })),
              ],
            })
          }
        }
      }
    }

    const tools = Object.fromEntries(Array.from(toolNames).map((toolName) => [toolName, { toModelOutput }]))

    return yield* Effect.promise(() =>
      convertToModelMessages(
        result.filter((msg) => msg.parts.some((part) => part.type !== "step-start")),
        {
          //@ts-expect-error (convertToModelMessages expects a ToolSet but only actually needs tools[name]?.toModelOutput)
          tools,
        },
      ),
    )
  })

  export function toModelMessages(
    input: WithParts[],
    model: Provider.Model,
    options?: { stripMedia?: boolean; toolOutputMaxChars?: number; stripThinkingText?: boolean }, // [fork-perf] strip-thinking
  ): Promise<ModelMessage[]> {
    return Effect.runPromise(toModelMessagesEffect(input, model, options))
  }

  export function page(input: { sessionID: SessionID; limit: number; before?: string }) {
    const before = input.before ? cursor.decode(input.before) : undefined
    const where = before
      ? and(eq(MessageTable.session_id, input.sessionID), older(before))
      : eq(MessageTable.session_id, input.sessionID)
    const rows = Database.use((db) =>
      db
        .select()
        .from(MessageTable)
        .where(where)
        .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
        .limit(input.limit + 1)
        .all(),
    )
    if (rows.length === 0) {
      const row = Database.use((db) =>
        db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.id, input.sessionID)).get(),
      )
      if (!row) throw new NotFoundError({ message: `Session not found: ${input.sessionID}` })
      return {
        items: [] as MessageV2.WithParts[],
        more: false,
      }
    }

    const more = rows.length > input.limit
    const slice = more ? rows.slice(0, input.limit) : rows
    const items = hydrate(slice)
    items.reverse()
    const tail = slice.at(-1)
    return {
      items,
      more,
      cursor: more && tail ? cursor.encode({ id: tail.id, time: tail.time_created }) : undefined,
    }
  }

  export function* stream(sessionID: SessionID) {
    const size = 50
    let before: string | undefined
    while (true) {
      const next = page({ sessionID, limit: size, before })
      if (next.items.length === 0) break
      for (let i = next.items.length - 1; i >= 0; i--) {
        yield next.items[i]
      }
      if (!next.more || !next.cursor) break
      before = next.cursor
    }
  }

  export const streamAfterEffect = Effect.fnUntraced(function* (input: {
    sessionID: SessionID
    after: {
      id: MessageID
      time: number
    }
  }) {
    const rows = Database.use((db) =>
      db
        .select()
        .from(MessageTable)
        .where(
          and(
            eq(MessageTable.session_id, input.sessionID),
            or(
              gt(MessageTable.time_created, input.after.time),
              and(eq(MessageTable.time_created, input.after.time), gt(MessageTable.id, input.after.id)),
            ),
          ),
        )
        .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
        .all(),
    )
    return hydrate(rows)
  })

  export function parts(message_id: MessageID) {
    const rows = Database.use((db) =>
      db.select().from(PartTable).where(eq(PartTable.message_id, message_id)).orderBy(PartTable.id).all(),
    )
    return rows.map(
      (row) =>
        ({
          ...row.data,
          id: row.id,
          sessionID: row.session_id,
          messageID: row.message_id,
        }) as MessageV2.Part,
    )
  }

  export function get(input: { sessionID: SessionID; messageID: MessageID }): WithParts {
    const row = Database.use((db) =>
      db
        .select()
        .from(MessageTable)
        .where(and(eq(MessageTable.id, input.messageID), eq(MessageTable.session_id, input.sessionID)))
        .get(),
    )
    if (!row) throw new NotFoundError({ message: `Message not found: ${input.messageID}` })
    return {
      info: info(row),
      parts: parts(input.messageID),
    }
  }

  export function filterCompacted(msgs: Iterable<MessageV2.WithParts>) {
    const result = [] as MessageV2.WithParts[]
    const completed = new Set<string>()
    let retain: MessageID | undefined
    for (const msg of msgs) {
      result.push(msg)
      if (retain) {
        if (msg.info.id === retain) break
        continue
      }
      if (msg.info.role === "user" && completed.has(msg.info.id)) {
        const part = msg.parts.find((item): item is MessageV2.CompactionPart => item.type === "compaction")
        if (!part) continue
        if (!part.tail_start_id) break
        retain = part.tail_start_id
        if (msg.info.id === retain) break
        continue
      }
      if (
        msg.info.role === "user" &&
        completed.has(msg.info.id) &&
        msg.parts.some((part) => part.type === "compaction")
      )
        break
      if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish && !msg.info.error)
        completed.add(msg.info.parentID)
    }
    result.reverse()
    const compactionIndex = result.findLastIndex(
      (msg) =>
        msg.info.role === "user" &&
        msg.parts.some(
          (item): item is CompactionPart => item.type === "compaction" && item.tail_start_id !== undefined,
        ),
    )
    const compaction = result[compactionIndex]
    const part = compaction?.parts.find(
      (item): item is CompactionPart => item.type === "compaction" && item.tail_start_id !== undefined,
    )
    const summaryIndex = compaction
      ? result.findIndex(
          (msg, index) =>
            index > compactionIndex &&
            msg.info.role === "assistant" &&
            msg.info.summary &&
            msg.info.parentID === compaction.info.id,
        )
      : -1
    const tailIndex = part?.tail_start_id ? result.findIndex((msg) => msg.info.id === part.tail_start_id) : -1
    if (tailIndex >= 0 && tailIndex < compactionIndex && summaryIndex > compactionIndex) {
      return [
        ...result.slice(compactionIndex, summaryIndex + 1),
        ...result.slice(tailIndex, compactionIndex),
        ...result.slice(summaryIndex + 1),
      ]
    }
    return result
  }

  export const filterCompactedEffect = Effect.fnUntraced(function* (sessionID: SessionID) {
    return filterCompacted(stream(sessionID))
  })

  /**
   * Returns a stable order-aware fingerprint for a message list. // [fork-perf] cache-stability
   * Detects reorders (e.g. filterCompacted) that don't change array length but
   * would break Anthropic cache breakpoints.
   * Format: "id:partsLen|id:partsLen|..."
   */
  export function msgsFingerprint(msgs: WithParts[]): string {
    return msgs.map((m) => `${m.info.id}:${m.parts.length}`).join("|")
  }

  // filterCompacted reorders messages for model consumption
  // ([compaction-user, summary, ...retained tail..., continue-user]), so array
  // position is not chronological. Derive each binding by max id (MessageID
  // is monotonic via MessageID.ascending) so a pre-compaction overflowing tail
  // assistant doesn't get mistaken for the most recent turn. tasks are
  // compaction/subtask parts attached to user messages newer than the latest
  // finished assistant — i.e. unprocessed work.
  export function latest(msgs: WithParts[]) {
    let user: User | undefined
    let assistant: Assistant | undefined
    let finished: Assistant | undefined
    for (const msg of msgs) {
      const info = msg.info
      if (info.role === "user" && (!user || info.id > user.id)) user = info
      if (info.role === "assistant" && (!assistant || info.id > assistant.id)) assistant = info
      if (info.role === "assistant" && info.finish && (!finished || info.id > finished.id)) finished = info
    }
    const tasks = msgs.flatMap((m) =>
      finished && m.info.id <= finished.id
        ? []
        : m.parts.filter((p): p is CompactionPart | SubtaskPart => p.type === "compaction" || p.type === "subtask"),
    )
    return { user, assistant, finished, tasks }
  }

  export function fromError(
    e: unknown,
    ctx: { providerID: ProviderID; aborted?: boolean },
  ): NonNullable<Assistant["error"]> {
    switch (true) {
      case e instanceof DOMException && e.name === "AbortError":
        return new MessageV2.AbortedError(
          { message: e.message },
          {
            cause: e,
          },
        ).toObject()
      case MessageV2.OutputLengthError.isInstance(e):
        return e
      case LoadAPIKeyError.isInstance(e):
        return new MessageV2.AuthError(
          {
            providerID: ctx.providerID,
            message: e.message,
          },
          { cause: e },
        ).toObject()
      case (e as SystemError)?.code === "ECONNRESET":
        return new MessageV2.APIError(
          {
            message: "Connection reset by server",
            isRetryable: true,
            metadata: {
              code: (e as SystemError).code ?? "",
              syscall: (e as SystemError).syscall ?? "",
              message: (e as SystemError).message ?? "",
            },
          },
          { cause: e },
        ).toObject()
      case e instanceof Error && e.message === "SSE read timed out":
        return new MessageV2.APIError(
          {
            message: "Stream stalled (no data received)",
            isRetryable: true,
          },
          { cause: e },
        ).toObject()
      case e instanceof Error && (e as FetchDecompressionError).code === "ZlibError":
        if (ctx.aborted) {
          return new MessageV2.AbortedError({ message: e.message }, { cause: e }).toObject()
        }
        return new MessageV2.APIError(
          {
            message: "Response decompression failed",
            isRetryable: true,
            metadata: {
              code: (e as FetchDecompressionError).code,
              message: e.message,
            },
          },
          { cause: e },
        ).toObject()
      case e instanceof ProviderError.HeaderTimeoutError:
        return new APIError(
          {
            message: e.message,
            isRetryable: true,
            metadata: {
              code: e.name,
              timeoutMs: String(e.ms),
            },
          },
          { cause: e },
        ).toObject()
      case APICallError.isInstance(e):
        const parsed = ProviderError.parseAPICallError({
          providerID: ctx.providerID,
          error: e,
        })
        if (parsed.type === "context_overflow") {
          return new MessageV2.ContextOverflowError(
            {
              message: parsed.message,
              responseBody: parsed.responseBody,
            },
            { cause: e },
          ).toObject()
        }

        return new MessageV2.APIError(
          {
            message: parsed.message,
            statusCode: parsed.statusCode,
            isRetryable: parsed.isRetryable,
            responseHeaders: parsed.responseHeaders,
            responseBody: parsed.responseBody,
            metadata: parsed.metadata,
          },
          { cause: e },
        ).toObject()
      case e instanceof Error:
        return new NamedError.Unknown({ message: errorMessage(e) }, { cause: e }).toObject()
      default:
        try {
          const parsed = ProviderError.parseStreamError(e)
          if (parsed) {
            if (parsed.type === "context_overflow") {
              return new MessageV2.ContextOverflowError(
                {
                  message: parsed.message,
                  responseBody: parsed.responseBody,
                },
                { cause: e },
              ).toObject()
            }
            return new MessageV2.APIError(
              {
                message: parsed.message,
                isRetryable: parsed.isRetryable,
                responseBody: parsed.responseBody,
              },
              {
                cause: e,
              },
            ).toObject()
          }
        } catch {}
        return new NamedError.Unknown({ message: JSON.stringify(e) }, { cause: e }).toObject()
    }
  }
}
