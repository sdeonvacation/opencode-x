/// meta
/// name: "implement"
/// description: "Implements a feature from the provided plan and design using swarm + parallelisation using coder agents. Then runs builder + tester. Then runs engineering manager review"
/// max_agents: 5
/// end meta

await phase("start")
await agent("coder", {
  prompt: "Execute coder step"
})

await phase("step-2")
await agent("builder", {
  prompt: "Execute builder step"
})

await phase("step-3")
await agent("tester", {
  prompt: "Execute tester step"
})

await phase("step-4")
await agent("debugger", {
  prompt: "Execute debugger step"
})

await phase("step-5")
await agent("reviewer", {
  prompt: "Execute reviewer step"
})

log("info", "implement complete")
