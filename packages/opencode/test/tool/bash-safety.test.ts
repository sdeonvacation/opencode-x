import { describe, expect, test } from "bun:test"
import { BashSafety } from "../../src/tool/bash-safety"

describe("BashSafety.isReadOnly", () => {
  describe("whitelist hits", () => {
    test("ls with flags", () => {
      expect(BashSafety.isReadOnly("ls -la")).toBe(true)
    })

    test("ls bare", () => {
      expect(BashSafety.isReadOnly("ls")).toBe(true)
    })

    test("cat with filename", () => {
      expect(BashSafety.isReadOnly("cat foo.txt")).toBe(true)
    })

    test("grep recursive", () => {
      expect(BashSafety.isReadOnly("grep -r foo .")).toBe(true)
    })

    test("find with path", () => {
      expect(BashSafety.isReadOnly("find . -name '*.ts'")).toBe(true)
    })

    test("git status", () => {
      expect(BashSafety.isReadOnly("git status")).toBe(true)
    })

    test("git status with flags", () => {
      expect(BashSafety.isReadOnly("git status --short")).toBe(true)
    })

    test("git log with flags", () => {
      expect(BashSafety.isReadOnly("git log -p")).toBe(true)
    })

    test("git log bare", () => {
      expect(BashSafety.isReadOnly("git log")).toBe(true)
    })

    test("git diff", () => {
      expect(BashSafety.isReadOnly("git diff")).toBe(true)
    })

    test("git diff with args", () => {
      expect(BashSafety.isReadOnly("git diff HEAD~1")).toBe(true)
    })

    test("pwd", () => {
      expect(BashSafety.isReadOnly("pwd")).toBe(true)
    })

    test("wc with flag", () => {
      expect(BashSafety.isReadOnly("wc -l")).toBe(true)
    })

    test("wc bare", () => {
      expect(BashSafety.isReadOnly("wc")).toBe(true)
    })
  })

  describe("whitelist misses", () => {
    test("npm test is not read-only", () => {
      expect(BashSafety.isReadOnly("npm test")).toBe(false)
    })

    test("git push is not read-only", () => {
      expect(BashSafety.isReadOnly("git push")).toBe(false)
    })

    test("git commit is not read-only", () => {
      expect(BashSafety.isReadOnly("git commit -m 'msg'")).toBe(false)
    })

    test("rm -rf is not read-only", () => {
      expect(BashSafety.isReadOnly("rm -rf /")).toBe(false)
    })

    test("echo is not read-only", () => {
      expect(BashSafety.isReadOnly("echo hi")).toBe(false)
    })

    test("touch is not read-only", () => {
      expect(BashSafety.isReadOnly("touch file.txt")).toBe(false)
    })

    test("empty string is not read-only", () => {
      expect(BashSafety.isReadOnly("")).toBe(false)
    })

    test("git alone (not matching git status/log/diff prefix) is not read-only", () => {
      expect(BashSafety.isReadOnly("git")).toBe(false)
    })
  })

  describe("command chains are rejected", () => {
    test("ls && rm -rf", () => {
      expect(BashSafety.isReadOnly("ls && rm -rf")).toBe(false)
    })

    test("cat foo | grep bar", () => {
      expect(BashSafety.isReadOnly("cat foo | grep bar")).toBe(false)
    })

    test("pwd; ls", () => {
      expect(BashSafety.isReadOnly("pwd; ls")).toBe(false)
    })

    test("ls || echo fallback", () => {
      expect(BashSafety.isReadOnly("ls || echo fallback")).toBe(false)
    })

    test("grep pattern | wc -l (both whitelisted but piped)", () => {
      expect(BashSafety.isReadOnly("grep pattern | wc -l")).toBe(false)
    })
  })

  describe("leading whitespace is tolerated", () => {
    test("  ls -la with leading spaces", () => {
      expect(BashSafety.isReadOnly("  ls -la")).toBe(true)
    })

    test("\\tcat foo with leading tab", () => {
      expect(BashSafety.isReadOnly("\tcat foo")).toBe(true)
    })

    test("  git status with leading spaces", () => {
      expect(BashSafety.isReadOnly("  git status")).toBe(true)
    })
  })
})
