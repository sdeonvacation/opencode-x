import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo } from "solid-js"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

export function getUsedTokens(msg: AssistantMessage) {
  if (msg.summary && msg.finish && !msg.error) return msg.tokens.output
  return msg.tokens.input + (msg.tokens.cache?.read ?? 0)
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const messageCost = createMemo(() =>
    msg().reduce((sum, item) => sum + (item.role === "assistant" ? item.cost : 0), 0),
  )
  const clearedCost = createMemo(() => props.api.kv.get(`cleared_cost_${props.session_id}`, 0))
  const cost = createMemo(() => messageCost() + clearedCost())

  const state = createMemo(() => {
    const last = msg().findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.input > 0)
    if (!last) {
      return {
        tokens: 0,
        percent: null,
      }
    }

    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    return {
      tokens,
      percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
    }
  })

  const sw = createMemo(() => {
    const last = msg().findLast((item): item is AssistantMessage => item.role === "assistant" && !!item.compaction)
    if (!last?.compaction) return null
    const saved = Math.round(((last.compaction.total - last.compaction.budget) / last.compaction.total) * 100)
    return { sent: last.compaction.budget, saved }
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      <text fg={theme().textMuted}>{state().tokens.toLocaleString()} tokens</text>
      <text fg={theme().textMuted}>{state().percent ?? 0}% used</text>
      {sw() && (
        <text fg={theme().textMuted}>
          SW: {sw()!.sent.toLocaleString()} sent ({sw()!.saved}% saved)
        </text>
      )}
      <text fg={theme().textMuted}>{money.format(cost())} spent</text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
