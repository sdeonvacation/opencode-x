import { generateText, wrapLanguageModel } from "ai"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { Log } from "@/util/log"

const log = Log.create({ service: "workflow.generate" })

function buildSystem(agents: Agent.Info[]) {
  const agentList = agents
    .filter((a) => a.mode !== "primary")
    .map((a) => `- \`${a.name}\` — ${a.description ?? a.name}`)
    .join("\n")

  return `You are a workflow script generator. You produce JavaScript workflow scripts that run in a deterministic QuickJS sandbox.

## Available API

- \`phase(name)\` — Marks a named phase (for visual grouping in the UI)
- \`log(level, message)\` — Logs a message. Level: "info", "warn", "error"
- \`bash(command)\` — Runs a shell command. Returns \`{ exitCode, stdout, stderr }\`
- \`agent(name, { prompt })\` — Calls an AI agent. Returns \`{ result }\` or \`{ error }\`
- \`readFile(path)\` — Reads a file, returns content string
- \`writeFile(path, content)\` — Writes content to a file
- \`exists(path)\` — Returns boolean
- \`glob(pattern)\` — Returns array of matching file paths
- \`args\` — Object containing runtime arguments passed to the workflow

## Available Agents

${agentList}

## Rules

1. Do NOT use \`await\` — the sandbox handles async transparently via asyncify
2. Use \`phase()\` to group logical steps
3. PREFER \`agent()\` over \`bash()\` for any task an agent can handle (testing, debugging, coding, reviewing)
4. Only use \`bash()\` for simple utility commands (mkdir, cp, git status). NEVER use bash for running tests or fixing code — use the tester and debugger agents instead
5. Use loops (\`while\`/\`for\`) for retry patterns (always with a max iteration guard)
6. Return values from \`bash()\` have \`.exitCode\`, \`.stdout\`, \`.stderr\`
7. Return values from \`agent()\` have \`.result\` (string) or \`.error\` (string)
8. Keep prompts to agents detailed and specific — include context from previous steps
9. Always include a max iteration guard on loops (typically 3-5 iterations)
10. When the user mentions specific agents (tester, debugger, coder, etc.), USE those agents — do not replace them with bash commands

## Meta Block Format (CRITICAL)

Every script MUST start with a meta block. Every line in the meta block MUST start with \`/// \` (three slashes + space). Example:

\`\`\`
/// meta
/// name: "my-workflow"
/// description: "What this workflow does"
/// max_agents: 3
/// end meta
\`\`\`

## Complete Example

\`\`\`
/// meta
/// name: "test-fix"
/// description: "Run tests, fix failures, retry"
/// max_agents: 3
/// end meta

const MAX = 5
let attempt = 0
let passing = false

while (!passing && attempt < MAX) {
  attempt++
  phase("test-" + attempt)
  const result = agent("tester", {
    prompt: "Run the test suite. Report which tests pass and which fail with their error messages."
  })

  if (!result.error && result.result.includes("all pass")) {
    passing = true
    log("info", "All tests pass after attempt " + attempt)
  } else {
    phase("fix-" + attempt)
    agent("debugger", {
      prompt: "Tests are failing. Fix the failures based on this test output:\\n\\n" + (result.result || result.error)
    })
  }
}

if (!passing) {
  log("error", "Still failing after " + MAX + " attempts")
}
\`\`\`

## Output Format

Output ONLY the JavaScript code. No markdown fences, no explanation.
Start with the /// meta block, then the script body.`
}

export namespace WorkflowGenerate {
  export async function generate(name: string, prompt: string): Promise<string> {
    const fallback = await Provider.defaultModel()
    const model = await Provider.getModel(fallback.providerID, fallback.modelID).catch(() => undefined)
    if (!model) throw new Error("No model available for workflow generation")

    const agents = await Agent.list()
    const language = await Provider.getLanguage(model)

    log.info("generating", { name, model: `${model.providerID}/${model.id}` })

    const response = await generateText({
      model: wrapLanguageModel({ model: language, middleware: [] }),
      system: buildSystem(agents),
      messages: [
        {
          role: "user",
          content: `Generate a workflow script named "${name}" that does the following:\n\n${prompt}`,
        },
      ],
      maxOutputTokens: 4096,
      temperature: 0,
    })

    let script = response.text.trim()
    // Strip markdown fences if model wraps output in them
    if (script.startsWith("```")) {
      script = script.replace(/^```(?:javascript|js)?\n/, "").replace(/\n```$/, "")
    }

    // Ensure meta block exists
    if (!script.startsWith("/// meta")) {
      const desc = prompt.length > 100 ? prompt.slice(0, 97) + "..." : prompt
      script = [
        "/// meta",
        `/// name: "${name}"`,
        `/// description: "${desc}"`,
        "/// max_agents: 5",
        "/// end meta",
        "",
        script,
      ].join("\n")
    }

    log.info("generated", { name, lines: script.split("\n").length })
    return script
  }
}
