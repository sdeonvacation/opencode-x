import { describeRoute, resolver, validator } from "hono-openapi"
import { Hono } from "hono"
import { proxy } from "hono/proxy"
import type { UpgradeWebSocket } from "hono/ws"
import z from "zod"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import path from "path"
import { Log } from "../util/log"
import { Format } from "../format"
import { TuiRoutes } from "./routes/tui"
import { Instance } from "../project/instance"
import { Vcs } from "../project/vcs"
import { Agent } from "../agent/agent"
import { Skill } from "../skill"
import { Global } from "../global"
import { LSP } from "../lsp"
import { Command } from "../command"
import { Flag } from "../flag/flag"
import { QuestionRoutes } from "./routes/question"
import { PermissionRoutes } from "./routes/permission"
import { Snapshot } from "@/snapshot"
import { ProjectRoutes } from "./routes/project"
import { SessionRoutes } from "./routes/session"
import { MemoryRoutes } from "./routes/memory"
import { PtyRoutes } from "./routes/pty"
import { McpRoutes } from "./routes/mcp"
import { FileRoutes } from "./routes/file"
import { ConfigRoutes } from "./routes/config"
import { ExperimentalRoutes } from "./routes/experimental"
import { ProviderRoutes } from "./routes/provider"
import { EventRoutes } from "./routes/event"
import { errorHandler } from "./middleware"
import { getMimeType } from "hono/utils/mime"

const log = Log.create({ service: "server" })

const embeddedUIPromise = Flag.OPENCODE_DISABLE_EMBEDDED_WEB_UI
  ? Promise.resolve(null)
  : // @ts-expect-error - generated file at build time
    import("opencode-web-ui.gen.ts").then((module) => module.default as Record<string, string>).catch(() => null)

const DEFAULT_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' data:"

const csp = (hash = "") =>
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hash ? ` 'sha256-${hash}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' data:`

