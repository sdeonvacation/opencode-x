import { Config, Effect, Layer, ServiceMap } from "effect"

type ConfigMap = Record<string, Config.Config<unknown>>

export type Shape<Fields extends ConfigMap> = {
  readonly [Key in keyof Fields]: Config.Success<Fields[Key]>
}

export type ServiceClass<Self, Id extends string, Service> = ServiceMap.ServiceClass<Self, Id, Service> & {
  readonly layer: (input: Service) => Layer.Layer<Self>
  readonly defaultLayer: Layer.Layer<Self, Config.ConfigError>
}

export const Service =
  <Self>() =>
  <const Id extends string, const Fields extends ConfigMap>(id: Id, fields: Fields) => {
    class ConfigTag extends ServiceMap.Service<Self, Shape<Fields>>()(id) {
      static layer(input: Shape<Fields>) {
        return Layer.succeed(this, this.of(input))
      }

      static get defaultLayer() {
        return Layer.effect(
          this,
          Config.all(fields)
            .asEffect()
            .pipe(Effect.map((config) => this.of(config as Shape<Fields>))),
        )
      }
    }

    return ConfigTag as ServiceClass<Self, Id, Shape<Fields>>
  }

export * as ConfigService from "./config-service"
