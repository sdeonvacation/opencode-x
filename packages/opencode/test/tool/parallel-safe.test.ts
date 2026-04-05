import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { BashTool } from "../../src/tool/bash"
import { BatchTool } from "../../src/tool/batch"
import { EditTool } from "../../src/tool/edit"
import { GlobTool } from "../../src/tool/glob"
import { GrepTool } from "../../src/tool/grep"
import { ReadTool } from "../../src/tool/read"
import { TaskTool } from "../../src/tool/task"
import { WriteTool } from "../../src/tool/write"
import { Agent } from "../../src/agent/agent"
import { AppFileSystem } from "../../src/filesystem"
import { FileTime } from "../../src/file/time"
import { Instruction } from "../../src/session/instruction"
import { LSP } from "../../src/lsp"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

describe("tool parallelSafe metadata", () => {
  test("marks grep and glob as parallel safe", () => {
    expect(GrepTool.parallelSafe).toBe(true)
    expect(GlobTool.parallelSafe).toBe(true)
  })

  test("marks read as parallel safe in info and resolved definition", async () => {
    const layer = Layer.mergeAll(
      Agent.defaultLayer,
      AppFileSystem.defaultLayer,
      CrossSpawnSpawner.defaultLayer,
      FileTime.defaultLayer,
      Instruction.defaultLayer,
      LSP.defaultLayer,
    )
    const read = await Effect.runPromise(
      Effect.scoped(Effect.map(ReadTool, (tool) => tool)).pipe(Effect.provide(layer)),
    )
    const resolved = await read.init()
    expect(read.parallelSafe).toBe(true)
    expect(resolved.parallelSafe).toBe(true)
  })

  test("leaves stateful tools non-parallel-safe", () => {
    expect(BashTool.parallelSafe).toBeUndefined()
    expect(EditTool.parallelSafe).toBeUndefined()
    expect(WriteTool.parallelSafe).toBeUndefined()
    expect(TaskTool.parallelSafe).toBeUndefined()
    expect(BatchTool.parallelSafe).toBeUndefined()
  })
})
