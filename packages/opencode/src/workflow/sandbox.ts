import {
  newQuickJSAsyncWASMModuleFromVariant,
  shouldInterruptAfterDeadline,
  type QuickJSAsyncWASMModule,
  type QuickJSAsyncContext,
  type QuickJSAsyncRuntime,
  type QuickJSHandle,
} from "quickjs-emscripten"
import variant from "@jitl/quickjs-singlefile-mjs-release-asyncify"

let wasm: Promise<QuickJSAsyncWASMModule> | undefined

function module() {
  if (!wasm) wasm = newQuickJSAsyncWASMModuleFromVariant(variant)
  return wasm
}

// Mutex: asyncify supports only one suspended call per WASM module
let lock: Promise<void> = Promise.resolve()
let busy = false

function acquire(): Promise<() => void> {
  let release: () => void
  const prev = lock
  lock = new Promise((r) => {
    release = r
  })
  return prev.then(() => {
    busy = true
    return () => {
      busy = false
      release!()
    }
  })
}

export function isBusy(): boolean {
  return busy
}

// Mulberry32 PRNG — deterministic, fast, 32-bit state
function prng(seed: string): string {
  return `(function(){
  var s=${hash(seed)}>>>0;
  Math.random=function(){
    s|=0;s=s+0x6D2B79F5|0;
    var t=Math.imul(s^s>>>15,1|s);
    t=t+Math.imul(t^t>>>7,61|t)^t;
    return((t^t>>>14)>>>0)/4294967296;
  };
})()`
}

function hash(str: string): number {
  let h = 0
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0
  }
  return h >>> 0
}

const PRELUDE = `
delete globalThis.Date;
delete globalThis.WeakRef;
delete globalThis.FinalizationRegistry;
`

function marshal(ctx: QuickJSAsyncContext, val: unknown): QuickJSHandle {
  if (val === null || val === undefined) return ctx.undefined
  if (typeof val === "number") return ctx.newNumber(val)
  if (typeof val === "string") return ctx.newString(val)
  if (typeof val === "boolean") return val ? ctx.true : ctx.false
  if (Array.isArray(val)) {
    const arr = ctx.newArray()
    for (let i = 0; i < val.length; i++) {
      const item = marshal(ctx, val[i])
      ctx.setProp(arr, i, item)
      item.dispose()
    }
    return arr
  }
  if (typeof val === "object") {
    const obj = ctx.newObject()
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      const prop = marshal(ctx, v)
      ctx.setProp(obj, k, prop)
      prop.dispose()
    }
    return obj
  }
  return ctx.undefined
}

function unmarshal(ctx: QuickJSAsyncContext, handle: QuickJSHandle): unknown {
  const t = ctx.typeof(handle)
  if (t === "undefined") return undefined
  if (t === "number") return ctx.getNumber(handle)
  if (t === "string") return ctx.getString(handle)
  if (t === "boolean") return ctx.dump(handle)
  if (t === "object") return ctx.dump(handle)
  return ctx.dump(handle)
}

function hooks(ctx: QuickJSAsyncContext, list: Sandbox.Hook[]) {
  for (const hook of list) {
    const fn = ctx.newAsyncifiedFunction(hook.name, async function (...args: QuickJSHandle[]) {
      const native = args.map((a) => unmarshal(ctx, a))
      const result = await hook.fn(...native)
      // Marshal result back — use evalCode for complex objects (avoids handle lifecycle issues)
      if (result === undefined || result === null) return ctx.undefined
      if (typeof result === "string") return ctx.newString(result)
      if (typeof result === "number") return ctx.newNumber(result)
      if (typeof result === "boolean") return result ? ctx.true : ctx.false
      const json = JSON.stringify(result)
      const parsed = ctx.unwrapResult(ctx.evalCode(`(${json})`))
      return parsed
    })
    ctx.setProp(ctx.global, hook.name, fn)
    fn.dispose()
  }
}

function builtins(ctx: QuickJSAsyncContext, list: Sandbox.Hook[]) {
  // parallel: calls host __parallel hook with array of task descriptors
  const parallel = ctx.newAsyncifiedFunction("parallel", async function (...args: QuickJSHandle[]) {
    const tasks = args.map((a) => unmarshal(ctx, a))
    const hook = list.find((h) => h.name === "__parallel")
    if (!hook) return marshal(ctx, tasks)
    const result = await hook.fn(tasks)
    return marshal(ctx, result)
  })
  ctx.setProp(ctx.global, "parallel", parallel)
  parallel.dispose()

  // pipeline: sequential stage execution via host
  const pipeline = ctx.newAsyncifiedFunction("pipeline", async function (...args: QuickJSHandle[]) {
    const stages = args.map((a) => unmarshal(ctx, a))
    const hook = list.find((h) => h.name === "__pipeline")
    if (!hook) return marshal(ctx, stages)
    const result = await hook.fn(stages)
    return marshal(ctx, result)
  })
  ctx.setProp(ctx.global, "pipeline", pipeline)
  pipeline.dispose()
}

export namespace Sandbox {
  export type Hook = {
    name: string
    fn: (...args: unknown[]) => Promise<unknown>
  }

  export type Options = {
    memory: number
    deadline: number
    seed: string
    hooks: Hook[]
  }

  export type Result = {
    value: unknown
    duration: number
    memory: number
  }

  export const defaults = {
    memory: 64 * 1024 * 1024,
    deadline: 300_000,
    seed: "default",
    hooks: [] as Hook[],
  } satisfies Options

  export async function evaluate(script: string, opts: Partial<Options> = {}): Promise<Result> {
    const release = await acquire()
    try {
      return await run(script, opts)
    } finally {
      release()
    }
  }

  async function run(script: string, opts: Partial<Options>): Promise<Result> {
    const cfg = { ...defaults, ...opts }
    const mod = await module()
    const runtime = mod.newRuntime()
    const ctx = runtime.newContext()

    runtime.setMemoryLimit(cfg.memory)
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + cfg.deadline))

    try {
      // Inject PRNG + delete non-deterministic globals
      const prelude = PRELUDE + prng(cfg.seed)
      ctx.unwrapResult(await ctx.evalCodeAsync(prelude, "prelude.js"))?.dispose()

      // Inject user hooks
      hooks(ctx, cfg.hooks)
      builtins(ctx, cfg.hooks)

      const start = Date.now()
      const raw = await ctx.evalCodeAsync(script, "sandbox.js")
      const duration = Date.now() - start
      const mem = parseMemory(runtime)

      if (raw.error) {
        const err = ctx.dump(raw.error)
        try {
          raw.error.dispose()
        } catch {}
        throw typeof err === "object" && err !== null
          ? Object.assign(new Error("Sandbox error"), err)
          : new Error(String(err))
      }

      const value = ctx.dump(raw.value)
      try {
        raw.value.dispose()
      } catch {}
      return { value, duration, memory: mem }
    } finally {
      dispose(runtime, ctx)
    }
  }

  export function dispose(_runtime: QuickJSAsyncRuntime, _ctx: QuickJSAsyncContext) {
    // Intentionally do NOT dispose runtime/ctx.
    // QuickJS asyncified functions leave dangling host refs that trigger
    // a fatal WASM abort (gc_obj_list assertion) on disposal.
    // Let GC reclaim the memory instead — safe since each eval gets a fresh runtime.
  }
}

function parseMemory(runtime: QuickJSAsyncRuntime): number {
  const usage = runtime.dumpMemoryUsage()
  const match = usage.match(/memory_used_size:\s*(\d+)/) ?? usage.match(/malloc_limit:\s*(\d+)/)
  if (match) return Number(match[1])
  return usage.length
}
