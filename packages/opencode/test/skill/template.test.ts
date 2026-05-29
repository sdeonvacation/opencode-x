import { test, expect, describe } from "bun:test"
import { applyArgs } from "../../src/skill/template"

describe("applyArgs", () => {
  test("empty args returns template unchanged when no placeholders", () => {
    expect(applyArgs("hello world", "")).toBe("hello world")
  })

  test("empty args replaces placeholders with empty string", () => {
    expect(applyArgs("a $1 b", "")).toBe("a  b")
  })

  test("substitutes single $1", () => {
    expect(applyArgs("issue: $1", "BUG-123")).toBe("issue: BUG-123")
  })

  test("$1 + $2 with three args, last absorbs remaining", () => {
    expect(applyArgs("a=$1 b=$2", "one two three")).toBe("a=one b=two three")
  })

  test("$ARGUMENTS replaced with full original string", () => {
    expect(applyArgs("full: $ARGUMENTS", "one two three")).toBe("full: one two three")
  })

  test("no placeholders + non-empty args appends with double newline", () => {
    expect(applyArgs("base prompt", "extra")).toBe("base prompt\n\nextra")
  })

  test("quoted args have surrounding quotes stripped", () => {
    expect(applyArgs("a=$1 b=$2", '"hello world" foo')).toBe("a=hello world b=foo")
  })

  test("preserves trailing newlines (caller is responsible for trim)", () => {
    expect(applyArgs("hello\n\n", "")).toBe("hello\n\n")
  })

  test("numbered placeholder beyond args becomes empty", () => {
    expect(applyArgs("a=$1 b=$2", "only")).toBe("a=only b=")
  })

  test("$ARGUMENTS combined with $1 (last placeholder absorbs)", () => {
    expect(applyArgs("first=$1 all=$ARGUMENTS", "a b c")).toBe("first=a b c all=a b c")
  })
})
