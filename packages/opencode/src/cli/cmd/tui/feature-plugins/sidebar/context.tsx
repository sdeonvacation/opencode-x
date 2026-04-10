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
    const completed = msg().filter(
      (item): item is AssistantMessage => item.role === "assistant" && item.finish != null && !item.summary,
    )
    if (completed.length === 0) {
      return {
        tokens: 0,
        percent: null,
      }
    }

    // Use the high-water mark so the display never drops within a compaction window
    const tokens = Math.max(...completed.map(getUsedTokens))
    const last = completed[completed.length - 1]
    const model = props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    return {
      tokens,
      percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
    }
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      <text fg={theme().textMuted}>{state().tokens.toLocaleString()} tokens</text>
      <text fg={theme().textMuted}>{state().percent ?? 0}% used</text>
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
