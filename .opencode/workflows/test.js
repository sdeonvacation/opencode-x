/// meta
/// name: "test"
/// description: "run full test suite"
/// max_agents: 1
/// end meta

await phase("start")
await agent("tester", {
  prompt: "Execute tester step"
})

log("info", "test complete")
