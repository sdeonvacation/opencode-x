import { describe, expect, test } from "bun:test"
import { Config, ConfigProvider, Effect, Layer } from "effect"
import { ConfigService } from "../../src/effect/config-service"

describe("ConfigService", () => {
  class TestConfig extends ConfigService.Service<TestConfig>()("@test/Config", {
    port: Config.number("PORT").pipe(Config.withDefault(3000)),
    host: Config.string("HOST").pipe(Config.withDefault("localhost")),
    debug: Config.boolean("DEBUG").pipe(Config.withDefault(false)),
  }) {}

  test("layer provides explicit values", async () => {
    const result = await Effect.gen(function* () {
      const cfg = yield* TestConfig
      return cfg
    }).pipe(Effect.provide(TestConfig.layer({ port: 8080, host: "example.com", debug: true })), Effect.runPromise)

    expect(result.port).toBe(8080)
    expect(result.host).toBe("example.com")
    expect(result.debug).toBe(true)
  })

  test("defaultLayer resolves from ConfigProvider", async () => {
    const provider = ConfigProvider.fromUnknown({ PORT: "9090", HOST: "prod.io", DEBUG: "true" })
    const result = await Effect.gen(function* () {
      return yield* TestConfig
    }).pipe(
      Effect.provide(TestConfig.defaultLayer.pipe(Layer.provide(ConfigProvider.layer(provider)))),
      Effect.runPromise,
    )

    expect(result.port).toBe(9090)
    expect(result.host).toBe("prod.io")
    expect(result.debug).toBe(true)
  })

  test("defaultLayer uses defaults when config missing", async () => {
    const provider = ConfigProvider.fromUnknown({})
    const result = await Effect.gen(function* () {
      return yield* TestConfig
    }).pipe(
      Effect.provide(TestConfig.defaultLayer.pipe(Layer.provide(ConfigProvider.layer(provider)))),
      Effect.runPromise,
    )

    expect(result.port).toBe(3000)
    expect(result.host).toBe("localhost")
    expect(result.debug).toBe(false)
  })

  test("defaultLayer fails on required config missing", async () => {
    class Required extends ConfigService.Service<Required>()("@test/Required", {
      secret: Config.string("SECRET"),
    }) {}

    const provider = ConfigProvider.fromUnknown({})
    const exit = await Effect.gen(function* () {
      return yield* Required
    }).pipe(
      Effect.provide(Required.defaultLayer.pipe(Layer.provide(ConfigProvider.layer(provider)))),
      Effect.runPromiseExit,
    )

    expect(exit._tag).toBe("Failure")
  })
})
