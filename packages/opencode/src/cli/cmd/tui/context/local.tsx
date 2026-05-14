import { createStore } from "solid-js/store"
import { batch, createEffect, createMemo, on } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { useRoute } from "@tui/context/route"
import { useEvent } from "@tui/context/event"
import { uniqueBy } from "remeda"
import path from "path"
import { Global } from "@/global"
import { Flag } from "@/flag/flag"
import { iife } from "@/util/iife"
import { createSimpleContext } from "./helper"
import { useToast } from "../ui/toast"
import { Provider } from "@/provider/provider"
import { useArgs } from "./args"
import { useSDK } from "./sdk"
import { RGBA } from "@opentui/core"
import { Filesystem } from "@/util/filesystem"

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const sync = useSync()
    const sdk = useSDK()
    const toast = useToast()

    function isModelValid(model: { providerID: string; modelID: string }) {
      const provider = sync.data.provider.find((x) => x.id === model.providerID)
      return !!provider?.models[model.modelID]
    }

    function getFirstValidModel(...modelFns: (() => { providerID: string; modelID: string } | undefined)[]) {
      for (const modelFn of modelFns) {
        const model = modelFn()
        if (!model) continue
        if (isModelValid(model)) return model
      }
    }

    const agent = iife(() => {
      const agents = createMemo(() => sync.data.agent.filter((x) => x.mode !== "subagent" && !x.hidden))
      const visibleAgents = createMemo(() => sync.data.agent.filter((x) => !x.hidden))
      const [agentStore, setAgentStore] = createStore<{
        current: string
      }>({
        current: agents()[0].name,
      })
      const { theme } = useTheme()
      const colors = createMemo(() => [
        theme.secondary,
        theme.accent,
        theme.success,
        theme.warning,
        theme.primary,
        theme.error,
        theme.info,
      ])
      return {
        list() {
          return agents()
        },
        current() {
          return agents().find((x) => x.name === agentStore.current) ?? agents()[0]
        },
        set(name: string) {
          if (!agents().some((x) => x.name === name))
            return toast.show({
              variant: "warning",
              message: `Agent not found: ${name}`,
              duration: 3000,
            })
          setAgentStore("current", name)
        },
        move(direction: 1 | -1) {
          batch(() => {
            let next = agents().findIndex((x) => x.name === agentStore.current) + direction
            if (next < 0) next = agents().length - 1
            if (next >= agents().length) next = 0
            const value = agents()[next]
            setAgentStore("current", value.name)
          })
        },
        color(name: string) {
          const index = visibleAgents().findIndex((x) => x.name === name)
          if (index === -1) return colors()[0]
          const agent = visibleAgents()[index]

          if (agent?.color) {
            const color = agent.color
            if (color.startsWith("#")) return RGBA.fromHex(color)
            // already validated by config, just satisfying TS here
            return theme[color as keyof typeof theme] as RGBA
          }
          return colors()[index % colors().length]
        },
      }
    })

    const model = iife(() => {
      const [modelStore, setModelStore] = createStore<{
        ready: boolean
        model: Record<
          string,
          {
            providerID: string
            modelID: string
          }
        >
        recent: {
          providerID: string
          modelID: string
        }[]
        favorite: {
          providerID: string
          modelID: string
        }[]
        variant: Record<string, string | undefined>
      }>({
        ready: false,
        model: {},
        recent: [],
        favorite: [],
        variant: {},
      })

      const filePath = path.join(Global.Path.state, "model.json")
      const state = {
        pending: false,
      }

      function save() {
        if (!modelStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        Filesystem.writeJson(filePath, {
          recent: modelStore.recent,
          favorite: modelStore.favorite,
          variant: modelStore.variant,
        })
      }

      Filesystem.readJson(filePath)
        .then((x: any) => {
          if (Array.isArray(x.recent)) setModelStore("recent", x.recent)
          if (Array.isArray(x.favorite)) setModelStore("favorite", x.favorite)
          if (typeof x.variant === "object" && x.variant !== null) setModelStore("variant", x.variant)
        })
        .catch(() => {})
        .finally(() => {
          setModelStore("ready", true)
          if (state.pending) save()
        })

      const args = useArgs()
      const fallbackModel = createMemo(() => {
        if (args.model) {
          const { providerID, modelID } = Provider.parseModel(args.model)
          if (isModelValid({ providerID, modelID })) {
            return {
              providerID,
              modelID,
            }
          }
        }

        if (sync.data.config.model) {
          const { providerID, modelID } = Provider.parseModel(sync.data.config.model)
          if (isModelValid({ providerID, modelID })) {
            return {
              providerID,
              modelID,
            }
          }
        }

        for (const item of modelStore.recent) {
          if (isModelValid(item)) {
            return item
          }
        }

        const provider = sync.data.provider[0]
        if (!provider) return undefined
        const defaultModel = sync.data.provider_default[provider.id]
        const firstModel = Object.values(provider.models)[0]
        const model = defaultModel ?? firstModel?.id
        if (!model) return undefined
        return {
          providerID: provider.id,
          modelID: model,
        }
      })

      const currentModel = createMemo(() => {
        const a = agent.current()
        return (
          getFirstValidModel(
            () => modelStore.model[a.name],
            () => a.model,
            fallbackModel,
          ) ?? undefined
        )
      })

      return {
        current: currentModel,
        get ready() {
          return modelStore.ready
        },
        recent() {
          return modelStore.recent
        },
        favorite() {
          return modelStore.favorite
        },
        parsed: createMemo(() => {
          const value = currentModel()
          if (!value) {
            return {
              provider: "Connect a provider",
              model: "No provider selected",
              reasoning: false,
            }
          }
          const provider = sync.data.provider.find((x) => x.id === value.providerID)
          const info = provider?.models[value.modelID]
          return {
            provider: provider?.name ?? value.providerID,
            model: info?.name ?? value.modelID,
            reasoning: info?.capabilities?.reasoning ?? false,
          }
        }),
        cycle(direction: 1 | -1) {
          const current = currentModel()
          if (!current) return
          const recent = modelStore.recent
          const index = recent.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          if (index === -1) return
          let next = index + direction
          if (next < 0) next = recent.length - 1
          if (next >= recent.length) next = 0
          const val = recent[next]
          if (!val) return
          setModelStore("model", agent.current().name, { ...val })
        },
        cycleFavorite(direction: 1 | -1) {
          const favorites = modelStore.favorite.filter((item) => isModelValid(item))
          if (!favorites.length) {
            toast.show({
              variant: "info",
              message: "Add a favorite model to use this shortcut",
              duration: 3000,
            })
            return
          }
          const current = currentModel()
          let index = -1
          if (current) {
            index = favorites.findIndex((x) => x.providerID === current.providerID && x.modelID === current.modelID)
          }
          if (index === -1) {
            index = direction === 1 ? 0 : favorites.length - 1
          } else {
            index += direction
            if (index < 0) index = favorites.length - 1
            if (index >= favorites.length) index = 0
          }
          const next = favorites[index]
          if (!next) return
          setModelStore("model", agent.current().name, { ...next })
          const uniq = uniqueBy([next, ...modelStore.recent], (x) => `${x.providerID}/${x.modelID}`)
          if (uniq.length > 10) uniq.pop()
          setModelStore(
            "recent",
            uniq.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
          )
          save()
        },
        set(model: { providerID: string; modelID: string }, options?: { recent?: boolean }) {
          batch(() => {
            if (!isModelValid(model)) {
              toast.show({
                message: `Model ${model.providerID}/${model.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return
            }
            setModelStore("model", agent.current().name, model)
            if (options?.recent) {
              const uniq = uniqueBy([model, ...modelStore.recent], (x) => `${x.providerID}/${x.modelID}`)
              if (uniq.length > 10) uniq.pop()
              setModelStore(
                "recent",
                uniq.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
              )
              save()
            }
          })
        },
        toggleFavorite(model: { providerID: string; modelID: string }) {
          batch(() => {
            if (!isModelValid(model)) {
              toast.show({
                message: `Model ${model.providerID}/${model.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return
            }
            const exists = modelStore.favorite.some(
              (x) => x.providerID === model.providerID && x.modelID === model.modelID,
            )
            const next = exists
              ? modelStore.favorite.filter((x) => x.providerID !== model.providerID || x.modelID !== model.modelID)
              : [model, ...modelStore.favorite]
            setModelStore(
              "favorite",
              next.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
            )
            save()
          })
        },
        variant: {
          selected() {
            const m = currentModel()
            if (!m) return undefined
            const key = `${m.providerID}/${m.modelID}`
            return modelStore.variant[key]
          },
          current() {
            const v = this.selected()
            if (!v) return undefined
            if (!this.list().includes(v)) return undefined
            return v
          },
          list() {
            const m = currentModel()
            if (!m) return []
            const provider = sync.data.provider.find((x) => x.id === m.providerID)
            const info = provider?.models[m.modelID]
            if (!info?.variants) return []
            return Object.keys(info.variants)
          },
          set(value: string | undefined) {
            const m = currentModel()
            if (!m) return
            const key = `${m.providerID}/${m.modelID}`
            setModelStore("variant", key, value ?? "default")
            save()
          },
          cycle() {
            const variants = this.list()
            if (variants.length === 0) return
            const current = this.current()
            if (!current) {
              this.set(variants[0])
              return
            }
            const index = variants.indexOf(current)
            if (index === -1 || index === variants.length - 1) {
              this.set(undefined)
              return
            }
            this.set(variants[index + 1])
          },
        },
      }
    })

    const mcp = {
      isEnabled(name: string) {
        const status = sync.data.mcp[name]
        return status?.status === "connected"
      },
      async toggle(name: string) {
        const status = sync.data.mcp[name]
        if (status?.status === "connected") {
          // Disable: disconnect the MCP
          await sdk.client.mcp.disconnect({ name })
        } else {
          // Enable/Retry: connect the MCP (handles disabled, failed, and other states)
          await sdk.client.mcp.connect({ name })
        }
      },
    }

    // Automatically update model when agent changes
    createEffect(() => {
      const value = agent.current()
      if (value.model) {
        if (isModelValid(value.model))
          model.set({
            providerID: value.model.providerID,
            modelID: value.model.modelID,
          })
        else
          toast.show({
            variant: "warning",
            message: `Agent ${value.name}'s configured model ${value.model.providerID}/${value.model.modelID} is not valid`,
            duration: 3000,
          })
      }
    })

    const session = iife(() => {
      const [sessionStore, setSessionStore] = createStore<{
        ready: boolean
        pinned: string[]
        dismissedRecent: string[]
        recentOrder: string[]
      }>({
        ready: false,
        pinned: [],
        dismissedRecent: [],
        recentOrder: [],
      })

      const filePath = path.join(Global.Path.state, "session.json")
      const state = {
        pending: false,
      }

      function save() {
        if (!sessionStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        void Filesystem.writeJson(filePath, {
          pinned: sessionStore.pinned,
          dismissedRecent: sessionStore.dismissedRecent,
          recentOrder: sessionStore.recentOrder,
        })
      }

      Filesystem.readJson(filePath)
        .then((x: any) => {
          if (Array.isArray(x.pinned)) setSessionStore("pinned", x.pinned)
          if (Array.isArray(x.dismissedRecent)) setSessionStore("dismissedRecent", x.dismissedRecent)
          if (Array.isArray(x.recentOrder)) setSessionStore("recentOrder", x.recentOrder)
        })
        .catch(() => {})
        .finally(() => {
          setSessionStore("ready", true)
          if (state.pending) save()
        })

      const route = useRoute()
      const event = useEvent()

      const slots = createMemo(() => {
        const rootSessions = sync.data.session.filter((x) => x.parentID === undefined)
        const existing = new Set(rootSessions.map((x) => x.id))
        const dismissed = new Set(sessionStore.dismissedRecent)
        const pins = sessionStore.pinned.filter((id) => existing.has(id))
        const pinnedSet = new Set(pins)
        const recent = rootSessions
          .filter((x) => !pinnedSet.has(x.id) && !dismissed.has(x.id))
          .toSorted((a, b) => b.time.updated - a.time.updated)
          .map((x) => x.id)
        return [...pins, ...recent].slice(0, 9)
      })

      function prune(sessionID: string) {
        batch(() => {
          if (sessionStore.pinned.includes(sessionID)) {
            setSessionStore(
              "pinned",
              sessionStore.pinned.filter((id) => id !== sessionID),
            )
          }
          if (sessionStore.dismissedRecent.includes(sessionID)) {
            setSessionStore(
              "dismissedRecent",
              sessionStore.dismissedRecent.filter((id) => id !== sessionID),
            )
          }
          if (sessionStore.recentOrder.includes(sessionID)) {
            setSessionStore(
              "recentOrder",
              sessionStore.recentOrder.filter((id) => id !== sessionID),
            )
          }
        })
        save()
      }

      event.on("session.deleted", (evt) => {
        prune(evt.properties.sessionID)
      })

      function cycleRecent(direction: 1 | -1) {
        if (!Flag.OPENCODE_EXPERIMENTAL_SESSION_SWITCHING) return
        const current = route.data
        if (current?.type !== "session") return
        const currentID = current.sessionID
        const list = slots()
        const idx = list.indexOf(currentID)
        if (list.length === 0) return
        const next = idx === -1 ? list[0] : list[(idx + direction + list.length) % list.length]
        if (!next || next === currentID) return
        route.navigate({ type: "session", sessionID: next })

        createEffect(
          on(
            () => route.data,
            (r) => {
              if (r?.type === "session" && r.sessionID === next) {
                // arrived at target
              }
            },
          ),
        )

        if (sessionStore.recentOrder.includes(currentID)) {
          setSessionStore("recentOrder", [currentID, ...sessionStore.recentOrder.filter((id) => id !== currentID)])
        } else {
          setSessionStore("recentOrder", [currentID, ...sessionStore.recentOrder])
        }
        save()
      }

      function quickSwitch(slot: number) {
        if (!Flag.OPENCODE_EXPERIMENTAL_SESSION_SWITCHING) return
        const id = slots()[slot - 1]
        if (!id) return
        route.navigate({ type: "session", sessionID: id })
      }

      return {
        pinned: () => sessionStore.pinned,
        dismissedRecent: () => sessionStore.dismissedRecent,
        recentOrder: () => sessionStore.recentOrder,
        slots,
        isPinned: (id: string) => sessionStore.pinned.includes(id),
        togglePin: (id: string) => {
          if (sessionStore.pinned.includes(id)) {
            setSessionStore(
              "pinned",
              sessionStore.pinned.filter((p) => p !== id),
            )
          } else {
            setSessionStore("pinned", [id, ...sessionStore.pinned])
          }
          save()
        },
        toggleRecent: (id: string) => {
          if (sessionStore.dismissedRecent.includes(id)) {
            setSessionStore(
              "dismissedRecent",
              sessionStore.dismissedRecent.filter((d) => d !== id),
            )
          } else {
            setSessionStore("dismissedRecent", [id, ...sessionStore.dismissedRecent])
          }
          save()
        },
        cycleRecent,
        quickSwitch,
      }
    })

    const result = {
      model,
      agent,
      mcp,
      session,
    }
    return result
  },
})
