import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { createSignal, type Setter } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import path from "path"

export type KVContext = {
  readonly ready: boolean
  readonly store: Record<string, unknown>
  signal<T>(name: string, defaultValue: T): readonly [() => T, (next: Setter<T>) => void]
  get<T>(key: string): T | undefined
  get<T>(key: string, defaultValue: T): T
  set<T>(key: string, value: T): void
}

export const { use: useKV, provider: KVProvider } = createSimpleContext({
  name: "KV",
  init: () => {
    const [ready, setReady] = createSignal(false)
    const [store, setStore] = createStore<Record<string, unknown>>({})
    const filePath = path.join(Global.Path.state, "kv.json")

    Filesystem.readJson(filePath)
      .then((x) => {
        setStore(x)
      })
      .catch(() => {})
      .finally(() => {
        setReady(true)
      })

    function get<T>(key: string): T | undefined
    function get<T>(key: string, defaultValue: T): T
    function get<T>(key: string, defaultValue?: T) {
      return (store[key] as T | undefined) ?? defaultValue
    }

    const result: KVContext = {
      get ready() {
        return ready()
      },
      get store() {
        return store
      },
      signal<T>(name: string, defaultValue: T) {
        if (store[name] === undefined) setStore(name, defaultValue)
        return [
          function () {
            return result.get(name, defaultValue)
          },
          function setter(next: Setter<T>) {
            result.set(name, next)
          },
        ] as const
      },
      get,
      set<T>(key: string, value: T) {
        setStore(key, value)
        Filesystem.writeJson(filePath, store)
      },
    }
    return result
  },
})
