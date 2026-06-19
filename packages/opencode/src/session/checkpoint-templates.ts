export const CHECKPOINT_TEMPLATE = `## Current Task
<!-- What is being worked on, goal, acceptance criteria -->

## Key Decisions
<!-- Architecture/design decisions made, with rationale -->
-

## File Changes
<!-- Files created/modified/deleted with brief description -->
-

## Open Issues
<!-- Unresolved problems, blockers, questions -->
-

## Progress Summary
<!-- What was accomplished, what remains -->
`

export const MEMORY_TEMPLATE = `## Project Facts
<!-- Discovered codebase facts worth remembering across sessions -->
-

## Conventions
<!-- Coding patterns, naming, structure conventions observed -->
-

## Gotchas
<!-- Non-obvious behaviors, pitfalls, workarounds -->
-
`

export const NOTES_TEMPLATE = `## Session Notes
<!-- Freeform observations during this session -->
-

## Blockers
<!-- Issues preventing progress -->
-
`

export const CHECKPOINT_SECTION_BUDGETS: Record<string, number> = {
  task: 2000,
  decisions: 1500,
  changes: 3000,
  issues: 1000,
  progress: 1500,
}

export const MEMORY_SECTION_BUDGETS: Record<string, number> = {
  facts: 2000,
  conventions: 1500,
  gotchas: 1000,
}
