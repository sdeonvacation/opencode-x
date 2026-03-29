import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { GlobalEvent, Event } from "@opencode-ai/sdk/v2"
import { createSimpleContext } from "./helper"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { batch, onCleanup, onMount } from "solid-js"

export type EventSource = {
  subscribe: (directory: string | undefined, handler: (event: Event) => void) => Promise<() => void>
  setWorkspace?: (workspaceID?: string) => void
  changeDirectory?: (directory: string) => Promise<void>
}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: {
    url: string
    directory?: string
    fetch?: typeof fetch
    headers?: RequestInit["headers"]
    events?: EventSource
  }) => {
    const abort = new AbortController()
    let workspaceID: string | undefined
    let currentDirectory = props.directory
    let sse: AbortController | undefined

    function createSDK() {
      return createOpencodeClient({
        baseUrl: props.url,
        signal: abort.signal,
        directory: currentDirectory,
        fetch: props.fetch,
        headers: props.headers,
      })
    }

    let sdk = createSDK()

    const emitter = createGlobalEmitter<{
      event: GlobalEvent
    }>()

    let queue: GlobalEvent[] = []
    let timer: Timer | undefined
    let last = 0

    const flush = () => {
      if (queue.length === 0) return
      const events = queue
      queue = []
      timer = undefined
      last = Date.now()
      batch(() => {
        for (const event of events) {
          emitter.emit("event", event)
        }
      })
    }

    const handleEvent = (event: GlobalEvent) => {
      queue.push(event)

      if (event.type === "message.part.delta") {
        if (timer) {
          clearTimeout(timer)
          timer = undefined
        }
        flush()
        return
      }

      const elapsed = Date.now() - last
      if (timer) return
      if (elapsed < 16) {
        timer = setTimeout(flush, 16)
        return
      }
      flush()
    }

    function startSSE() {
      sse?.abort()
      const ctrl = new AbortController()
      sse = ctrl
      ;(async () => {
        while (true) {
          if (abort.signal.aborted || ctrl.signal.aborted) break
          const events = await sdk.global.event({ signal: ctrl.signal })

          for await (const event of events.stream) {
            if (ctrl.signal.aborted) break
            handleEvent(event)
          }

          if (timer) clearTimeout(timer)
          if (queue.length > 0) flush()
        }
      })().catch(() => {})
    }

    onMount(async () => {
      if (props.events) {
        const unsub = await props.events.subscribe(handleEvent)
        onCleanup(unsub)
      } else {
        startSSE()
      }
    })

    onCleanup(() => {
      abort.abort()
      sse?.abort()
      if (timer) clearTimeout(timer)
    })

    return {
      get client() {
        return sdk
      },
      get workspaceID() {
        return workspaceID
      },
      get directory() {
        return currentDirectory
      },
      event: emitter,
      fetch: props.fetch ?? fetch,
      setWorkspace(next?: string) {
        if (workspaceID === next) return
        workspaceID = next
        sdk = createSDK()
        props.events?.setWorkspace?.(next)
        if (!props.events) startSSE()
      },
      async changeDirectory(directory: string) {
        currentDirectory = directory
        await props.events?.changeDirectory?.(directory)
        sdk = createSDK()
      },
      url: props.url,
    }
  },
})
