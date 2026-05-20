import { Provider } from "@/provider/provider"
import { Log } from "@/util/log"
import { Cause, Effect, Layer, Record, ServiceMap } from "effect"
import * as Queue from "effect/Queue"
import * as Stream from "effect/Stream"
import { streamText, wrapLanguageModel, stepCountIs, type ModelMessage, type Tool, tool, jsonSchema } from "ai"
import { mergeDeep, pipe } from "remeda"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { SystemPrompt } from "./system"
import { Flag } from "@/flag/flag"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { Bus } from "@/bus"
import { Wildcard } from "@/util/wildcard"
import { SessionID } from "@/session/schema"
import { Auth } from "@/auth"
import { Installation } from "@/installation"
import { resolveHybridRoute } from "@/session/route-classifier"

export namespace LLM {
  const log = Log.create({ service: "llm" })
  export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX
  export type ToolMeta = {
    parallelSafe: boolean
  }

  export type StreamInput = {
    user: MessageV2.User
    sessionID: string
    parentSessionID?: string
    model: Provider.Model
    agent: Agent.Info
    permission?: Permission.Ruleset
    system: string[]
    messages: ModelMessage[]
    small?: boolean
    tools: Record<string, Tool>
    toolMeta?: Map<string, ToolMeta>
    retries?: number
    toolChoice?: "auto" | "required" | "none"
    maxSteps?: number
    onModelResolved?: (model: Provider.Model) => void
  }

  export type StreamRequest = StreamInput & {
    abort: AbortSignal
  }

  export type Event = Awaited<ReturnType<typeof stream>>["fullStream"] extends AsyncIterable<infer T> ? T : never

