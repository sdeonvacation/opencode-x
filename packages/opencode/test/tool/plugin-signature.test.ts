import { describe, expect, test } from "bun:test"
import {
  computePluginDefinitionSignature,
  createPluginSignatureState,
  type PluginSignatureState,
} from "../../src/tool/plugin-signature"

describe("tool/plugin-signature", () => {
  test("createPluginSignatureState returns empty WeakMaps and seq=1", () => {
    const state = createPluginSignatureState()
    expect(state.pluginHookSeq).toBe(1)
    expect(state.pluginHookID).toBeInstanceOf(WeakMap)
    expect(state.pluginFunctionID).toBeInstanceOf(WeakMap)
    expect(state.cache).toBeUndefined()
  })

  test("empty hooks list returns empty string", () => {
    const state = createPluginSignatureState()
    expect(computePluginDefinitionSignature([], state)).toBe("")
  })

  test("hooks without tool.definition are skipped", () => {
    const state = createPluginSignatureState()
    const hook = { "other.hook": () => {} }
    expect(computePluginDefinitionSignature([hook], state)).toBe("")
  })

  test("same hook object returns same signature on repeated calls", () => {
    const state = createPluginSignatureState()
    const fn = async () => {}
    const hook = { "tool.definition": fn }

    const first = computePluginDefinitionSignature([hook], state)
    const second = computePluginDefinitionSignature([hook], state)
    expect(first).toBe(second)
    expect(first).not.toBe("")
  })

  test("new hook object invalidates cache (sets state.cache to undefined)", () => {
    const state = createPluginSignatureState()
    const fn = async () => {}
    const hook1 = { "tool.definition": fn }

    // Seed a fake cache value
    state.cache = { some: "cached-data" }

    computePluginDefinitionSignature([hook1], state)
    // hook1 is new → cache should be cleared
    expect(state.cache).toBeUndefined()
  })

  test("new function reference on existing hook invalidates cache", () => {
    const state = createPluginSignatureState()
    const hook: Record<string, unknown> = { "tool.definition": async () => {} }

    // First call — registers hook and fn
    computePluginDefinitionSignature([hook], state)

    // Seed a fake cache value
    state.cache = { some: "cached-data" }

    // Replace the function reference
    hook["tool.definition"] = async () => {}
    computePluginDefinitionSignature([hook], state)

    expect(state.cache).toBeUndefined()
  })

  test("same function reference does NOT invalidate cache", () => {
    const state = createPluginSignatureState()
    const fn = async () => {}
    const hook = { "tool.definition": fn }

    // First call — registers hook and fn
    computePluginDefinitionSignature([hook], state)

    // Seed a fake cache value
    state.cache = { some: "cached-data" }

    // Second call with same references — cache should remain
    computePluginDefinitionSignature([hook], state)
    expect(state.cache).toEqual({ some: "cached-data" })
  })

  test("multiple hooks produce comma-joined signature", () => {
    const state = createPluginSignatureState()
    const fn1 = async () => {}
    const fn2 = async () => {}
    const hook1 = { "tool.definition": fn1 }
    const hook2 = { "tool.definition": fn2 }

    const sig = computePluginDefinitionSignature([hook1, hook2], state)
    expect(sig).toMatch(/^\d+:\d+,\d+:\d+$/)
  })

  test("signature is stable across calls with same hooks", () => {
    const state = createPluginSignatureState()
    const fn = async () => {}
    const hook = { "tool.definition": fn }

    const sigs = Array.from({ length: 5 }, () => computePluginDefinitionSignature([hook], state))
    expect(new Set(sigs).size).toBe(1)
  })

  test("seq counter increments for each new hook and function", () => {
    const state = createPluginSignatureState()
    expect(state.pluginHookSeq).toBe(1)

    const fn = async () => {}
    const hook = { "tool.definition": fn }
    computePluginDefinitionSignature([hook], state)

    // hook gets ID 1, fn gets ID 2 → seq is now 3
    expect(state.pluginHookSeq).toBe(3)
  })

  test("second call with same hook does not advance seq", () => {
    const state = createPluginSignatureState()
    const fn = async () => {}
    const hook = { "tool.definition": fn }

    computePluginDefinitionSignature([hook], state)
    const seqAfterFirst = state.pluginHookSeq

    computePluginDefinitionSignature([hook], state)
    expect(state.pluginHookSeq).toBe(seqAfterFirst)
  })
})
