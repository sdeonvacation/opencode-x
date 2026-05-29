import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { MessageV2 } from "../../src/session/message-v2"
import type { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { Question } from "../../src/question"

const sessionID = SessionID.make("session")
const providerID = ProviderID.make("test")
const model: Provider.Model = {
  id: ModelID.make("test-model"),
  providerID,
  api: {
    id: "test-model",
    url: "https://example.com",
    npm: "@ai-sdk/openai",
  },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    interleaved: false,
  },
  cost: {
    input: 0,
    output: 0,
    cache: {
      read: 0,
      write: 0,
    },
  },
  limit: {
    context: 0,
    input: 0,
    output: 0,
  },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

function userInfo(id: string): MessageV2.User {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "user",
    model: { providerID, modelID: ModelID.make("test") },
    tools: {},
    mode: "",
  } as unknown as MessageV2.User
}

function assistantInfo(
  id: string,
  parentID: string,
  error?: MessageV2.Assistant["error"],
  meta?: { providerID: string; modelID: string },
): MessageV2.Assistant {
  const infoModel = meta ?? { providerID: model.providerID, modelID: model.api.id }
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 0 },
    error,
    parentID,
    modelID: infoModel.modelID,
    providerID: infoModel.providerID,
    mode: "",
    agent: "agent",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  } as unknown as MessageV2.Assistant
}

function basePart(messageID: string, id: string) {
  return {
    id: PartID.make(id),
    sessionID,
    messageID: MessageID.make(messageID),
  }
}

