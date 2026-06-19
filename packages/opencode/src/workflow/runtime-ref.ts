export namespace WorkflowRuntimeRef {
  export type StartInput = {
    name: string
    args?: Record<string, unknown>
    session: string
    parent?: string
    concurrent?: number
    timeout?: number
  }

  export type RunSummary = { id: string; name: string; status: string; error?: string }

  export type Ref = {
    start: (input: StartInput) => Promise<string>
    status: (id: string) => Promise<{ id: string; status: string; error?: string } | undefined>
    cancel: (id: string) => Promise<void>
    list: (session?: string) => RunSummary[]
  }

  let current: Ref | undefined

  export function set(ref: Ref): void {
    current = ref
  }

  export function get(): Ref | undefined {
    return current
  }
}
