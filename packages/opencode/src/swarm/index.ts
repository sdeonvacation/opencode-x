import z from "zod"
import { BusEvent } from "../bus/bus-event"

export namespace Swarm {
  // --- Types ---
  export type Status = "idle" | "active" | "completing"

  export type Item = {
    id: string
    input: Record<string, string>
  }

  export type Result = {
    id: string
    status: "done" | "error"
    output: string
    duration: number
  }

  export type Config = {
    template: string
    items: Item[]
    agent: string
    concurrency: number
    background: boolean
  }

  export type State = {
    status: Status
    config: Config
    results: Result[]
    started: number
  }

  // --- Template ---
  const PLACEHOLDER = /\{\{(\w+)\}\}/g

  export function placeholders(template: string): string[] {
    const keys: string[] = []
    let match: RegExpExecArray | null
    const re = new RegExp(PLACEHOLDER.source, "g")
    while ((match = re.exec(template)) !== null) {
      if (!keys.includes(match[1])) keys.push(match[1])
    }
    return keys
  }

  export function render(template: string, input: Record<string, string>): string {
    return template.replace(PLACEHOLDER, (_, key) => {
      if (!(key in input)) throw new Error(`Missing placeholder key: {{${key}}}`)
      return input[key]
    })
  }

  export function validate(template: string, items: Item[]): string[] {
    const keys = placeholders(template)
    if (keys.length === 0) return ["Template contains no {{placeholders}}"]
    const errors: string[] = []
    for (const item of items) {
      for (const key of keys) {
        if (!(key in item.input)) {
          errors.push(`Item "${item.id}" missing key "${key}"`)
        }
      }
    }
    return errors
  }

  // --- State Machine ---
  export function start(config: Config): State {
    return {
      status: "active",
      config,
      results: [],
      started: Date.now(),
    }
  }

  export function itemDone(state: State, result: Result): State {
    const results = [...state.results, result]
    const done = results.length >= state.config.items.length
    return {
      ...state,
      status: done ? "completing" : "active",
      results,
    }
  }

  export function isComplete(state: State): boolean {
    return state.results.length >= state.config.items.length
  }
}

// --- Bus Events ---
export namespace SwarmEvent {
  export const Started = BusEvent.define(
    "swarm.started",
    z.object({
      sessionID: z.string(),
      agent: z.string(),
      total: z.number(),
      concurrency: z.number(),
    }),
  )

  export const ItemComplete = BusEvent.define(
    "swarm.item-complete",
    z.object({
      sessionID: z.string(),
      itemID: z.string(),
      status: z.enum(["done", "error"]),
      completed: z.number(),
      total: z.number(),
    }),
  )

  export const Done = BusEvent.define(
    "swarm.done",
    z.object({
      sessionID: z.string(),
      success: z.number(),
      failed: z.number(),
      total: z.number(),
      durationMs: z.number(),
    }),
  )
}
