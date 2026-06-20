/// meta
/// name: "test-debug-loop"
/// description: "Run full test suite repeatedly, using debugger to fix failures until all tests pass"
/// max_agents: 10
/// end meta

const MAX_ATTEMPTS = 5
let attempt = 0
let passing = false

while (!passing && attempt < MAX_ATTEMPTS) {
  attempt++
  phase("test-attempt-" + attempt)
  
  const testResult = agent("tester", {
    prompt: "Run the full test suite for this project. Report all test results clearly. For any failures, include the full error messages, stack traces, and the names of the failing tests. If ALL tests pass with ZERO failures, your response MUST start with the exact string 'SUITE_GREEN'. If any test fails, your response MUST start with the exact string 'SUITE_RED' followed by the failure details."
  })

  if (testResult.error) {
    log("error", "Tester agent encountered an error: " + testResult.error)
    phase("debug-attempt-" + attempt)
    agent("debugger", {
      prompt: "The test suite has failures. Here is the output:\n\n" + testResult.result + "\n\n Fix the failing tests. Decide carefully on whether the test is incorrect or there is a genuine production bug. Verify your fixes compile with typecheck."
    })
  } else if (testResult.result.startsWith("SUITE_GREEN")) {
    passing = true
    log("info", "All tests are passing after " + attempt + " attempt(s)!")
  } else {
    log("warn", "Tests failing on attempt " + attempt + ". Invoking debugger to fix issues.")
    phase("debug-attempt-" + attempt)
    agent("debugger", {
      prompt: "The test suite has failures. Here is the output:\n\n" + testResult.result + "\n\n Fix the failing tests. Decide carefully on whether the test is incorrect or there is a genuine production bug. Verify your fixes compile with typecheck."
    })
  }
}

if (!passing) {
  log("error", "Tests are still failing after " + MAX_ATTEMPTS + " attempts. Manual intervention may be required.")
}