  export interface Interface {
    readonly stream: (input: StreamInput) => Stream.Stream<Event, unknown>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/LLM") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      return Service.of({
        stream(input) {
          return Stream.scoped(
            Stream.unwrap(
              Effect.gen(function* () {
                const ctrl = yield* Effect.acquireRelease(
                  Effect.sync(() => new AbortController()),
                  (ctrl) => Effect.sync(() => ctrl.abort()),
                )

                const result = yield* Effect.promise(() => LLM.stream({ ...input, abort: ctrl.signal }))

                return Stream.fromAsyncIterable(result.fullStream, (e) =>
                  e instanceof Error ? e : new Error(String(e)),
                )
              }),
            ),
          )
        },
      })
    }),
  )

  export const defaultLayer = layer

  export function parallelGate(input: {
    agent: Agent.Info
    permission?: Permission.Ruleset
    cfg: Config.Info
    toolMeta?: Map<string, ToolMeta>
  }) {
    const enabled = input.agent.parallelToolCalls ?? input.cfg.experimental?.parallel_tool_calls ?? true
    if (enabled !== true) return false
    if (!input.toolMeta || input.toolMeta.size === 0) return false

    const permission = Permission.effective(input.agent.permission, input.permission ?? [])
    for (const [toolName, meta] of input.toolMeta) {
      if (toolName === "invalid") continue
      if (toolName === "read" && input.cfg.experimental?.parallel_read !== true) return false
      if (!meta.parallelSafe) return false
      if (Permission.evaluate(toolName, "*", permission).action !== "allow") return false
      if (
        permission.some(
          (rule) => rule.pattern !== "*" && rule.action !== "allow" && Wildcard.match(toolName, rule.permission),
        )
      ) {
        return false
      }
    }

    return true
  }

  export async function stream(input: StreamRequest) {
    const l = log
      .clone()
      .tag("providerID", input.model.providerID)
      .tag("modelID", input.model.id)
      .tag("sessionID", input.sessionID)
      .tag("small", (input.small ?? false).toString())
      .tag("agent", input.agent.name)
      .tag("mode", input.agent.mode)
    l.info("stream", {
      modelID: input.model.id,
      providerID: input.model.providerID,
    })
    const [baseLanguage, cfg, baseProvider, baseAuth] = await Promise.all([
      Provider.getLanguage(input.model),
      Config.get(),
      Provider.getProvider(input.model.providerID),
      Auth.get(input.model.providerID),
    ])
    const all = await resolveTools(input)
    const hybrid = await resolveHybridRoute({
      enabled: cfg.hybrid?.enabled ?? Flag.OPENCODE_HYBRID_ROUTING,
      cfg,
      input: {
        sessionID: input.sessionID,
        messages: input.messages,
        tools: all,
        model: input.model,
      },
      language: baseLanguage,
      provider: baseProvider,
      auth: baseAuth,
    })
    const model = hybrid.model
    const language = hybrid.language
    const provider = hybrid.provider
    const auth = hybrid.auth
    input.onModelResolved?.(model)
    // TODO: move this to a proper hook
    const isOpenaiOauth = provider.id === "openai" && auth?.type === "oauth"

    const system: string[] = []
    if (cfg.experimental?.prompt_split_caching !== false && input.system.length >= 2) {
      // Preserve stable/dynamic boundary: system[0] = stable prefix, system[1] = dynamic suffix
      const stable = [...(input.agent.prompt ? [input.agent.prompt] : []), input.system[0]].filter((x) => x).join("\n")
      const dynamic = [...input.system.slice(1), ...(input.user.system ? [input.user.system] : [])]
        .filter((x) => x)
        .join("\n")
      system.push(stable, dynamic)
    } else {
      system.push(
        [
          ...(input.agent.prompt ? [input.agent.prompt] : []),
          ...input.system,
          ...(input.user.system ? [input.user.system] : []),
        ]
          .filter((x) => x)
          .join("\n"),
      )
    }

    const header = system[0]
    await Plugin.trigger("experimental.chat.system.transform", { sessionID: input.sessionID, model }, { system })
    // rejoin to maintain 2-part structure for caching if header unchanged
    if (cfg.experimental?.prompt_split_caching === false && system.length > 2 && system[0] === header) {
      const rest = system.slice(1)
      system.length = 0
      system.push(header, rest.join("\n"))
    }

    const variant =
      !input.small && model.variants && input.user.model.variant ? model.variants[input.user.model.variant] : {}
    const base = input.small
      ? ProviderTransform.smallOptions(model)
      : ProviderTransform.options({
          model,
          sessionID: input.sessionID,
          providerOptions: provider.options,
        })
    const options: Record<string, any> = pipe(
      base,
      mergeDeep(model.options),
      mergeDeep(input.agent.options),
      mergeDeep(variant),
    )
    if (isOpenaiOauth) {
      options.instructions = system.join("\n")
    }

    const isWorkflow = language instanceof GitLabWorkflowLanguageModel
    const messages = isOpenaiOauth
      ? input.messages
      : isWorkflow
        ? input.messages
        : [
            ...system.map(
              (x): ModelMessage => ({
                role: "system",
                content: x,
              }),
            ),
            ...input.messages,
          ]

    const params = await Plugin.trigger(
      "chat.params",
      {
        sessionID: input.sessionID,
        agent: input.agent.name,
        model,
        provider,
        message: input.user,
      },
      {
        temperature: model.capabilities.temperature
          ? (input.agent.temperature ?? ProviderTransform.temperature(model))
          : undefined,
        topP: input.agent.topP ?? ProviderTransform.topP(model),
        topK: ProviderTransform.topK(model),
        maxOutputTokens: ProviderTransform.maxOutputTokens(model),
        options,
      },
    )

    const { headers } = await Plugin.trigger(
      "chat.headers",
      {
        sessionID: input.sessionID,
        agent: input.agent.name,
        model,
        provider,
        message: input.user,
      },
      {
        headers: {},
      },
    )

    const tools = all
    const visible = Object.fromEntries(Object.entries(all).toSorted(([a], [b]) => a.localeCompare(b)))
    const toolMeta = resolveToolMeta(input, all)
    const parallelToolCalls = parallelGate({
      agent: input.agent,
      permission: input.permission,
      cfg,
      toolMeta,
    })
    const providerOptions = ProviderTransform.providerOptions(
      model,
      mergeDeep(
        params.options,
        ProviderTransform.parallelToolCallOptions({
          model,
          enabled: parallelToolCalls,
          provider: cfg.provider?.[model.providerID],
        }),
      ),
    )

    // LiteLLM and some Anthropic proxies require the tools parameter to be present
    // when message history contains tool calls, even if no tools are being used.
    // Add a dummy tool that is never called to satisfy this validation.
    // This is enabled for:
    // 1. Providers with "litellm" in their ID or API ID (auto-detected)
    // 2. Providers with explicit "litellmProxy: true" option (opt-in for custom gateways)
    const isLiteLLMProxy =
      provider.options?.["litellmProxy"] === true ||
      model.providerID.toLowerCase().includes("litellm") ||
      model.api.id.toLowerCase().includes("litellm")

    // LiteLLM/Bedrock rejects requests where the message history contains tool
    // calls but no tools param is present. When there are no active tools (e.g.
    // during compaction), inject a stub tool to satisfy the validation requirement.
    // The stub description explicitly tells the model not to call it.
    if (isLiteLLMProxy && Object.keys(all).length === 0 && hasToolCalls(input.messages)) {
      visible["_noop"] = tool({
        description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            reason: { type: "string", description: "Unused" },
          },
        }),
        execute: async () => ({ output: "", title: "", metadata: {} }),
      })
    }

    // Wire up toolExecutor for DWS workflow models so that tool calls
    // from the workflow service are executed via opencode's tool system
    // and results sent back over the WebSocket.
    if (language instanceof GitLabWorkflowLanguageModel) {
      const workflowModel = language as GitLabWorkflowLanguageModel & {
        sessionID?: string
        sessionPreapprovedTools?: string[]
        approvalHandler?: (approvalTools: { name: string; args: string }[]) => Promise<{ approved: boolean }>
      }
      workflowModel.sessionID = input.sessionID
      workflowModel.systemPrompt = system.join("\n")
      workflowModel.toolExecutor = async (toolName, argsJson, _requestID) => {
        const t = tools[toolName]
        if (!t || !t.execute) {
          return { result: "", error: `Unknown tool: ${toolName}` }
        }
        try {
          const result = await t.execute!(JSON.parse(argsJson), {
            toolCallId: _requestID,
            messages: input.messages,
            abortSignal: input.abort,
          })
          const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
          return {
            result: output,
            metadata: typeof result === "object" ? result?.metadata : undefined,
            title: typeof result === "object" ? result?.title : undefined,
          }
        } catch (e: any) {
          return { result: "", error: e.message ?? String(e) }
        }
      }

      const ruleset = Permission.effective(input.agent.permission ?? [], input.permission ?? [])
      workflowModel.sessionPreapprovedTools = Object.keys(tools).filter((name) => {
        const match = ruleset.findLast((rule) => Wildcard.match(name, rule.permission))
        return !match || match.action !== "ask"
      })

      const approvedToolsForSession = new Set<string>()
      workflowModel.approvalHandler = Instance.bind(async (approvalTools) => {
        const uniqueNames = [...new Set(approvalTools.map((t: { name: string }) => t.name))] as string[]
        // Auto-approve tools that were already approved in this session
        // (prevents infinite approval loops for server-side MCP tools)
        if (uniqueNames.every((name) => approvedToolsForSession.has(name))) {
          return { approved: true }
        }

        const id = PermissionID.ascending()
        let reply: Permission.Reply | undefined
        let unsub: (() => void) | undefined
        try {
          unsub = Bus.subscribe(Permission.Event.Replied, (evt) => {
            if (evt.properties.requestID === id) reply = evt.properties.reply
          })
          const toolPatterns = approvalTools.map((t: { name: string; args: string }) => {
            try {
              const parsed = JSON.parse(t.args) as Record<string, unknown>
              const title = (parsed?.title ?? parsed?.name ?? "") as string
              return title ? `${t.name}: ${title}` : t.name
            } catch {
              return t.name
            }
          })
          const uniquePatterns = [...new Set(toolPatterns)] as string[]
          await Permission.ask({
            id,
            sessionID: SessionID.make(input.sessionID),
            permission: "workflow_tool_approval",
            patterns: uniquePatterns,
            metadata: { tools: approvalTools },
            always: uniquePatterns,
            ruleset,
          })
          for (const name of uniqueNames) approvedToolsForSession.add(name)
          workflowModel.sessionPreapprovedTools = [...(workflowModel.sessionPreapprovedTools ?? []), ...uniqueNames]
          return { approved: true }
        } catch {
          return { approved: false }
        } finally {
          unsub?.()
        }
      })
    }

    return streamText({
      onError(error) {
        l.error("stream error", {
          error,
        })
      },
      stopWhen: input.maxSteps && input.maxSteps > 1 ? stepCountIs(input.maxSteps) : undefined,
      async experimental_repairToolCall(failed) {
        const lower = failed.toolCall.toolName.toLowerCase()
        if (lower !== failed.toolCall.toolName && tools[lower]) {
          l.info("repairing tool call", {
            tool: failed.toolCall.toolName,
            repaired: lower,
          })
          return {
            ...failed.toolCall,
            toolName: lower,
          }
        }
        return {
          ...failed.toolCall,
          input: JSON.stringify({
            tool: failed.toolCall.toolName,
            error: failed.error.message,
          }),
          toolName: "invalid",
        }
      },
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
      providerOptions,
      activeTools: Object.keys(visible).filter((x) => x !== "invalid"),
      tools: ProviderTransform.toolCaching(visible, model, input.sessionID) as typeof visible,
      toolChoice: input.toolChoice,
      maxOutputTokens: params.maxOutputTokens,
      abortSignal: input.abort,
      headers: {
        ...(model.providerID.startsWith("opencode")
          ? {
              "x-opencode-project": Instance.project.id,
              "x-opencode-session": input.sessionID,
              "x-opencode-request": input.user.id,
              "x-opencode-client": Flag.OPENCODE_CLIENT,
            }
          : {
              "x-session-affinity": input.sessionID,
              ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
              "User-Agent": `opencode/${Installation.VERSION}`,
            }),
        ...model.headers,
        ...headers,
      },
      maxRetries: input.retries ?? 0,
      messages,
      model: wrapLanguageModel({
        model: language,
        middleware: [
          {
            specificationVersion: "v3" as const,
            async transformParams(args) {
              if (args.type === "stream") {
                // @ts-expect-error
                args.params.prompt = ProviderTransform.message(args.params.prompt, model, options)
              }
              return args.params
            },
          },
        ],
      }),
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry,
        metadata: {
          userId: cfg.username ?? "unknown",
          sessionId: input.sessionID,
        },
      },
    })
  }

  function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "permission" | "user">) {
    const disabled = Permission.disabled(
      Object.keys(input.tools),
      Permission.merge(input.agent.permission, input.permission ?? []),
    )
    return Record.filter(input.tools, (_, k) => input.user.tools?.[k] !== false && !disabled.has(k))
  }

  function resolveToolMeta(
    input: Pick<StreamInput, "tools" | "toolMeta" | "agent" | "permission" | "user">,
    tools: Record<string, Tool>,
  ) {
    const result = new Map<string, ToolMeta>()
    for (const key of Object.keys(tools)) {
      const meta = input.toolMeta?.get(key)
      result.set(key, { parallelSafe: meta?.parallelSafe === true })
    }
    return result
  }

  // Check if messages contain any tool-call content
  // Used to determine if a dummy tool should be added for LiteLLM proxy compatibility
  export function hasToolCalls(messages: ModelMessage[]): boolean {
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue
      for (const part of msg.content) {
        if (part.type === "tool-call" || part.type === "tool-result") return true
      }
    }
    return false
  }
}
