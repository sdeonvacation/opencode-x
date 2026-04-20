import { describe, expect, test } from "bun:test"
import { Config } from "../../src/config/config"

describe("config.hybrid", () => {
  test("parses full hybrid config", () => {
    const cfg = Config.Info.parse({
      provider: {
        openai: {},
        "openai-compatible": {},
      },
      hybrid: {
        enabled: true,
        local_model: {
          providerID: "openai-compatible",
          modelID: "llama3.2:8b",
        },
        cloud_model: {
          providerID: "openai",
          modelID: "gpt-5.2",
        },
        log_routing: true,
      },
    })

    expect(cfg.hybrid?.enabled).toBe(true)
    expect(cfg.hybrid?.local_model?.providerID).toBe("openai-compatible")
    expect(cfg.hybrid?.cloud_model?.modelID).toBe("gpt-5.2")
    expect(cfg.hybrid?.log_routing).toBe(true)
  })

  test("applies hybrid defaults", () => {
    const cfg = Config.Info.parse({
      hybrid: {},
    })

    expect(cfg.hybrid).toEqual({
      enabled: false,
      log_routing: false,
      compression_threshold: 10,
      compression_timeout_ms: 5000,
    })
  })

  test("rejects unknown hybrid providers", () => {
    const result = Config.Info.safeParse({
      provider: {
        openai: {},
      },
      hybrid: {
        local_model: {
          providerID: "missing",
          modelID: "llama3.2:8b",
        },
      },
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues.some((issue) => issue.path.join(".") === "hybrid.local_model.providerID")).toBe(true)
  })

  test("rejects extra hybrid fields", () => {
    const result = Config.Info.safeParse({
      hybrid: {
        foo: true,
      },
    })

    expect(result.success).toBe(false)
  })
})
