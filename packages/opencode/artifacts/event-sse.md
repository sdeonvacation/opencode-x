## SSE Event Filtering Performance Proxy Report

Source tests: `test/server/event-sse.test.ts`

Method: deterministic SSE event-count/type assertions under controlled publication patterns.

| Scenario                                |                                                                      Published events |                                              Observed SSE events | Result interpretation                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------: | ---------------------------------------------------------------: | -------------------------------------------------------------------------------------------------- |
| Filtered stream skips irrelevant events | 30 irrelevant `message.part.delta`, 1 `session.status`, 2 matching `permission.asked` | 0 `message.part.delta`, 1 `session.status`, 2 `permission.asked` | Confirms irrelevant events are skipped before delivery while control/matching events pass through. |
| Unfiltered baseline delivers all        |                                          5 `message.part.delta`, 1 `permission.asked` |           5 `message.part.delta`, 1 `permission.asked` (total 6) | Confirms baseline stream behavior without filters for comparison evidence.                         |

### Notes

- Assertions use deterministic event type/count proxies only.
- This report provides integration-level evidence for SSE filter effectiveness without flaky timing checks.
