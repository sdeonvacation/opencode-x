# Requirement: Spinner Verbs and Reliable Image Paste

## Summary

Adopt two low-risk Claude-inspired improvements in opencode: clearer spinner/tool activity wording in the TUI, and image paste behavior that works reliably by default across supported environments. The work must stay additive, rebase-safe, and focused on display/input handling rather than deep session or provider architecture changes.

## Goals

- Improve perceived responsiveness and clarity during tool execution.
- Make image paste work reliably by default for common user flows.
- Prefer UI/input-layer hardening over core execution-path redesign.
- Minimize merge conflicts with upstream opencode by isolating logic in new helper files and keeping edits to hot files small.

## In Scope

### R1: Spinner Verb Assets

Add shared spinner verb assets/constants for TUI busy states.

- Provide a reusable list of present-continuous activity verbs.
- Keep the asset additive and isolated in a new file.
- Initial version does not require user customization.

### R2: Global Busy Spinner Text

Improve the global busy spinner so it can show lightweight activity wording.

- Must remain compatible with the existing spinner component.
- Should prefer additive display wiring only.
- Must not require changes to core session execution semantics.

### R3: Per-Tool Activity Wording

Improve per-tool pending labels with clearer present-continuous activity text.

- Prefer existing runtime titles where already available.
- Avoid redesigning tool contracts in the first pass.
- Keep scope to display wording and existing metadata/title surfaces.

### R4: Reliable Default Image Paste

Make image paste reliably work by default for supported environments.

- Support clipboard-image paste where the environment allows direct image extraction.
- Support pasted file paths to images as a reliable fallback path.
- Improve detection and normalization so common user paste flows succeed more often.
- Do not require manual feature flags for basic image paste support.

### R5: Image Paste Diagnostics and Fallback Behavior

Improve resilience and clarity when direct clipboard image extraction fails.

- Detect and handle empty or unsupported clipboard/image payloads more gracefully.
- Preserve normal text paste behavior when image extraction is not available.
- Make it easier for users to fall back to image file path paste when direct clipboard image paste is unsupported.

## Constraints

- Prefer new files over edits to hot files such as `session/prompt.ts`, `session/processor.ts`, or provider/model execution code.
- Avoid database schema changes.
- Avoid new native dependencies in the first phase.
- Keep changes focused on TUI display, clipboard handling, and prompt attachment input paths.
- Keep image support improvements additive to the existing attachment pipeline rather than redesigning the pipeline.

## Out of Scope

- True terminal image rendering.
- Streaming tool execution changes.
- Provider multimodal architecture redesign.
- Persistent memory system.
- Lifecycle hooks system.
- Major permission-system changes.
- Large-scale todo/tool schema redesign.
