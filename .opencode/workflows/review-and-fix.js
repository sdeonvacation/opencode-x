/// meta
/// name: "review-and-fix"
/// description: "Review code for issues, then fix them"
/// args: { target: { type: "string", required: true, default: "src/" } }
/// timeout: 120000
/// max_agents: 2
/// end meta

await phase("review")
log("info", "Starting code review of " + args.target)

const result = await agent("reviewer", {
  prompt: "Review " + args.target + " for bugs, security issues, and style violations. List each issue with file:line.",
})

await phase("fix")
log("info", "Applying fixes")

await agent("coder", {
  prompt: "Fix all issues found in the review: " + JSON.stringify(result),
})

await phase("verify")
await agent("tester", {
  prompt: "Run tests to verify the fixes didn't break anything",
})

log("info", "Review-and-fix complete")
