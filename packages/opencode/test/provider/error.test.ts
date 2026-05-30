import { describe, expect, test } from "bun:test"
import { ProviderError } from "../../src/provider/error"

describe("provider.error.parseStreamError", () => {
  test("anthropic api_error is retryable", () => {
    const sse = '{"type":"error","error":{"type":"api_error","message":"Internal server error"}}'
    const parsed = ProviderError.parseStreamError(sse)
    expect(parsed?.type).toBe("api_error")
    expect(parsed?.type === "api_error" && parsed.isRetryable).toBe(true)
    expect(parsed?.message).toContain("Internal server error")
  })

  test("anthropic overloaded_error is retryable", () => {
    const sse = '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'
    const parsed = ProviderError.parseStreamError(sse)
    expect(parsed?.type === "api_error" && parsed.isRetryable).toBe(true)
  })

  test("anthropic rate_limit_error is retryable", () => {
    const sse = '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}'
    const parsed = ProviderError.parseStreamError(sse)
    expect(parsed?.type === "api_error" && parsed.isRetryable).toBe(true)
  })

  test("invalid_request_error is not retryable", () => {
    const sse = '{"type":"error","error":{"type":"invalid_request_error","message":"bad input"}}'
    const parsed = ProviderError.parseStreamError(sse)
    expect(parsed?.type === "api_error" && parsed.isRetryable).toBe(false)
  })

  test("authentication_error is not retryable", () => {
    const sse = '{"type":"error","error":{"type":"authentication_error","message":"bad key"}}'
    const parsed = ProviderError.parseStreamError(sse)
    expect(parsed?.type === "api_error" && parsed.isRetryable).toBe(false)
  })

  test("openai insufficient_quota stays non-retryable", () => {
    const sse = '{"type":"error","error":{"code":"insufficient_quota","message":"out of quota"}}'
    const parsed = ProviderError.parseStreamError(sse)
    expect(parsed?.type === "api_error" && parsed.isRetryable).toBe(false)
  })

  test("openai context_length_exceeded surfaces as context_overflow", () => {
    const sse = '{"type":"error","error":{"code":"context_length_exceeded","message":"too long"}}'
    const parsed = ProviderError.parseStreamError(sse)
    expect(parsed?.type).toBe("context_overflow")
  })
})
