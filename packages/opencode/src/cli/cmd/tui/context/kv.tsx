import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { Flock } from "@/util/flock"
import { rename, rm } from "fs/promises"
import { createSignal, type Setter } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
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
    const lock = `tui-kv:${filePath}`
    // Queue same-process writes so rapid updates persist in order.
    let write = Promise.resolve()

    // Write to a temp file first so kv.json is only replaced once the JSON is complete, avoiding partial writes if shutdown interrupts persistence.
    function writeSnapshot(snapshot: Record<string, any>) {
      const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
      return Filesystem.writeJson(tempPath, snapshot)
        .then(() => rename(tempPath, filePath))
        .catch(async (err: unknown) => {
          await rm(tempPath, { force: true }).catch(() => undefined)
          throw err
        })
    }

    // Read under the same lock used for writes because kv.json is shared across processes.
    Flock.withLock(lock, () => Filesystem.readJson<Record<string, unknown>>(filePath))
      .then((x) => {
        setStore(x as Record<string, unknown>)
      })
      .catch((err: unknown) => {
        console.error("Failed to read KV state", { filePath, err })
      })
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
        const snapshot = structuredClone(unwrap(store))
        write = write
          .then(() => Flock.withLock(lock, () => writeSnapshot(snapshot)))
          .then(() => undefined)
          .catch((err: unknown) => {
            console.error("Failed to write KV state", { filePath, err })
          })
      },
    }
    return result
  },
})
