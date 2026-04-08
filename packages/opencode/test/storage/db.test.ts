import { describe, expect, test } from "bun:test"
import path from "path"
import { Global } from "../../src/global"
import { Installation } from "../../src/installation"
import { Database } from "../../src/storage/db"

describe("Database.Path", () => {
  test("returns database path for the current channel", () => {
    const expected = ["latest", "beta"].includes(Installation.CHANNEL)
      ? path.join(Global.Path.data, "opencode.db")
      : path.join(Global.Path.data, `opencode-${Installation.CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
    expect(Database.getChannelPath()).toBe(expected)
  })
})

describe("Database auto-vacuum pragmas", () => {
  test("incremental_vacuum pragma is present in Client init", () => {
    // Verify the pragma configuration exists in the source code.
    // We read the db.ts source to confirm the pragmas are set.
    const src = require("fs").readFileSync(path.join(import.meta.dirname, "../../src/storage/db.ts"), "utf-8")
    expect(src).toContain("PRAGMA auto_vacuum = INCREMENTAL")
    expect(src).toContain("PRAGMA incremental_vacuum(1000)")
  })
})
