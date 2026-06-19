import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import path from "path"
import { gitDiff, gitApply } from "../../src/orchestration/patch"
import { tmpdir } from "../fixture/fixture"

describe("orchestration/patch", () => {
  describe("gitDiff", () => {
    test("returns empty string when no changes", async () => {
      await using tmp = await tmpdir({ git: true })
      const diff = await gitDiff(tmp.path)
      expect(diff.trim()).toBe("")
    })

    test("returns diff for modified tracked file", async () => {
      await using tmp = await tmpdir({ git: true })
      const file = path.join(tmp.path, "file.txt")
      await Bun.write(file, "original")
      await $`git add . && git commit -m "init"`.cwd(tmp.path).quiet()

      await Bun.write(file, "modified")
      const diff = await gitDiff(tmp.path)

      expect(diff).toContain("file.txt")
      expect(diff).toContain("modified")
    })

    test("includes untracked files via stage", async () => {
      await using tmp = await tmpdir({ git: true })
      await Bun.write(path.join(tmp.path, "new.txt"), "brand new")

      const diff = await gitDiff(tmp.path)
      expect(diff).toContain("new.txt")
      expect(diff).toContain("brand new")
    })

    test("produces binary diff format", async () => {
      await using tmp = await tmpdir({ git: true })
      await Bun.write(path.join(tmp.path, "a.txt"), "hello")

      const diff = await gitDiff(tmp.path)
      // --binary flag used, diff is staged against HEAD
      expect(diff).toContain("diff --git")
    })
  })

  describe("gitApply", () => {
    test("applies valid patch successfully", async () => {
      await using tmp = await tmpdir({ git: true })
      const file = path.join(tmp.path, "target.txt")
      await Bun.write(file, "before")
      await $`git add . && git commit -m "init"`.cwd(tmp.path).quiet()

      // Generate a patch by modifying and diffing
      await Bun.write(file, "after")
      const diff = await gitDiff(tmp.path)

      // Reset to original state
      await $`git checkout -- .`.cwd(tmp.path).quiet()

      const result = await gitApply(diff, tmp.path)
      expect(result.success).toBe(true)
      expect(result.error).toBe("")

      const content = await Bun.file(file).text()
      expect(content).toBe("after")
    })

    test("returns failure for invalid patch", async () => {
      await using tmp = await tmpdir({ git: true })
      const result = await gitApply("not a valid patch", tmp.path)
      expect(result.success).toBe(false)
      expect(result.error).not.toBe("")
    })

    test("returns failure with stderr message", async () => {
      await using tmp = await tmpdir({ git: true })
      const bogus = `diff --git a/missing.txt b/missing.txt
index 0000000..1234567 100644
--- a/missing.txt
+++ b/missing.txt
@@ -1 +1 @@
-old content
+new content
`
      const result = await gitApply(bogus, tmp.path)
      expect(result.success).toBe(false)
      expect(result.error.length).toBeGreaterThan(0)
    })
  })
})
