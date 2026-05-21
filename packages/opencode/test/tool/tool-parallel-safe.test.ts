import { describe, expect, test } from "bun:test"
import { Tool } from "../../src/tool/tool"
import z from "zod"

const params = z.object({ command: z.string() })

function makeDef(parallelSafe?: boolean | ((input: any) => boolean)) {
  return {
    description: "test",
    parameters: params,
    parallelSafe,
    async execute() {
      return { title: "t", output: "ok", metadata: {} }
    },
  }
}

describe("Tool.evalParallelSafe", () => {
  describe("boolean form", () => {
    test("returns true when parallelSafe is true", () => {
      const info = Tool.define("t", makeDef(true))
      expect(Tool.evalParallelSafe(info, {})).toBe(true)
    })

    test("returns false when parallelSafe is false", () => {
      const info = Tool.define("t", makeDef(false))
      expect(Tool.evalParallelSafe(info, {})).toBe(false)
    })

    test("returns false when parallelSafe is undefined", () => {
      const info = Tool.define("t", makeDef(undefined))
      expect(Tool.evalParallelSafe(info, {})).toBe(false)
    })
  })

  describe("function form", () => {
    test("calls predicate and returns true when predicate returns true", () => {
      const predicate = (_input: any) => true
      const info = Tool.define("t", makeDef(predicate))
      expect(Tool.evalParallelSafe(info, { command: "ls -la" })).toBe(true)
    })

    test("calls predicate and returns false when predicate returns false", () => {
      const predicate = (_input: any) => false
      const info = Tool.define("t", makeDef(predicate))
      expect(Tool.evalParallelSafe(info, { command: "rm -rf" })).toBe(false)
    })

    test("predicate receives the input argument", () => {
      let received: any = undefined
      const predicate = (input: any) => {
        received = input
        return true
      }
      const info = Tool.define("t", makeDef(predicate))
      const input = { command: "ls" }
      Tool.evalParallelSafe(info, input)
      expect(received).toBe(input)
    })

    test("predicate can discriminate based on input content", () => {
      const predicate = (input: any) => (input as { command: string }).command.startsWith("ls")
      const info = Tool.define("t", makeDef(predicate))
      expect(Tool.evalParallelSafe(info, { command: "ls -la" })).toBe(true)
      expect(Tool.evalParallelSafe(info, { command: "rm -rf" })).toBe(false)
    })
  })

  describe("third-argument override on function-based define", () => {
    test("override function is stored on Info.parallelSafe", () => {
      const predicate = (input: any) => (input as { command: string }).command === "ls"
      const info = Tool.define("bash-like", async () => Promise.resolve(makeDef(undefined)), predicate)
      expect(typeof info.parallelSafe).toBe("function")
      expect(Tool.evalParallelSafe(info, { command: "ls" })).toBe(true)
      expect(Tool.evalParallelSafe(info, { command: "npm test" })).toBe(false)
    })

    test("boolean override on function-based define", () => {
      const info = Tool.define("always-safe", async () => Promise.resolve(makeDef(undefined)), true)
      expect(info.parallelSafe).toBe(true)
      expect(Tool.evalParallelSafe(info, {})).toBe(true)
    })
  })
})
