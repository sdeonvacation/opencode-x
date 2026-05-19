import { describe, expect, test } from "bun:test"
import { Permission } from "../../src/permission"

describe("batch permissions pre-approval", () => {
  test("evaluate returns allow for tool with wildcard allow rule", () => {
    const merged = Permission.merge([{ permission: "bash", pattern: "*", action: "allow" as const }])
    const rule = Permission.evaluate("bash", "*", merged)
    expect(rule.action).toBe("allow")
  })

  test("evaluate returns ask when no rules match", () => {
    const merged = Permission.merge([])
    const rule = Permission.evaluate("bash", "*", merged)
    expect(rule.action).toBe("ask")
  })

  test("evaluate returns deny for explicitly denied tool", () => {
    const merged = Permission.merge([{ permission: "bash", pattern: "*", action: "deny" as const }])
    const rule = Permission.evaluate("bash", "*", merged)
    expect(rule.action).toBe("deny")
  })

  test("merge combines agent and session rulesets", () => {
    const agent: Permission.Ruleset = [{ permission: "read", pattern: "*", action: "allow" }]
    const session: Permission.Ruleset = [{ permission: "bash", pattern: "*", action: "deny" }]
    const merged = Permission.merge(agent, session)
    expect(Permission.evaluate("read", "*", merged).action).toBe("allow")
    expect(Permission.evaluate("bash", "*", merged).action).toBe("deny")
    expect(Permission.evaluate("edit", "*", merged).action).toBe("ask")
  })

  test("last rule wins for same permission", () => {
    const merged = Permission.merge([
      { permission: "bash", pattern: "*", action: "deny" as const },
      { permission: "bash", pattern: "*", action: "allow" as const },
    ])
    expect(Permission.evaluate("bash", "*", merged).action).toBe("allow")
  })

  test("pre-approved set correctly populated for allowed tools", () => {
    const rules: Permission.Ruleset = [
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "edit", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "task", pattern: "*", action: "ask" },
    ]
    const merged = Permission.merge(rules)
    const approved = new Set<string>()
    const ids = ["read", "edit", "bash", "task", "webfetch"]
    for (const id of ids) {
      if (Permission.evaluate(id, "*", merged).action === "allow") {
        approved.add(id)
      }
    }
    expect(approved.has("read")).toBe(true)
    expect(approved.has("edit")).toBe(true)
    expect(approved.has("bash")).toBe(false)
    expect(approved.has("task")).toBe(false)
    expect(approved.has("webfetch")).toBe(false)
  })

  test("ask callback skips when tool is pre-approved", async () => {
    const approved = new Set(["read", "edit"])
    const batch = true
    let called = false
    const ask = (req: { permission: string }) => {
      if (batch && approved.has(req.permission)) return Promise.resolve()
      called = true
      return Promise.resolve()
    }
    await ask({ permission: "read" })
    expect(called).toBe(false)
    await ask({ permission: "bash" })
    expect(called).toBe(true)
  })

  test("ask callback always calls through when batch is false", async () => {
    const approved = new Set(["read"])
    const batch = false
    let count = 0
    const ask = (req: { permission: string }) => {
      if (batch && approved.has(req.permission)) return Promise.resolve()
      count++
      return Promise.resolve()
    }
    await ask({ permission: "read" })
    await ask({ permission: "bash" })
    expect(count).toBe(2)
  })

  test("wildcard permission rule approves all tools", () => {
    const merged = Permission.merge([{ permission: "*", pattern: "*", action: "allow" as const }])
    const ids = ["read", "edit", "bash", "task", "webfetch", "mcp_custom"]
    const approved = new Set<string>()
    for (const id of ids) {
      if (Permission.evaluate(id, "*", merged).action === "allow") {
        approved.add(id)
      }
    }
    expect(approved.size).toBe(ids.length)
  })

  test("mcp tool key evaluated same as regular tool", () => {
    const merged = Permission.merge([
      { permission: "mcp__server__tool", pattern: "*", action: "allow" as const },
      { permission: "bash", pattern: "*", action: "deny" as const },
    ])
    expect(Permission.evaluate("mcp__server__tool", "*", merged).action).toBe("allow")
    expect(Permission.evaluate("bash", "*", merged).action).toBe("deny")
  })
})
