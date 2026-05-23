import { describe, test, expect, spyOn, afterEach } from "bun:test"
import { Effect } from "effect"
import { Hook } from "../../src/hook/hook"
import { Instance } from "../../src/project/instance"
import * as fs from "fs/promises"
import path from "path"
import os from "os"

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
          hooks: [{ type: "command", command: "sleep 10", timeout: 0.05 }],
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

  describe("load merges project and global claude hooks", () => {
    let home: string
    let project: string
    let spy: ReturnType<typeof spyOn>

    afterEach(async () => {
      spy?.mockRestore()
      if (home) await fs.rm(home, { recursive: true, force: true })
      if (project) await fs.rm(project, { recursive: true, force: true })
    })

    async function setup(opts: { projectHooks?: object; globalHooks?: object; opencodeHooks?: object }) {
      home = path.join(os.tmpdir(), "opencode-hook-test-home-" + Math.random().toString(36).slice(2))
      project = path.join(os.tmpdir(), "opencode-hook-test-proj-" + Math.random().toString(36).slice(2))
      await fs.mkdir(home, { recursive: true })
      await fs.mkdir(project, { recursive: true })

      spy = spyOn(os, "homedir").mockReturnValue(home)

      if (opts.opencodeHooks) {
        const dir = path.join(home, ".config", "opencode")
        await fs.mkdir(dir, { recursive: true })
        await Bun.write(path.join(dir, "hooks.json"), JSON.stringify(opts.opencodeHooks))
      }

      if (opts.projectHooks) {
        const dir = path.join(project, ".claude")
        await fs.mkdir(dir, { recursive: true })
        await Bun.write(path.join(dir, "settings.json"), JSON.stringify({ hooks: opts.projectHooks }))
      }

      if (opts.globalHooks) {
        const dir = path.join(home, ".claude")
        await fs.mkdir(dir, { recursive: true })
        await Bun.write(path.join(dir, "settings.json"), JSON.stringify({ hooks: opts.globalHooks }))
      }
    }

    test("merges project .claude/hooks.json and global ~/.claude/settings.json", async () => {
      await setup({
        projectHooks: {
          PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "echo project" }] }],
        },
        globalHooks: {
          SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "echo global" }] }],
        },
      })

      await Instance.provide({
        directory: project,
        fn: async () => {
          const rules = await Hook.load()
          expect(rules.PostToolUse).toEqual([
            { matcher: "Edit", hooks: [{ type: "command", command: "echo project" }] },
          ])
          expect(rules.SessionStart).toEqual([{ matcher: "", hooks: [{ type: "command", command: "echo global" }] }])
        },
      })
    })

    test("deduplicates identical hooks from multiple sources", async () => {
      const hook = { matcher: "Bash", hooks: [{ type: "command" as const, command: "echo same" }] }
      await setup({
        projectHooks: { PreToolUse: [hook] },
        globalHooks: { PreToolUse: [hook] },
      })

      await Instance.provide({
        directory: project,
        fn: async () => {
          const rules = await Hook.load()
          expect(rules.PreToolUse).toHaveLength(1)
          expect(rules.PreToolUse[0]).toEqual(hook)
        },
      })
    })

    test("keeps distinct hooks from multiple sources", async () => {
      await setup({
        projectHooks: {
          PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "echo a" }] }],
        },
        globalHooks: {
          PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "echo b" }] }],
        },
      })

      await Instance.provide({
        directory: project,
        fn: async () => {
          const rules = await Hook.load()
          expect(rules.PostToolUse).toHaveLength(2)
          expect(rules.PostToolUse[0].matcher).toBe("Edit")
          expect(rules.PostToolUse[1].matcher).toBe("Write")
        },
      })
    })

    test("all three sources merge together", async () => {
      await setup({
        opencodeHooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo opencode" }] }],
        },
        projectHooks: {
          PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "echo project" }] }],
        },
        globalHooks: {
          SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "echo global" }] }],
        },
      })

      await Instance.provide({
        directory: project,
        fn: async () => {
          const rules = await Hook.load()
          expect(rules.PreToolUse).toHaveLength(1)
          expect(rules.PostToolUse).toHaveLength(1)
          expect(rules.SessionStart).toHaveLength(1)
        },
      })
    })

    test("returns empty rules when no hook files exist", async () => {
      await setup({})

      await Instance.provide({
        directory: project,
        fn: async () => {
          const rules = await Hook.load()
          for (const event of Hook.EVENTS) {
            expect(rules[event]).toEqual([])
          }
        },
      })
    })
  })
})
