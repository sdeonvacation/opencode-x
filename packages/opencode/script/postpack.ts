#!/usr/bin/env bun
/**
 * Restores the original package.json after npm pack/publish.
 */
import { resolve } from "path"
import { unlinkSync } from "fs"

const dir = resolve(import.meta.dirname, "..")
const path = resolve(dir, "package.json")
const backup = resolve(dir, "package.json.bak")

const original = await Bun.file(backup).text()
await Bun.file(path).write(original)
unlinkSync(backup)
console.log("postpack: restored original package.json")
