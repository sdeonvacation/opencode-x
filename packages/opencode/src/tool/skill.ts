import path from "path"
import { pathToFileURL } from "url"
import z from "zod"
import { Tool } from "./tool"
import { Skill } from "../skill"
import { applyArgs } from "../skill/template"
import { Ripgrep } from "../file/ripgrep"
import { iife } from "@/util/iife"
import DESCRIPTION from "./skill.txt"

const Parameters = z.object({
  name: z.string().describe("The name of the skill from available_skills"),
  args: z.string().optional().describe("Optional arguments forwarded as $1..$N or $ARGUMENTS within the skill content"),
})

export const SkillTool = Tool.define("skill", async () => {
  return {
    description: DESCRIPTION,
    parameters: Parameters,
    async execute(params: z.infer<typeof Parameters>, ctx) {
      const skill = await Skill.get(params.name)
      const denied = skill?.disableModelInvocation === true

      if (!skill || denied) {
        const list = await Skill.modelInvocable().then((x) => x.map((s) => s.name).join(", "))
        const reason = denied ? "is not available for model invocation" : "not found"
        throw new Error(`Skill "${params.name}" ${reason}. Available skills: ${list || "none"}`)
      }

      await ctx.ask({
        permission: "skill",
        patterns: [params.name],
        always: [params.name],
        metadata: {},
      })

      const dir = path.dirname(skill.location)
      const base = pathToFileURL(dir).href

      const limit = 10
      const files = await iife(async () => {
        const arr = []
        for await (const file of Ripgrep.files({
          cwd: dir,
          follow: false,
          hidden: true,
          signal: ctx.abort,
        })) {
          if (file.includes("SKILL.md")) {
            continue
          }
          arr.push(path.resolve(dir, file))
          if (arr.length >= limit) {
            break
          }
        }
        return arr
      }).then((f) => f.map((file) => `<file>${file}</file>`).join("\n"))

      const content = applyArgs(skill.content, params.args ?? "")

      return {
        title: `Loaded skill: ${skill.name}`,
        output: [
          `<skill_content name="${skill.name}">`,
          `# Skill: ${skill.name}`,
          "",
          content.trim(),
          "",
          `Base directory for this skill: ${base}`,
          "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
          "Note: file list is sampled.",
          "",
          "<skill_files>",
          files,
          "</skill_files>",
          "</skill_content>",
        ].join("\n"),
        metadata: {
          name: skill.name,
          dir,
        },
      }
    },
  }
})
