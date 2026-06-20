import { describe, expect, test } from "bun:test"
import { ConfigProvider, Effect, Layer } from "effect"
import { Service, layer, defaultLayer, type Info } from "../../src/effect/runtime-flags"

describe("RuntimeFlags", () => {
  test("layer provides default values", async () => {
    const flags = await Effect.gen(function* () {
      return yield* Service
    }).pipe(Effect.provide(layer()), Effect.runPromise)

    expect(flags.autoShare).toBe(false)
    expect(flags.pure).toBe(false)
    expect(flags.disableDefaultPlugins).toBe(false)
    expect(flags.disableChannelDb).toBe(false)
    expect(flags.disableExternalSkills).toBe(false)
    expect(flags.disableLspDownload).toBe(false)
    expect(flags.skipMigrations).toBe(false)
    expect(flags.enableExa).toBe(false)
    expect(flags.enableParallel).toBe(false)
    expect(flags.enableExperimentalModels).toBe(false)
    expect(flags.enableQuestionTool).toBe(false)
    expect(flags.experimentalLspTool).toBe(false)
    expect(flags.experimentalPlanMode).toBe(false)
    expect(flags.experimentalWorkspaces).toBe(false)
    expect(flags.experimentalIconDiscovery).toBe(false)
    expect(flags.experimentalWebSockets).toBe(false)
    expect(flags.outputTokenMax).toBeUndefined()
    expect(flags.bashDefaultTimeoutMs).toBeUndefined()
    expect(flags.client).toBe("cli")
  })

  test("layer accepts overrides", async () => {
    const flags = await Effect.gen(function* () {
      return yield* Service
    }).pipe(Effect.provide(layer({ pure: true, enableExa: true, client: "vscode" })), Effect.runPromise)

    expect(flags.pure).toBe(true)
    expect(flags.enableExa).toBe(true)
    expect(flags.client).toBe("vscode")
    // non-overridden remain default
    expect(flags.autoShare).toBe(false)
  })

  test("defaultLayer resolves from env config provider", async () => {
    const flags = await Effect.gen(function* () {
      return yield* Service
    }).pipe(Effect.provide(defaultLayer), Effect.runPromise)

    // env likely has no OPENCODE_ vars set, so defaults apply
    expect(flags.pure).toBe(false)
    expect(flags.client).toBe("cli")
  })

  test("Info type is assignable from service shape", () => {
    const info: Info = {
      autoShare: false,
      pure: false,
      disableDefaultPlugins: false,
      disableChannelDb: false,
      disableExternalSkills: false,
      disableLspDownload: false,
      skipMigrations: false,
      enableExa: false,
      enableParallel: false,
      enableExperimentalModels: false,
      enableQuestionTool: false,
      experimentalLspTool: false,
      experimentalPlanMode: false,
      experimentalWorkspaces: false,
      experimentalIconDiscovery: false,
      experimentalWebSockets: false,
      outputTokenMax: undefined,
      bashDefaultTimeoutMs: undefined,
      client: "cli",
    }
    expect(info.client).toBe("cli")
  })

  test("individual experimental flag=false overrides umbrella=true", async () => {
    const provider = ConfigProvider.fromUnknown({
      OPENCODE_EXPERIMENTAL: "true",
      OPENCODE_EXPERIMENTAL_WORKSPACES: "false",
    })
    const flags = await Effect.gen(function* () {
      return yield* Service
    }).pipe(
      Effect.provide(Service.defaultLayer.pipe(Layer.provide(ConfigProvider.layer(provider)), Layer.orDie)),
      Effect.runPromise,
    )

    expect(flags.experimentalWorkspaces).toBe(false)
    // other experimental flags still inherit umbrella=true
    expect(flags.experimentalPlanMode).toBe(true)
  })
})
