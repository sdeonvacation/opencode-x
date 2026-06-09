import { describe, expect, spyOn, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import * as Lsp from "../../src/lsp/index"
import { LSPServer } from "../../src/lsp/server"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

describe("lsp.spawn", () => {
  test("does not spawn builtin LSP for files outside instance", async () => {
    await using tmp = await tmpdir()
    const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Lsp.LSP.touchFile(path.join(tmp.path, "..", "outside.ts"))
          await Lsp.LSP.hover({
            file: path.join(tmp.path, "..", "hover.ts"),
            line: 0,
            character: 0,
          })
        },
      })

      expect(spy).toHaveBeenCalledTimes(0)
    } finally {
      spy.mockRestore()
      await Instance.disposeAll()
    }
  })

  test("would spawn builtin LSP for files inside instance", async () => {
    await using tmp = await tmpdir()
    const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await fs.mkdir(path.join(tmp.path, "src"), { recursive: true })
          await Bun.write(path.join(tmp.path, "bun.lock"), "lock")
          await Bun.write(path.join(tmp.path, "package.json"), "{}")
          await Bun.write(path.join(tmp.path, "tsconfig.json"), "{}")
          await Lsp.LSP.hover({
            file: path.join(tmp.path, "src", "inside.ts"),
            line: 0,
            character: 0,
          })
        },
      })

      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith(tmp.path)
    } finally {
      spy.mockRestore()
      await Instance.disposeAll()
    }
  })

  test("spawns typescript rooted at project root", async () => {
    await using tmp = await tmpdir()
    const spy = spyOn(LSPServer.Typescript, "spawn").mockResolvedValue(undefined)
    const root = path.join(tmp.path, "packages", "app")

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await fs.mkdir(path.join(root, "src"), { recursive: true })
          await Bun.write(path.join(tmp.path, "bun.lock"), "lock")
          await Bun.write(path.join(root, "package.json"), "{}")
          await Bun.write(path.join(root, "tsconfig.json"), "{}")
          await Lsp.LSP.hover({
            file: path.join(root, "src", "inside.ts"),
            line: 0,
            character: 0,
          })
        },
      })

      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith(tmp.path)
    } finally {
      spy.mockRestore()
      await Instance.disposeAll()
    }
  })
})
