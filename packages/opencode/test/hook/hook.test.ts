import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { Hook } from "../../src/hook/hook"

// Hook.dispatch returns Effect with inferred R; cast for test usage
const run = <A>(eff: Effect.Effect<A, any, any>) => Effect.runPromise(eff as Effect.Effect<A, any, never>)

describe("Hook", () => {
  describe("matches (via dispatch)", () => {
    const rules: Hook.Rules = {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "exit 0" }] }],
      PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "exit 0" }] }],
      PostToolUseFailure: [],
      Notification: [],
      Stop: [],
      SessionStart: [],
      UserPromptSubmit: [],
      SubagentStart: [],
      SubagentStop: [],
    }

    test("exact match triggers hook", async () => {
      const result = await run(Hook.dispatch("PreToolUse", { tool: "Bash" }, rules))
      expect(result).toEqual({ allowed: true, output: [] })
    })

    test("wildcard matches any tool", async () => {
      const result = await run(Hook.dispatch("PostToolUse", { tool: "Read" }, rules))
      expect(result).toEqual({ allowed: true, output: [] })
    })

    test("no match skips hooks", async () => {
      const result = await run(Hook.dispatch("PreToolUse", { tool: "Read" }, rules))
      expect(result).toEqual({ allowed: true, output: [] })
    })
  })

  describe("PreToolUse denial", () => {
    const rules: Hook.Rules = {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo denied >&2; exit 1" }] }],
      PostToolUse: [],
      PostToolUseFailure: [],
      Notification: [],
      Stop: [],
      SessionStart: [],
      UserPromptSubmit: [],
      SubagentStart: [],
      SubagentStop: [],
    }

    test("non-zero exit denies tool", async () => {
      const result = await Effect.runPromiseExit(Hook.dispatch("PreToolUse", { tool: "Bash" }, rules) as any)
      expect(result._tag).toBe("Failure")
    })

    test("non-matching tool is allowed", async () => {
      const result = await run(Hook.dispatch("PreToolUse", { tool: "Read" }, rules))
      expect(result).toEqual({ allowed: true, output: [] })
    })
  })

  describe("PostToolUse non-blocking", () => {
    const rules: Hook.Rules = {
      PreToolUse: [],
      PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "exit 1" }] }],
      PostToolUseFailure: [],
      Notification: [],
      Stop: [],
      SessionStart: [],
      UserPromptSubmit: [],
      SubagentStart: [],
      SubagentStop: [],
    }

    test("non-zero exit does not fail for PostToolUse", async () => {
      const result = await run(Hook.dispatch("PostToolUse", { tool: "Bash" }, rules))
      expect(result).toEqual({ allowed: true, output: [] })
    })
  })

  describe("env vars", () => {
    const rules: Hook.Rules = {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: 'echo "$CLAUDE_TOOL_NAME|$CLAUDE_TOOL_INPUT|$CLAUDE_SESSION_ID|$CLAUDE_MODEL"',
            },
          ],
        },
      ],
      PostToolUse: [],
      PostToolUseFailure: [],
      Notification: [],
      Stop: [],
      SessionStart: [],
      UserPromptSubmit: [],
      SubagentStart: [],
      SubagentStop: [],
    }

    test("passes env vars to hook command", async () => {
      const result = await run(
        Hook.dispatch(
          "PreToolUse",
          {
            tool: "Bash",
            input: { command: "ls" },
            sessionID: "sess-123",
            model: "claude-4",
          },
          rules,
        ),
      )
      expect(result.allowed).toBe(true)
      expect(result.output.length).toBe(1)
      expect(result.output[0]).toContain("Bash")
    })
  })

  describe("stdin payload", () => {
    const rules: Hook.Rules = {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: "cat" }],
        },
      ],
      PostToolUse: [],
      PostToolUseFailure: [],
      Notification: [],
      Stop: [],
      SessionStart: [],
      UserPromptSubmit: [],
      SubagentStart: [],
      SubagentStop: [],
    }

    test("passes JSON payload on stdin", async () => {
      const result = await run(Hook.dispatch("PreToolUse", { tool: "Bash", input: { x: 1 } }, rules))
      expect(result.allowed).toBe(true)
      expect(result.output.length).toBe(1)
      expect(result.output[0]).toContain("Bash")
    })
  })

  describe("config override", () => {
    const rules: Hook.Rules = {
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "exit 1" }] }],
      PostToolUse: [],
      PostToolUseFailure: [],
      Notification: [],
      Stop: [],
      SessionStart: [],
      UserPromptSubmit: [],
      SubagentStart: [],
      SubagentStop: [],
    }

    test("cfg.hooks overrides loaded rules", async () => {
      const cfg = {
        hooks: {
          PreToolUse: [{ matcher: "*", hooks: [{ type: "command" as const, command: "exit 0" }] }],
        },
      }
      const result = await run(Hook.dispatch("PreToolUse", { tool: "Bash" }, rules, cfg))
      expect(result).toEqual({ allowed: true, output: [] })
    })
  })

  describe("glob patterns", () => {
    const rules: Hook.Rules = {
      PreToolUse: [{ matcher: "Bash*", hooks: [{ type: "command", command: "exit 0" }] }],
      PostToolUse: [{ matcher: "Read?", hooks: [{ type: "command", command: "exit 0" }] }],
      PostToolUseFailure: [],
      Notification: [],
      Stop: [],
      SessionStart: [],
      UserPromptSubmit: [],
      SubagentStart: [],
      SubagentStop: [],
    }

    test("star glob matches prefix", async () => {
      const result = await run(Hook.dispatch("PreToolUse", { tool: "BashTool" }, rules))
      expect(result).toEqual({ allowed: true, output: [] })
    })

    test("question mark matches single char", async () => {
      const result = await run(Hook.dispatch("PostToolUse", { tool: "ReadX" }, rules))
      expect(result).toEqual({ allowed: true, output: [] })
    })

    test("question mark does not match multiple chars", async () => {
      // "Read?" should not match "ReadXY"
      const result = await run(Hook.dispatch("PostToolUse", { tool: "ReadXY" }, rules))
      expect(result).toEqual({ allowed: true, output: [] })
    })
  })

  describe("timeout", () => {
    const rules: Hook.Rules = {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: "sleep 10", timeout: 100 }],
        },
      ],
      PostToolUse: [],
      PostToolUseFailure: [],
      Notification: [],
      Stop: [],
      SessionStart: [],
      UserPromptSubmit: [],
      SubagentStart: [],
      SubagentStop: [],
    }

    test("kills process after timeout and denies for PreToolUse", async () => {
      const result = await Effect.runPromiseExit(Hook.dispatch("PreToolUse", { tool: "Bash" }, rules) as any)
      expect(result._tag).toBe("Failure")
    })
  })

  describe("multiple hooks in rule", () => {
    const rules: Hook.Rules = {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            { type: "command", command: "exit 0" },
            { type: "command", command: "exit 0" },
          ],
        },
      ],
      PostToolUse: [],
      PostToolUseFailure: [],
      Notification: [],
      Stop: [],
      SessionStart: [],
      UserPromptSubmit: [],
      SubagentStart: [],
      SubagentStop: [],
    }

    test("runs all hooks in sequence", async () => {
      const result = await run(Hook.dispatch("PreToolUse", { tool: "Bash" }, rules))
      expect(result).toEqual({ allowed: true, output: [] })
    })
  })

  describe("empty tool name", () => {
    const rules: Hook.Rules = {
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "exit 0" }] }],
      PostToolUse: [],
      PostToolUseFailure: [],
      Notification: [],
      Stop: [],
      SessionStart: [],
      UserPromptSubmit: [],
      SubagentStart: [],
      SubagentStop: [],
    }

    test("wildcard matches empty tool", async () => {
      const result = await run(Hook.dispatch("PreToolUse", {}, rules))
      expect(result).toEqual({ allowed: true, output: [] })
    })
  })
})
