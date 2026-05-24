import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { Log } from "@/util/log"
import { Effect } from "effect"

const logger = Log.create({ service: "hybrid" })

/** Resolve hybrid local model from config. Returns undefined on any failure (silent fallback). */
export function resolveLocal(
  provider: Provider.Interface,
  cfg: Config.Info,
  caller: string,
): Effect.Effect<Provider.Model | undefined> {
  if (!cfg.hybrid?.enabled || !cfg.hybrid?.cheap_model) return Effect.succeed(undefined)
  const ref = cfg.hybrid.cheap_model
  return provider.getModel(ProviderID.make(ref.providerID), ModelID.make(ref.modelID)).pipe(
    Effect.map((m): Provider.Model | undefined => m),
    Effect.tap((m) =>
      Effect.sync(() => {
        if (cfg.hybrid?.log_routing)
          logger.info("resolve-local", { caller, providerID: ref.providerID, modelID: ref.modelID, resolved: !!m })
      }),
    ),
    Effect.catchCause(() => {
      if (cfg.hybrid?.log_routing)
        logger.info("resolve-local", {
          caller,
          providerID: ref.providerID,
          modelID: ref.modelID,
          resolved: false,
          reason: "provider error",
        })
      return Effect.succeed(undefined)
    }),
  )
}

/** Async variant for use inside Effect.promise / async contexts. */
export async function resolveLocalAsync(cfg: Config.Info, caller: string): Promise<Provider.Model | undefined> {
  if (!cfg.hybrid?.enabled || !cfg.hybrid?.cheap_model) return undefined
  const ref = cfg.hybrid.cheap_model
  try {
    const model = await Provider.getModel(ProviderID.make(ref.providerID), ModelID.make(ref.modelID))
    if (cfg.hybrid?.log_routing)
      logger.info("resolve-local", { caller, providerID: ref.providerID, modelID: ref.modelID, resolved: true })
    return model
  } catch {
    if (cfg.hybrid?.log_routing)
      logger.info("resolve-local", {
        caller,
        providerID: ref.providerID,
        modelID: ref.modelID,
        resolved: false,
        reason: "provider error",
      })
    return undefined
  }
}
