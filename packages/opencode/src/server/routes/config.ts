import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Config } from "../../config/config"
import { Provider } from "../../provider/provider"
import { Hook } from "../../hook/hook"
import { mapValues } from "remeda"
import { errors } from "../error"
import { Log } from "../../util/log"
import { lazy } from "../../util/lazy"

const SENSITIVE = /key|token|secret|password|credential/i

function flattenConfig(obj: unknown, prefix = ""): Array<{ key: string; value: string }> {
  const entries: Array<{ key: string; value: string }> = []
  if (obj === null || obj === undefined) return entries
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      entries.push(...flattenConfig(obj[i], `${prefix}[${i}]`))
    }
    return entries
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k
      if (v === null || v === undefined) continue
      entries.push(...flattenConfig(v, path))
    }
    return entries
  }
  const val = SENSITIVE.test(prefix) ? "[REDACTED]" : String(obj)
  entries.push({ key: prefix, value: val })
  return entries
}

const log = Log.create({ service: "server" })

export const ConfigRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get configuration",
        description: "Retrieve the current OpenCode configuration settings and preferences.",
        operationId: "config.get",
        responses: {
          200: {
            description: "Get config info",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        const config = await Config.get()
        if (!config.hooks) {
          const rules = await Hook.load()
          const active = Object.fromEntries(Object.entries(rules).filter(([, v]) => v.length > 0))
          if (Object.keys(active).length > 0) config.hooks = active as any
        }
        return c.json(config)
      },
    )
    .patch(
      "/",
      describeRoute({
        summary: "Update configuration",
        description: "Update OpenCode configuration settings and preferences.",
        operationId: "config.update",
        responses: {
          200: {
            description: "Successfully updated config",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Config.Info),
      async (c) => {
        const config = c.req.valid("json")
        await Config.update(config)
        return c.json(config)
      },
    )
    .get(
      "/providers",
      describeRoute({
        summary: "List config providers",
        description: "Get a list of all configured AI providers and their default models.",
        operationId: "config.providers",
        responses: {
          200: {
            description: "List of providers",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    providers: Provider.Info.array(),
                    default: z.record(z.string(), z.string()),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        using _ = log.time("providers")
        const providers = await Provider.list().then((x) => mapValues(x, (item) => item))
        return c.json({
          providers: Object.values(providers),
          default: mapValues(providers, (item) => Provider.sort(Object.values(item.models))[0].id),
        })
      },
    )
    .get(
      "/flat",
      describeRoute({
        summary: "Get flat configuration",
        description: "Get merged configuration as flattened key-value pairs with sensitive values redacted.",
        operationId: "config.flat",
        responses: {
          200: {
            description: "Flat config entries",
            content: {
              "application/json": {
                schema: resolver(
                  z
                    .object({
                      entries: z.array(
                        z.object({
                          key: z.string(),
                          value: z.string(),
                        }),
                      ),
                    })
                    .meta({ ref: "ConfigFlat" }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const config = await Config.get()
        const entries = flattenConfig(config).sort((a, b) => a.key.localeCompare(b.key))
        return c.json({ entries })
      },
    ),
)
