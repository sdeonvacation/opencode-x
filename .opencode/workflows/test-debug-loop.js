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
      prompt: "IMPORTANT: You MUST make actual code changes to fix this problem. Do NOT just report findings — edit files.\n\nThe test runner failed with this error:\n\n" + testResult.error + "\n\nRead the relevant source files, identify the root cause, and use your edit/write tools to fix the code. Verify your fix compiles."
    })
  } else if (testResult.result.startsWith("SUITE_GREEN")) {
    passing = true
    log("info", "All tests are passing after " + attempt + " attempt(s)!")
  } else {
    log("warn", "Tests failing on attempt " + attempt + ". Invoking debugger to fix issues.")
    phase("debug-attempt-" + attempt)
    agent("debugger", {
      prompt: "IMPORTANT: You MUST make actual code changes to fix these failures. Do NOT just analyze or report — edit files.\n\nThe test suite has failures. Here is the output:\n\n" + testResult.result + "\n\nPick the highest-impact failures first (most common root cause), read the source files, and use your edit/write tools to fix the code. Do not modify test files unless they are clearly wrong. Verify your fixes compile with typecheck."
    })
  }
}

if (!passing) {
  log("error", "Tests are still failing after " + MAX_ATTEMPTS + " attempts. Manual intervention may be required.")
}