import { describe, expect, test } from "bun:test"
import { classify } from "../../src/orchestration/hybrid-heuristics"

describe("orchestration/hybrid-heuristics", () => {
  test("npm install → bash_complex", () => {
    expect(classify("npm install")).toBe("bash_complex")
  })

  test("docker build . → bash_complex", () => {
    expect(classify("docker build .")).toBe("bash_complex")
  })

  test("bun run test → bash_complex (bun keyword)", () => {
    expect(classify("bun run test")).toBe("bash_complex")
  })

  test("yarn add lodash → bash_complex", () => {
    expect(classify("yarn add lodash")).toBe("bash_complex")
  })

  test("pnpm install → bash_complex", () => {
    expect(classify("pnpm install")).toBe("bash_complex")
  })

  test("gradle build → bash_complex", () => {
    expect(classify("gradle build")).toBe("bash_complex")
  })

  test("mvn package → bash_complex", () => {
    expect(classify("mvn package")).toBe("bash_complex")
  })

  test("deploy to production → bash_complex", () => {
    expect(classify("deploy to production")).toBe("bash_complex")
  })

  test("echo hello → bash_simple", () => {
    expect(classify("echo hello")).toBe("bash_simple")
  })

  test("pwd → bash_simple", () => {
    expect(classify("pwd")).toBe("bash_simple")
  })

  test("whoami → bash_simple", () => {
    expect(classify("whoami")).toBe("bash_simple")
  })

  test("env → bash_simple", () => {
    expect(classify("env")).toBe("bash_simple")
  })

  test("git status → undefined (neither pattern)", () => {
    expect(classify("git status")).toBeUndefined()
  })

  test("ls -la → undefined", () => {
    expect(classify("ls -la")).toBeUndefined()
  })

  test("complex pattern wins over simple (no downgrade)", () => {
    // If a command matches complex, it should never return bash_simple
    expect(classify("npm test")).toBe("bash_complex")
    expect(classify("bun test")).toBe("bash_complex")
  })

  test("case-insensitive matching for complex", () => {
    expect(classify("NPM install")).toBe("bash_complex")
    expect(classify("Docker build")).toBe("bash_complex")
  })

  test("case-insensitive matching for simple", () => {
    expect(classify("ECHO hello")).toBe("bash_simple")
    expect(classify("PWD")).toBe("bash_simple")
  })

  test("word boundary: 'tester' does not match 'test'", () => {
    // 'tester' contains 'test' but not at word boundary
    // The regex uses \b so 'tester' should not match
    // Actually 'test' in 'tester' - \b is between 't' and 'e' at start, but 'test' ends before 'er'
    // 'tester' → 'test' followed by 'er' - the \b after 'test' would be between 't' and 'e' in 'er'
    // Actually \b matches between word char and non-word char. 'tester': t-e-s-t-e-r, no boundary after 'test'
    // So 'tester' should NOT match /test\b/
    expect(classify("run tester")).toBeUndefined()
  })
})