export const InstanceRoutes = (upgrade: UpgradeWebSocket, app: Hono = new Hono()) =>
  app
    .onError(errorHandler(log))
    .route("/project", ProjectRoutes())
    .route("/pty", PtyRoutes(upgrade))
    .route("/config", ConfigRoutes())
    .route("/experimental", ExperimentalRoutes())
    .route("/session", SessionRoutes())
    .route("/session", MemoryRoutes())
    .route("/permission", PermissionRoutes())
    .route("/question", QuestionRoutes())
    .route("/provider", ProviderRoutes())
    .route("/", FileRoutes())
    .route("/", EventRoutes())
    .route("/mcp", McpRoutes())
    .route("/tui", TuiRoutes())
    .post(
      "/workflow/create",
      validator("json", z.object({ name: z.string(), description: z.string(), steps: z.array(z.string()) })),
      async (c) => {
        const { name, description, steps } = c.req.valid("json")
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) return c.json({ error: "Invalid name" }, 400)
        const phases = steps.map((s, i) => {
          const phase = i === 0 ? "start" : `step-${i + 1}`
          return `await phase("${phase}")\nawait agent("${s}", {\n  prompt: "Execute ${s} step"\n})`
        })
        const script = [
          "/// meta",
          `/// name: "${name}"`,
          `/// description: "${description}"`,
          `/// max_agents: ${steps.length}`,
          "/// end meta",
          "",
          ...phases.flatMap((p) => [p, ""]),
          `log("info", "${name} complete")`,
          "",
        ].join("\n")
        const dir = path.join(Instance.directory, ".opencode", "workflows")
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(path.join(dir, `${name}.js`), script)
        return c.json({ path: path.join(dir, `${name}.js`) })
      },
    )
    .get("/workflow/scripts", async (c) => {
      const scripts: string[] = []
      const dirs = [path.join(Instance.directory, ".opencode", "workflows"), path.join(Global.Path.config, "workflows")]
      for (const dir of dirs) {
        try {
          const entries = await fs.readdir(dir)
          for (const e of entries) if (e.endsWith(".js")) scripts.push(e.replace(/\.js$/, ""))
        } catch {}
      }
      return c.json([...new Set(scripts)])
    })
    .post(
      "/instance/dispose",
      describeRoute({
        summary: "Dispose instance",
        description: "Clean up and dispose the current OpenCode instance, releasing all resources.",
        operationId: "instance.dispose",
        responses: {
          200: {
            description: "Instance disposed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      async (c) => {
        await Instance.dispose()
        return c.json(true)
      },
    )
    .get(
      "/path",
      describeRoute({
        summary: "Get paths",
        description: "Retrieve the current working directory and related path information for the OpenCode instance.",
        operationId: "path.get",
        responses: {
          200: {
            description: "Path",
            content: {
              "application/json": {
                schema: resolver(
                  z
                    .object({
                      home: z.string(),
                      state: z.string(),
                      config: z.string(),
                      worktree: z.string(),
                      directory: z.string(),
                    })
                    .meta({
                      ref: "Path",
                    }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json({
          home: Global.Path.home,
          state: Global.Path.state,
          config: Global.Path.config,
          worktree: Instance.worktree,
          directory: Instance.directory,
        })
      },
    )
    .get(
      "/vcs",
      describeRoute({
        summary: "Get VCS info",
        description: "Retrieve version control system (VCS) information for the current project, such as git branch.",
        operationId: "vcs.get",
        responses: {
          200: {
            description: "VCS info",
            content: {
              "application/json": {
                schema: resolver(Vcs.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        const [branch, default_branch] = await Promise.all([Vcs.branch(), Vcs.defaultBranch()])
        return c.json({
          branch,
          default_branch,
        })
      },
    )
    .get(
      "/vcs/diff",
      describeRoute({
        summary: "Get VCS diff",
        description: "Retrieve the current git diff for the working tree or against the default branch.",
        operationId: "vcs.diff",
        responses: {
          200: {
            description: "VCS diff",
            content: {
              "application/json": {
                schema: resolver(Vcs.FileDiff.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          mode: Vcs.Mode,
        }),
      ),
      async (c) => {
        return c.json(await Vcs.diff(c.req.valid("query").mode))
      },
    )
    .get(
      "/command",
      describeRoute({
        summary: "List commands",
        description: "Get a list of all available commands in the OpenCode system.",
        operationId: "command.list",
        responses: {
          200: {
            description: "List of commands",
            content: {
              "application/json": {
                schema: resolver(Command.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const commands = await Command.list()
        return c.json(commands)
      },
    )
    .get(
      "/agent",
      describeRoute({
        summary: "List agents",
        description: "Get a list of all available AI agents in the OpenCode system.",
        operationId: "app.agents",
        responses: {
          200: {
            description: "List of agents",
            content: {
              "application/json": {
                schema: resolver(Agent.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const modes = await Agent.list()
        return c.json(modes)
      },
    )
    .get(
      "/skill",
      describeRoute({
        summary: "List skills",
        description: "Get a list of all available skills in the OpenCode system.",
        operationId: "app.skills",
        responses: {
          200: {
            description: "List of skills",
            content: {
              "application/json": {
                schema: resolver(Skill.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const skills = await Skill.all()
        return c.json(skills)
      },
    )
    .get(
      "/lsp",
      describeRoute({
        summary: "Get LSP status",
        description: "Get LSP server status",
        operationId: "lsp.status",
        responses: {
          200: {
            description: "LSP server status",
            content: {
              "application/json": {
                schema: resolver(LSP.Status.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await LSP.status())
      },
    )
    .get(
      "/formatter",
      describeRoute({
        summary: "Get formatter status",
        description: "Get formatter status",
        operationId: "formatter.status",
        responses: {
          200: {
            description: "Formatter status",
            content: {
              "application/json": {
                schema: resolver(Format.Status.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await Format.status())
      },
    )
    .all("/*", async (c) => {
      const embeddedWebUI = await embeddedUIPromise
      const path = c.req.path

      if (embeddedWebUI) {
        const match = embeddedWebUI[path.replace(/^\//, "")] ?? embeddedWebUI["index.html"] ?? null
        if (!match) return c.json({ error: "Not Found" }, 404)

        if (
          await fs.access(match).then(
            () => true,
            () => false,
          )
        ) {
          const mime = getMimeType(match) ?? "text/plain"
          c.header("Content-Type", mime)
          if (mime.startsWith("text/html")) {
            c.header("Content-Security-Policy", DEFAULT_CSP)
          }
          return c.body(new Uint8Array(await fs.readFile(match)))
        } else {
          return c.json({ error: "Not Found" }, 404)
        }
      } else {
        const response = await proxy(`https://app.opencode.ai${path}`, {
          ...c.req,
          headers: {
            ...c.req.raw.headers,
            host: "app.opencode.ai",
          },
        })
        const match = response.headers.get("content-type")?.includes("text/html")
          ? (await response.clone().text()).match(
              /<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(['"])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i,
            )
          : undefined
        const hash = match ? createHash("sha256").update(match[2]).digest("base64") : ""
        response.headers.set("Content-Security-Policy", csp(hash))
        return response
      }
    })
