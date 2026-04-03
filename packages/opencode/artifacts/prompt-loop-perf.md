## Prompt Loop Performance Proxy Report

Source tests: `test/session/prompt-loop-perf.test.ts`

Method: deterministic integration proxies (call counts and persisted update counts), without wall-clock pass/fail thresholds.

| Scenario                                 | Deterministic metric(s)                                                             | Result interpretation                                                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Warm cache avoids redundant full rebuild | `filterCompactedEffect_calls = 1`, `streamAfterEffect_calls = 1`, `llm_calls = 2`   | First step does full load; follow-up step uses delta history path and avoids a second full compacted-history rebuild.   |
| Tool streaming coalesces updates         | `tool_input_delta_chunks = 12`, `persisted_tool_update_calls < 12`, `llm_calls = 2` | Streaming tool-input deltas are coalesced before persistence, proving reduced write pressure proxy vs per-delta writes. |

### Notes

- These are behavior-preserving perf-proxy tests (integration-level), not benchmark/timing tests.
- Metrics are suitable for CI stability because assertions depend on deterministic event/call counts only.