describe("session.message-v2.toModelMessage", () => {
  test("filters out messages with no parts", async () => {
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo("m-empty"),
        parts: [],
      },
      {
        info: userInfo("m-user"),
        parts: [
          {
            ...basePart("m-user", "p1"),
            type: "text",
            text: "hello",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ])
  })

  test("filters out messages with only ignored parts", async () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "ignored",
            ignored: true,
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("includes synthetic text parts", async () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "hello",
            synthetic: true,
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo("m-assistant", messageID),
        parts: [
          {
            ...basePart("m-assistant", "a1"),
            type: "text",
            text: "assistant",
            synthetic: true,
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "assistant" }],
      },
    ])
  })

  test("converts user text/file parts and injects compaction/subtask prompts", async () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "hello",
          },
          {
            ...basePart(messageID, "p2"),
            type: "text",
            text: "ignored",
            ignored: true,
          },
          {
            ...basePart(messageID, "p3"),
            type: "file",
            mime: "image/png",
            filename: "img.png",
            url: "https://example.com/img.png",
          },
          {
            ...basePart(messageID, "p4"),
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "https://example.com/note.txt",
          },
          {
            ...basePart(messageID, "p5"),
            type: "file",
            mime: "application/x-directory",
            filename: "dir",
            url: "https://example.com/dir",
          },
          {
            ...basePart(messageID, "p6"),
            type: "compaction",
            auto: true,
          },
          {
            ...basePart(messageID, "p7"),
            type: "subtask",
            prompt: "prompt",
            description: "desc",
            agent: "agent",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          {
            type: "file",
            mediaType: "image/png",
            filename: "img.png",
            data: "https://example.com/img.png",
          },
          { type: "text", text: "What did we do so far?" },
          { type: "text", text: "The following tool was executed by the user" },
        ],
      },
    ])
  })

  test("converts assistant tool completion into tool-call + tool-result messages with attachments", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "done",
            metadata: { openai: { assistant: "meta" } },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "ok",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1 },
              attachments: [
                {
                  ...basePart(assistantID, "file-1"),
                  type: "file",
                  mime: "image/png",
                  filename: "attachment.png",
                  url: "data:image/png;base64,Zm9v",
                },
              ],
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "done", providerOptions: { openai: { assistant: "meta" } } },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: {
              type: "content",
              value: [
                { type: "text", text: "ok" },
                { type: "media", mediaType: "image/png", data: "Zm9v" },
              ],
            },
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
    ])
  })

  test("omits provider metadata when assistant model differs", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID, undefined, { providerID: "other", modelID: "other" }),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "done",
            metadata: { openai: { assistant: "meta" } },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "ok",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1 },
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "done" },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ])
  })

  test("replaces compacted tool output with placeholder", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "this should be cleared",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1, compacted: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "[Old tool result content cleared]" },
          },
        ],
      },
    ])
  })

  test("truncates tool output when requested", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "abcdefghij",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model, { toolOutputMaxChars: 4 })).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: {
              type: "text",
              value: "abcd\n[Tool output truncated for compaction: omitted 6 chars]",
            },
          },
        ],
      },
    ])
  })

  test("converts assistant tool error into error-text tool result", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "error",
              input: { cmd: "ls" },
              error: "nope",
              time: { start: 0, end: 1 },
              metadata: {},
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "error-text", value: "nope" },
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
    ])
  })

  test("forwards partial bash output for aborted tool calls", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"
    const output = [
      "31403",
      "12179",
      "4575",
      "",
      "<bash_metadata>",
      "User aborted the command",
      "</bash_metadata>",
    ].join("\n")

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "error",
              input: { command: "for i in {1..20}; do print -- $RANDOM; sleep 1; done" },
              error: "Tool execution aborted",
              metadata: { interrupted: true, output },
              time: { start: 0, end: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { command: "for i in {1..20}; do print -- $RANDOM; sleep 1; done" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: output },
          },
        ],
      },
    ])
  })

  test("filters assistant messages with non-abort errors", async () => {
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(
          assistantID,
          "m-parent",
          new MessageV2.APIError({ message: "boom", isRetryable: true }).toObject() as MessageV2.APIError,
        ),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "should not render",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("includes aborted assistant messages only when they have non-step-start/reasoning content", async () => {
    const assistantID1 = "m-assistant-1"
    const assistantID2 = "m-assistant-2"

    const aborted = new MessageV2.AbortedError({ message: "aborted" }).toObject() as MessageV2.Assistant["error"]

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID1, "m-parent", aborted),
        parts: [
          {
            ...basePart(assistantID1, "a1"),
            type: "reasoning",
            text: "thinking",
            time: { start: 0 },
          },
          {
            ...basePart(assistantID1, "a2"),
            type: "text",
            text: "partial answer",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID2, "m-parent", aborted),
        parts: [
          {
            ...basePart(assistantID2, "b1"),
            type: "step-start",
          },
          {
            ...basePart(assistantID2, "b2"),
            type: "reasoning",
            text: "thinking",
            time: { start: 0 },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking", providerOptions: undefined },
          { type: "text", text: "partial answer" },
        ],
      },
    ])
  })

  test("splits assistant messages on step-start boundaries", async () => {
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "text",
            text: "first",
          },
          {
            ...basePart(assistantID, "p2"),
            type: "step-start",
          },
          {
            ...basePart(assistantID, "p3"),
            type: "text",
            text: "second",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "first" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "second" }],
      },
    ])
  })

  test("drops messages that only contain step-start parts", async () => {
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "step-start",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("converts pending/running tool calls to error results to prevent dangling tool_use", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-pending",
            tool: "bash",
            state: {
              status: "pending",
              input: { cmd: "ls" },
              raw: "",
            },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "tool",
            callID: "call-running",
            tool: "read",
            state: {
              status: "running",
              input: { path: "/tmp" },
              time: { start: 0 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    expect(result).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-pending",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
          {
            type: "tool-call",
            toolCallId: "call-running",
            toolName: "read",
            input: { path: "/tmp" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-pending",
            toolName: "bash",
            output: { type: "error-text", value: "[Tool execution was interrupted]" },
          },
          {
            type: "tool-result",
            toolCallId: "call-running",
            toolName: "read",
            output: { type: "error-text", value: "[Tool execution was interrupted]" },
          },
        ],
      },
    ])
  })

  test("substitutes space for empty text between signed reasoning blocks", async () => {
    // Reproduces the bug pattern: [reasoning(sig), text(""), reasoning(sig), text(full)]
    const assistantID = "m-assistant"
    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          { ...basePart(assistantID, "p1"), type: "step-start" },
          {
            ...basePart(assistantID, "p2"),
            type: "reasoning",
            text: "thinking-one",
            metadata: { anthropic: { signature: "sig1" } },
          },
          { ...basePart(assistantID, "p3"), type: "text", text: "" },
          { ...basePart(assistantID, "p4"), type: "step-start" },
          {
            ...basePart(assistantID, "p5"),
            type: "reasoning",
            text: "thinking-two",
            metadata: { anthropic: { signature: "sig2" } },
          },
          { ...basePart(assistantID, "p6"), type: "text", text: "the answer" },
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    // step-start splits into two assistant messages; SDK's groupIntoBlocks merges them later
    expect(result).toHaveLength(2)
    expect((result[0].content as any[]).find((p) => p.type === "text").text).toBe(" ")
    expect((result[1].content as any[]).find((p) => p.type === "text").text).toBe("the answer")
  })

  test("substitutes space for empty text when reasoning signature is under 'bedrock' namespace", async () => {
    // AWS Bedrock hosts Anthropic Claude but stores signatures under metadata.bedrock
    const assistantID = "m-assistant-bedrock"
    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "reasoning",
            text: "thinking-bedrock",
            metadata: { bedrock: { signature: "bedrock-sig" } },
          },
          { ...basePart(assistantID, "p2"), type: "text", text: "" },
          { ...basePart(assistantID, "p3"), type: "text", text: "answer" },
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    expect(result).toHaveLength(1)
    const texts = (result[0].content as any[]).filter((p) => p.type === "text")
    expect(texts.map((t) => t.text)).toStrictEqual([" ", "answer"])
  })

  test("leaves empty text alone when reasoning has no Anthropic signature", async () => {
    // Non-Anthropic providers' reasoning doesn't position-validate, so empty text
    // should be filtered normally rather than substituted.
    const assistantID = "m-assistant-unsigned"
    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          { ...basePart(assistantID, "p1"), type: "reasoning", text: "thinking" },
          { ...basePart(assistantID, "p2"), type: "text", text: "" },
          { ...basePart(assistantID, "p3"), type: "text", text: "answer" },
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    expect(result).toHaveLength(1)
    const texts = (result[0].content as any[]).filter((p) => p.type === "text")
    expect(texts.map((t) => t.text)).toStrictEqual(["", "answer"])
  })

  test("leaves empty text alone in assistant messages without reasoning", async () => {
    const assistantID = "m-assistant-no-reasoning"
    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          { ...basePart(assistantID, "p1"), type: "text", text: "" },
          { ...basePart(assistantID, "p2"), type: "text", text: "hello" },
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    expect(result).toHaveLength(1)
    const texts = (result[0].content as any[]).filter((p) => p.type === "text")
    expect(texts.map((t) => t.text)).toStrictEqual(["", "hello"])
  })

  // [fork-perf] regression: hybrid-compression writes `metadata: { terminal: true }`
  // to flush the part-coalescer. Without stripping, this leaks into the
  // ModelMessage tool-call as `providerOptions: { terminal: true }` which
  // fails AI SDK's `modelMessageSchema` validation and triggers an infinite
  // retry loop ("Invalid prompt: messages do not match the ModelMessage[] schema").
  test("strips top-level `terminal` flag from tool callProviderMetadata", async () => {
    const messageID = "m-asst"
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo("m-user"),
        parts: [{ ...basePart("m-user", "p1"), type: "text", text: "hi" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo(messageID, "m-user"),
        parts: [
          {
            ...basePart(messageID, "tool-1"),
            type: "tool",
            tool: "grep",
            callID: "call_1",
            metadata: { terminal: true },
            state: {
              status: "completed",
              input: { pattern: "x" },
              output: "result",
              metadata: { compressed: true },
              title: "grep",
              time: { start: 0, end: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)
    const assistantMsg = result.find((m) => m.role === "assistant") as any
    const toolCall = (assistantMsg.content as any[]).find((c) => c.type === "tool-call")
    expect(toolCall).toBeDefined()
    // Either undefined or a provider-namespaced object — never `{ terminal: true }`
    if (toolCall.providerOptions !== undefined) {
      expect(toolCall.providerOptions).not.toHaveProperty("terminal")
    }
  })

  // [fork-perf] thinking-integrity: reasoning parts with empty text + signature
  // are dropped on outbound conversion. Anthropic rejects them on replay with
  // `messages.X.content.Y: thinking blocks cannot be modified` because empty
  // text + signature does not match the original response. Some upstream
  // gateways emit signature_delta without thinking_delta, producing this
  // shape locally; dropping the part avoids a hard 400 on the next turn.
  test("drops empty-text reasoning part with anthropic signature", async () => {
    const messageID = "m-asst"
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo("m-user"),
        parts: [{ ...basePart("m-user", "p1"), type: "text", text: "hi" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo(messageID, "m-user"),
        parts: [
          {
            ...basePart(messageID, "r1"),
            type: "reasoning",
            text: "",
            metadata: { anthropic: { signature: "sig_test_abc123" } },
            time: { start: 0, end: 1 },
          },
          {
            ...basePart(messageID, "t1"),
            type: "text",
            text: "answer",
          },
        ] as MessageV2.Part[],
      },
    ]
    const result = await MessageV2.toModelMessages(input, model)
    const assistantMsg = result.find((m) => m.role === "assistant") as any
    const reasoning = (assistantMsg.content as any[]).find((c) => c.type === "reasoning")
    expect(reasoning).toBeUndefined()
  })
})

describe("session.message-v2.fromError", () => {
  test("serializes context_length_exceeded as ContextOverflowError", () => {
    const input = {
      type: "error",
      error: {
        code: "context_length_exceeded",
      },
    }
    const result = MessageV2.fromError(input, { providerID })

    expect(result).toStrictEqual({
      name: "ContextOverflowError",
      data: {
        message: "Input exceeds context window of this model",
        responseBody: JSON.stringify(input),
      },
    })
  })

  test("serializes response error codes", () => {
    const cases = [
      {
        code: "insufficient_quota",
        message: "Quota exceeded. Check your plan and billing details.",
      },
      {
        code: "usage_not_included",
        message: "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
      },
      {
        code: "invalid_prompt",
        message: "Invalid prompt from test",
      },
    ]

    cases.forEach((item) => {
      const input = {
        type: "error",
        error: {
          code: item.code,
          message: item.code === "invalid_prompt" ? item.message : undefined,
        },
      }
      const result = MessageV2.fromError(input, { providerID })

      expect(result).toStrictEqual({
        name: "APIError",
        data: {
          message: item.message,
          isRetryable: false,
          responseBody: JSON.stringify(input),
        },
      })
    })
  })

  test("detects context overflow from APICallError provider messages", () => {
    const cases = [
      "prompt is too long: 213462 tokens > 200000 maximum",
      "Your input exceeds the context window of this model",
      "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)",
      "Please reduce the length of the messages or completion",
      "400 status code (no body)",
      "413 status code (no body)",
    ]

    cases.forEach((message) => {
      const error = new APICallError({
        message,
        url: "https://example.com",
        requestBodyValues: {},
        statusCode: 400,
        responseHeaders: { "content-type": "application/json" },
        isRetryable: false,
      })
      const result = MessageV2.fromError(error, { providerID })
      expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(true)
    })
  })

  test("detects context overflow from context_length_exceeded code in response body", () => {
    const error = new APICallError({
      message: "Request failed",
      url: "https://example.com",
      requestBodyValues: {},
      statusCode: 422,
      responseHeaders: { "content-type": "application/json" },
      responseBody: JSON.stringify({
        error: {
          message: "Some message",
          type: "invalid_request_error",
          code: "context_length_exceeded",
        },
      }),
      isRetryable: false,
    })
    const result = MessageV2.fromError(error, { providerID })
    expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(true)
  })

  test("does not classify 429 no body as context overflow", () => {
    const result = MessageV2.fromError(
      new APICallError({
        message: "429 status code (no body)",
        url: "https://example.com",
        requestBodyValues: {},
        statusCode: 429,
        responseHeaders: { "content-type": "application/json" },
        isRetryable: false,
      }),
      { providerID },
    )
    expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(false)
    expect(MessageV2.APIError.isInstance(result)).toBe(true)
  })

  test("serializes unknown inputs", () => {
    const result = MessageV2.fromError(123, { providerID })

    expect(result).toStrictEqual({
      name: "UnknownError",
      data: {
        message: "123",
      },
    })
  })

  test("serializes tagged errors with their message", () => {
    const result = MessageV2.fromError(new Question.RejectedError(), { providerID })

    expect(result).toStrictEqual({
      name: "UnknownError",
      data: {
        message: "The user dismissed this question",
      },
    })
  })

  test("classifies ZlibError from fetch as retryable APIError", () => {
    const zlibError = new Error(
      'ZlibError fetching "https://opencode.cloudflare.dev/anthropic/messages". For more information, pass `verbose: true` in the second argument to fetch()',
    )
    ;(zlibError as any).code = "ZlibError"
    ;(zlibError as any).errno = 0
    ;(zlibError as any).path = ""

    const result = MessageV2.fromError(zlibError, { providerID })

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    expect((result as MessageV2.APIError).data.isRetryable).toBe(true)
    expect((result as MessageV2.APIError).data.message).toInclude("decompression")
  })

  test("classifies ZlibError as AbortedError when abort context is provided", () => {
    const zlibError = new Error(
      'ZlibError fetching "https://opencode.cloudflare.dev/anthropic/messages". For more information, pass `verbose: true` in the second argument to fetch()',
    )
    ;(zlibError as any).code = "ZlibError"
    ;(zlibError as any).errno = 0

    const result = MessageV2.fromError(zlibError, { providerID, aborted: true })

    expect(result.name).toBe("MessageAbortedError")
  })
})

describe("session.message-v2.latest", () => {
  const TAIL_USER = MessageID.make("msg_001")
  const OVERFLOW_ASSISTANT = MessageID.make("msg_002")
  const COMPACTION_USER = MessageID.make("msg_003")
  const SUMMARY_ASSISTANT = MessageID.make("msg_004")
  const CONTINUE_USER = MessageID.make("msg_005")
  const NEW_COMPACTION_USER = MessageID.make("msg_006")

  const tailUser: MessageV2.WithParts = {
    info: userInfo(TAIL_USER),
    parts: [{ ...basePart(TAIL_USER, "p1"), type: "text", text: "original prompt" }] as MessageV2.Part[],
  }

  const overflowAssistant: MessageV2.WithParts = {
    info: {
      ...assistantInfo(OVERFLOW_ASSISTANT, TAIL_USER),
      finish: "tool-calls",
      tokens: { input: 280_000, output: 200, reasoning: 0, cache: { read: 0, write: 0 }, total: 280_200 },
    } as MessageV2.Assistant,
    parts: [],
  }

  const compactionUser: MessageV2.WithParts = {
    info: userInfo(COMPACTION_USER),
    parts: [
      {
        ...basePart(COMPACTION_USER, "p1"),
        type: "compaction",
        auto: true,
        tail_start_id: TAIL_USER,
      },
    ] as MessageV2.Part[],
  }

  const summaryAssistant: MessageV2.WithParts = {
    info: {
      ...assistantInfo(SUMMARY_ASSISTANT, COMPACTION_USER),
      summary: true,
      finish: "stop",
      tokens: { input: 150_000, output: 1_500, reasoning: 0, cache: { read: 0, write: 0 }, total: 151_500 },
    } as MessageV2.Assistant,
    parts: [],
  }

  const continueUser: MessageV2.WithParts = {
    info: userInfo(CONTINUE_USER),
    parts: [
      {
        ...basePart(CONTINUE_USER, "p1"),
        type: "text",
        text: "Continue if you have next steps...",
        synthetic: true,
        metadata: { compaction_continue: true },
      },
    ] as MessageV2.Part[],
  }

  // Regression for double auto-compaction. The reorder in filterCompacted
  // (#27145) returns [compaction-user, summary, ...tail..., continue-user],
  // so picking lastFinished by array position landed on the pre-compaction
  // overflow assistant and bypassed the `summary !== true` overflow guard
  // in SessionPrompt.runLoop, firing a second compaction.create immediately.
  test("finished is the chronologically-latest finished assistant, not the array-latest", () => {
    const filtered = MessageV2.filterCompacted([
      continueUser,
      summaryAssistant,
      compactionUser,
      overflowAssistant,
      tailUser,
    ])

    const state = MessageV2.latest(filtered)

    expect(state.finished?.id).toBe(SUMMARY_ASSISTANT)
    expect(state.finished?.summary).toBe(true)
    expect(state.user?.id).toBe(CONTINUE_USER)
    expect(state.tasks).toEqual([])
  })

  test("a fresh compaction-user newer than the latest summary surfaces in tasks", () => {
    const newCompactionUser: MessageV2.WithParts = {
      info: userInfo(NEW_COMPACTION_USER),
      parts: [
        {
          ...basePart(NEW_COMPACTION_USER, "p1"),
          type: "compaction",
          auto: true,
        },
      ] as MessageV2.Part[],
    }

    const state = MessageV2.latest([
      tailUser,
      overflowAssistant,
      compactionUser,
      summaryAssistant,
      continueUser,
      newCompactionUser,
    ])

    expect(state.finished?.id).toBe(SUMMARY_ASSISTANT)
    expect(state.user?.id).toBe(NEW_COMPACTION_USER)
    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]).toMatchObject({ type: "compaction", auto: true })
  })
})

describe("session.message-v2.stripThinkingTags", () => {
  // Test 1: default off — flag false leaves text unchanged
  test("default off: text with thinking tags is unchanged when flag not set", async () => {
    const msgID = "m-strip-off"
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo("u-strip-off"),
        parts: [{ ...basePart("u-strip-off", "u1"), type: "text", text: "hello" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo(msgID, "u-strip-off"),
        parts: [
          { ...basePart(msgID, "a1"), type: "step-start" },
          { ...basePart(msgID, "a2"), type: "text", text: "<thinking>foo</thinking>bar" },
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model, { stripThinkingText: false })
    const assistantMsg = result.find((m) => m.role === "assistant")
    expect(assistantMsg).toBeDefined()
    const textContent = (assistantMsg!.content as { type: string; text?: string }[]).find((c) => c.type === "text")
    expect(textContent?.text).toBe("<thinking>foo</thinking>bar")
  })

  // Test 2: flag on — thinking tags stripped
  test("flag on: strips <thinking>...</thinking> from assistant text part", async () => {
    const msgID = "m-strip-on"
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo("u-strip-on"),
        parts: [{ ...basePart("u-strip-on", "u1"), type: "text", text: "hello" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo(msgID, "u-strip-on"),
        parts: [
          { ...basePart(msgID, "a1"), type: "step-start" },
          { ...basePart(msgID, "a2"), type: "text", text: "<thinking>foo</thinking>bar" },
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model, { stripThinkingText: true })
    const assistantMsg = result.find((m) => m.role === "assistant")
    expect(assistantMsg).toBeDefined()
    const textContent = (assistantMsg!.content as { type: string; text?: string }[]).find((c) => c.type === "text")
    expect(textContent?.text).toBe("bar")
  })

  // Test 3: multiple tags stripped
  test("flag on: strips multiple <thinking> blocks", async () => {
    const msgID = "m-strip-multi"
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo("u-strip-multi"),
        parts: [{ ...basePart("u-strip-multi", "u1"), type: "text", text: "q" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo(msgID, "u-strip-multi"),
        parts: [
          { ...basePart(msgID, "a1"), type: "step-start" },
          {
            ...basePart(msgID, "a2"),
            type: "text",
            text: "before<thinking>x</thinking>middle<thinking>y</thinking>after",
          },
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model, { stripThinkingText: true })
    const assistantMsg = result.find((m) => m.role === "assistant")
    const textContent = (assistantMsg!.content as { type: string; text?: string }[]).find((c) => c.type === "text")
    expect(textContent?.text).toBe("beforemiddleafter")
  })

  // Test 4: unclosed tag stripped to end-of-string
  test("flag on: unclosed <thinking> tag stripped to end of text", async () => {
    const msgID = "m-strip-unclosed"
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo("u-strip-unclosed"),
        parts: [{ ...basePart("u-strip-unclosed", "u1"), type: "text", text: "q" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo(msgID, "u-strip-unclosed"),
        parts: [
          { ...basePart(msgID, "a1"), type: "step-start" },
          { ...basePart(msgID, "a2"), type: "text", text: "start<thinking>partial" },
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model, { stripThinkingText: true })
    const assistantMsg = result.find((m) => m.role === "assistant")
    const textContent = (assistantMsg!.content as { type: string; text?: string }[]).find((c) => c.type === "text")
    expect(textContent?.text).toBe("start")
  })

  // Test 5: reasoning part text is NOT touched by stripThinkingText
  test("flag on: reasoning part text is not modified", async () => {
    const anthropicModel: typeof model = {
      ...model,
      api: { ...model.api, npm: "@ai-sdk/anthropic" },
    }
    const msgID = "m-strip-reason"
    const signature = "sig-abc"
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo("u-strip-reason"),
        parts: [{ ...basePart("u-strip-reason", "u1"), type: "text", text: "q" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo(msgID, "u-strip-reason"),
        parts: [
          { ...basePart(msgID, "a1"), type: "step-start" },
          {
            ...basePart(msgID, "a2"),
            type: "reasoning",
            text: "native reasoning",
            time: { start: 0 },
            metadata: { anthropic: { signature } },
          },
          { ...basePart(msgID, "a3"), type: "text", text: " " },
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model, { stripThinkingText: true })
    const assistantMsg = result.find((m) => m.role === "assistant")
    expect(assistantMsg).toBeDefined()
    // reasoning content should be present untouched
    const reasoningContent = (assistantMsg!.content as { type: string; text?: string }[]).find(
      (c) => c.type === "reasoning",
    )
    expect(reasoningContent?.text).toBe("native reasoning")
  })

  // Test 6: empty-text reasoning with signature is dropped (thinking-integrity guard)
  test("flag on: drops empty-text reasoning part with signature", async () => {
    const anthropicModel: typeof model = {
      ...model,
      providerID: ProviderID.make("anthropic"),
      api: { ...model.api, npm: "@ai-sdk/anthropic", id: "claude-test" },
    }
    const msgID = "m-strip-sig"
    const signature = "sig-xyz"
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo("u-strip-sig"),
        parts: [{ ...basePart("u-strip-sig", "u1"), type: "text", text: "q" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo(msgID, "u-strip-sig", undefined, {
          providerID: anthropicModel.providerID,
          modelID: anthropicModel.id,
        }),
        parts: [
          { ...basePart(msgID, "a1"), type: "step-start" },
          {
            ...basePart(msgID, "a2"),
            type: "reasoning",
            text: "",
            time: { start: 0 },
            metadata: { anthropic: { signature } },
          },
          { ...basePart(msgID, "a3"), type: "text", text: " " },
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, anthropicModel, { stripThinkingText: true })
    const assistantMsg = result.find((m) => m.role === "assistant")
    expect(assistantMsg).toBeDefined()
    const reasoningContent = (assistantMsg!.content as { type: string; providerOptions?: unknown }[]).find(
      (c) => c.type === "reasoning",
    )
    expect(reasoningContent).toBeUndefined()
  })

  // Unit test for stripThinkingTags helper directly
  test("stripThinkingTags helper: basic stripping", () => {
    expect(MessageV2.stripThinkingTags("<thinking>foo</thinking>bar")).toBe("bar")
    expect(MessageV2.stripThinkingTags("start<thinking>partial")).toBe("start")
    expect(MessageV2.stripThinkingTags("a<thinking>x</thinking>b<thinking>y</thinking>c")).toBe("abc")
    expect(MessageV2.stripThinkingTags("no tags here")).toBe("no tags here")
    expect(MessageV2.stripThinkingTags("")).toBe("")
  })
})
