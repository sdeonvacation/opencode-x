import { Config, Effect, Layer, ServiceMap } from "effect"

type ConfigMap = Record<string, Config.Config<unknown>>

/**
 * The service shape inferred from an object of Effect `Config` definitions.
 */
export type Shape<Fields extends ConfigMap> = {
  readonly [Key in keyof Fields]: Config.Success<Fields[Key]>
}

/**
 * A ServiceMap service class with generated layers for config-backed services.
 */
export type ServiceClass<Self, Id extends string, Service> = ServiceMap.ServiceClass<Self, Id, Service> & {
  /** Provide already-parsed config, useful in tests. */
  readonly layer: (input: Service) => Layer.Layer<Self>
  /** Parse config once from the active Effect ConfigProvider and provide the service. */
  readonly defaultLayer: Layer.Layer<Self, Config.ConfigError>
}

/**
 * Create a ServiceMap service whose implementation is derived from Effect `Config`.
 */
export const Service =
  <Self>() =>
  <const Id extends string, const Fields extends ConfigMap>(id: Id, fields: Fields) => {
    class ConfigTag extends ServiceMap.Service<Self, Shape<Fields>>()(id) {
      static layer(input: Shape<Fields>) {
        return Layer.succeed(this, this.of(input))
      }

      static get defaultLayer() {
        const self = this
        return Layer.effect(
          this,
          Effect.gen(function* () {
            const config = yield* Config.all(fields)
            return self.of(config as Shape<Fields>)
          }),
        )
      }
    }

    return ConfigTag as unknown as ServiceClass<Self, Id, Shape<Fields>>
  }

export * as ConfigService from "./config-service"
