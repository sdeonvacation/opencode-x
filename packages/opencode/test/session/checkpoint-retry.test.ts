import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Global } from "../../src/global"
import type { SessionID } from "../../src/session/schema"
import {
  loadPriorDiscoveredTitles,
  runValidatorsForCkpt,
  quarantineCheckpoint,
  buildReflectionMessage,
} from "../../src/session/checkpoint-retry"

const SESSION = "test-session-id" as SessionID

function withDataDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const orig = Global.Path.data
  ;(Global.Path as { data: string }).data = dir
  return fn().finally(() => {
    ;(Global.Path as { data: string }).data = orig
  })
}

async function writeCheckpoint(dir: string, content: string) {
  const meta = path.join(dir, "meta", SESSION)
  await fs.mkdir(meta, { recursive: true })
  await Bun.write(path.join(meta, "checkpoint.md"), content)
  return meta
}

const VALID_CHECKPOINT = `## Current Task
Build checkpoint system

## Key Decisions
- Use markdown format

## File Changes
- src/foo.ts created

## Open Issues
- None

## Progress Summary
Done
`

describe("loadPriorDiscoveredTitles", () => {
  test("extracts h2 headings from checkpoint", async () => {
    await using tmp = await tmpdir()
    await writeCheckpoint(tmp.path, VALID_CHECKPOINT)
    const titles = await withDataDir(tmp.path, () => loadPriorDiscoveredTitles(SESSION))
    expect(titles).toEqual(["Current Task", "Key Decisions", "File Changes", "Open Issues", "Progress Summary"])
  })

  test("returns empty array when file missing", async () => {
    await using tmp = await tmpdir()
    const titles = await withDataDir(tmp.path, () => loadPriorDiscoveredTitles(SESSION))
    expect(titles).toEqual([])
  })

  test("returns empty array for content without headings", async () => {
    await using tmp = await tmpdir()
    await writeCheckpoint(tmp.path, "no headings here\njust text\n")
    const titles = await withDataDir(tmp.path, () => loadPriorDiscoveredTitles(SESSION))
    expect(titles).toEqual([])
  })
})

describe("runValidatorsForCkpt", () => {
  test("valid checkpoint passes", async () => {
    await using tmp = await tmpdir()
    await writeCheckpoint(tmp.path, VALID_CHECKPOINT)
    const r = await withDataDir(tmp.path, () => runValidatorsForCkpt(SESSION))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  test("missing file returns error", async () => {
    await using tmp = await tmpdir()
    const r = await withDataDir(tmp.path, () => runValidatorsForCkpt(SESSION))
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/not found or empty/)
  })

  test("missing sections fails snapshot validation", async () => {
    await using tmp = await tmpdir()
    await writeCheckpoint(tmp.path, "## Current Task\nfoo\n")
    const r = await withDataDir(tmp.path, () => runValidatorsForCkpt(SESSION))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.includes("missing section"))).toBe(true)
  })

  test("over budget fails budget validation", async () => {
    await using tmp = await tmpdir()
    const big = "x".repeat(100000)
    const content = VALID_CHECKPOINT + big
    await writeCheckpoint(tmp.path, content)
    const r = await withDataDir(tmp.path, () => runValidatorsForCkpt(SESSION))
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/exceeds budget/)
  })
})

describe("quarantineCheckpoint", () => {
  test("renames checkpoint to quarantine", async () => {
    await using tmp = await tmpdir()
    const meta = await writeCheckpoint(tmp.path, "content")
    await withDataDir(tmp.path, () => quarantineCheckpoint(SESSION))
    const exists = await Bun.file(path.join(meta, "checkpoint.quarantine.md")).exists()
    expect(exists).toBe(true)
    const gone = await Bun.file(path.join(meta, "checkpoint.md")).exists()
    expect(gone).toBe(false)
  })

  test("throws when file missing", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, "meta", SESSION), { recursive: true })
    await expect(withDataDir(tmp.path, () => quarantineCheckpoint(SESSION))).rejects.toThrow()
  })
})

describe("buildReflectionMessage", () => {
  test("formats single error", () => {
    const msg = buildReflectionMessage(["missing section: ## Key Decisions"])
    expect(msg).toContain("1. missing section: ## Key Decisions")
    expect(msg).toContain("Fix the above issues")
  })

  test("formats multiple errors as numbered list", () => {
    const msg = buildReflectionMessage(["error one", "error two", "error three"])
    expect(msg).toContain("1. error one")
    expect(msg).toContain("2. error two")
    expect(msg).toContain("3. error three")
  })

  test("includes instruction to regenerate", () => {
    const msg = buildReflectionMessage(["foo"])
    expect(msg).toContain("regenerate the checkpoint")
  })

  test("handles empty errors array", () => {
    const msg = buildReflectionMessage([])
    expect(msg).toContain("failed validation")
  })
})
