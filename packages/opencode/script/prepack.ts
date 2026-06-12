#!/usr/bin/env bun
/**
 * Strips package.json to a minimal publish-safe version.
 * Removes all dependencies, devDependencies, overrides, imports, exports
 * so `npm install` of the published package installs zero deps.
 * The actual binary is downloaded by postinstall.cjs from GitHub releases.
 */
import { resolve } from "path"

const dir = resolve(import.meta.dirname, "..")
const path = resolve(dir, "package.json")
const backup = resolve(dir, "package.json.bak")

const raw = await Bun.file(path).text()
await Bun.file(backup).write(raw)

const pkg = JSON.parse(raw)

const minimal = {
  name: pkg.name,
  version: pkg.version,
  license: pkg.license,
  description: pkg.description,
  repository: pkg.repository,
  publishConfig: pkg.publishConfig,
  bin: pkg.bin,
  files: pkg.files,
  scripts: {
    postinstall: pkg.scripts.postinstall,
  },
}

await Bun.file(path).write(JSON.stringify(minimal, null, 2) + "\n")
console.log("prepack: wrote minimal package.json for publish")
