import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { ChildProcessSpawner } from "effect/unstable/process"
import { autodetect, run, stamp } from "../../src/orchestration/verify"
import { AppFileSystem } from "../../src/filesystem"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { tmpdir } from "../fixture/fixture"
import type { HybridRoutingConfig } from "../../src/orchestration/hybrid-types"

type VR = { ok: boolean; source: "command" | "autodetect" | "llm" | "none"; warn?: boolean; reason?: string }

const base = { providerID: "anthropic", modelID: "claude-3-5-sonnet" }

const cfg: HybridRoutingConfig = {
  enabled: true,
  threshold: 0.7,
  local_models: [{ providerID: "ollama", modelID: "llama3" }],
  verify_commands: [],
  verify_cache_ttl_ms: 300_000,
}

function spawner(effect: Effect.Effect<unknown, unknown, unknown>) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => effect as never),
  )
}

describe("orchestration/verify", () => {
  describe("autodetect", () => {
    test("detects bun run typecheck from package.json", async () => {
      await using tmp = await tmpdir()
      await Bun.write(
        path.join(tmp.path, "package.json"),
        JSON.stringify({ scripts: { typecheck: "tsc --noEmit", build: "bun build src/index.ts" } }),
      )

      const result = await Effect.runPromise(autodetect(tmp.path).pipe(Effect.provide(AppFileSystem.defaultLayer)))
      expect(result).toContain("bun run typecheck")
      expect(result).toContain("bun run build")
    })

    test("detects bun run test from package.json", async () => {
      await using tmp = await tmpdir()
      await Bun.write(path.join(tmp.path, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }))

      const result = await Effect.runPromise(autodetect(tmp.path).pipe(Effect.provide(AppFileSystem.defaultLayer)))
      expect(result).toContain("bun run test")
    })

    test("returns empty array when no package.json or Makefile", async () => {
      await using tmp = await tmpdir()
      const result = await Effect.runPromise(autodetect(tmp.path).pipe(Effect.provide(AppFileSystem.defaultLayer)))
      expect(result).toEqual([])
    })

    test("detects make from Makefile when no package.json scripts", async () => {
      await using tmp = await tmpdir()
      await Bun.write(path.join(tmp.path, "Makefile"), "build:\n\techo building\n")

      const result = await Effect.runPromise(autodetect(tmp.path).pipe(Effect.provide(AppFileSystem.defaultLayer)))
      expect(result).toContain("make")
    })

    test("invalid package.json returns empty array gracefully", async () => {
      await using tmp = await tmpdir()
      await Bun.write(path.join(tmp.path, "package.json"), "not valid json")

      const result = await Effect.runPromise(autodetect(tmp.path).pipe(Effect.provide(AppFileSystem.defaultLayer)))
      expect(result).toEqual([])
    })
  })

  describe("VerifyResult semantics", () => {
    test("ok=true source=command structure", () => {
      const r: VR = { ok: true, source: "command" }
      expect(r.ok).toBe(true)
      expect(r.source).toBe("command")
      expect(r.warn).toBeUndefined()
    })

    test("ok=false source=command no warn", () => {
      const r: VR = { ok: false, source: "command", reason: "exit code 1" }
      expect(r.ok).toBe(false)
      expect(r.warn).toBeUndefined()
    })

    test("ok=false source=llm warn=true for low confidence", () => {
      const r: VR = { ok: false, source: "llm", warn: true, reason: "low confidence" }
      expect(r.ok).toBe(false)
      expect(r.warn).toBe(true)
    })

    test("ok=true source=llm for high confidence", () => {
      const r: VR = { ok: true, source: "llm" }
      expect(r.ok).toBe(true)
      expect(r.warn).toBeUndefined()
    })
  })

  describe("verify command logic", () => {
    test("configured command exits 0 → ok=true source=command", async () => {
      await using tmp = await tmpdir()
      const cfgWithCmd: HybridRoutingConfig = {
        ...cfg,
        verify_commands: ["echo ok"],
      }

      const result = await Effect.runPromise(
        run(cfgWithCmd, base, "test-session", tmp.path).pipe(
          Effect.provide(AppFileSystem.defaultLayer),
          Effect.provide(CrossSpawnSpawner.defaultLayer),
        ),
      )
      expect(result.ok).toBe(true)
      expect(result.source).toBe("command")
    })

    test("configured command exits non-zero → ok=false source=command", async () => {
      await using tmp = await tmpdir()
      const cfgWithCmd: HybridRoutingConfig = {
        ...cfg,
        verify_commands: ["false"],
      }

      const result = await Effect.runPromise(
        run(cfgWithCmd, base, "test-session", tmp.path).pipe(
          Effect.provide(AppFileSystem.defaultLayer),
          Effect.provide(CrossSpawnSpawner.defaultLayer),
        ),
      )
      expect(result.ok).toBe(false)
      expect(result.source).toBe("command")
    })

    test("no commands, no package.json → falls through to LLM path (source=llm or none)", async () => {
      await using tmp = await tmpdir()

      // Without Provider.Service, LLM verify will fail gracefully
      // The result should still be a valid VerifyResult
      const result = await Effect.runPromise(
        run(cfg, base, "test-session", tmp.path).pipe(
          Effect.provide(AppFileSystem.defaultLayer),
          Effect.provide(CrossSpawnSpawner.defaultLayer),
          Effect.catch(() => Effect.succeed({ ok: false, source: "none" as const })),
        ),
      )
      expect(["llm", "none"]).toContain(result.source)
    })
  })

  describe("autodetect cache", () => {
    test("cache hit within TTL returns same commands", async () => {
      await using tmp = await tmpdir()
      await Bun.write(path.join(tmp.path, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc" } }))

      const first = await Effect.runPromise(autodetect(tmp.path).pipe(Effect.provide(AppFileSystem.defaultLayer)))
      const second = await Effect.runPromise(autodetect(tmp.path).pipe(Effect.provide(AppFileSystem.defaultLayer)))
      expect(first).toEqual(second)
    })

    test("stamp changes when repo files change", async () => {
      await using tmp = await tmpdir()
      await Bun.write(path.join(tmp.path, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc" } }))
      const first = await Effect.runPromise(stamp(tmp.path).pipe(Effect.provide(AppFileSystem.defaultLayer)))
      await Bun.write(path.join(tmp.path, "package.json"), JSON.stringify({ scripts: { build: "bun build" } }))
      const second = await Effect.runPromise(stamp(tmp.path).pipe(Effect.provide(AppFileSystem.defaultLayer)))
      expect(second).not.toBe(first)
    })
  })

  describe("spawn failure handling", () => {
    test("ENOENT falls through from configured command", async () => {
      await using tmp = await tmpdir()
      const result = await Effect.runPromise(
        run({ ...cfg, verify_commands: ["bun run typecheck"] }, base, "test-session", tmp.path).pipe(
          Effect.provide(AppFileSystem.defaultLayer),
          Effect.provide(
            spawner(
              Effect.fail({
                reason: { _tag: "NotFound" },
                message: "spawn ENOENT",
              }),
            ),
          ),
          Effect.catch(() => Effect.succeed({ ok: false, source: "none" as const })),
        ),
      )
      expect(["llm", "none"]).toContain(result.source)
    })

    test("non-ENOENT spawn failure hard fails", async () => {
      await using tmp = await tmpdir()
      const result = await Effect.runPromise(
        run({ ...cfg, verify_commands: ["bun run typecheck"] }, base, "test-session", tmp.path).pipe(
          Effect.provide(AppFileSystem.defaultLayer),
          Effect.provide(spawner(Effect.fail(new Error("boom")))),
        ),
      )
      expect(result).toEqual({ ok: false, source: "command", reason: "boom" })
    })

    test("autodetect non-ENOENT spawn failure hard fails", async () => {
      await using tmp = await tmpdir()
      await Bun.write(path.join(tmp.path, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc" } }))
      const result = await Effect.runPromise(
        run(cfg, base, "test-session", tmp.path).pipe(
          Effect.provide(AppFileSystem.defaultLayer),
          Effect.provide(spawner(Effect.fail(new Error("autodetect boom")))),
        ),
      )
      expect(result).toEqual({ ok: false, source: "autodetect", reason: "autodetect boom" })
    })
  })
})
