# Plan: Spinner Verbs and Reliable Image Paste

## Overview

Adopt two low-risk Claude-inspired improvements in opencode: better spinner/tool activity wording and more reliable default image paste behavior. The plan prioritizes additive helper modules and thin TUI input/display changes that avoid deep changes to the session loop, provider flow, and persistence model.

## Tech Stack

- TypeScript 5.8.2 + Bun 1.3.11
- Existing TUI component structure
- Existing clipboard utility and prompt attachment flow
- Existing file/path paste handling
- Existing tool runtime title metadata where available

## Testing Strategy

- Unit: Spinner verb helpers, clipboard/image detection helpers, and image-paste normalization paths
- Integration: TUI prompt paste flows for clipboard image, pasted image file path, and text fallback behavior
- Done when: Spinner wording is additive and image paste succeeds reliably for supported default paths without introducing provider or session-architecture changes

## Phases

### Phase 1: Spinner Verb Assets and Safe Display Wiring

- Step 1: Add a shared spinner verb asset/module in a new file
- Step 2: Add lightweight global busy-spinner text using additive display wiring
- Step 3: Improve per-tool pending labels with clearer present-continuous wording
- Step 4: Prefer existing runtime tool titles where available instead of introducing new tool contracts

### Phase 2: Clipboard Image Reliability Hardening

- Step 1: Isolate clipboard image detection/normalization logic in a helper module
- Step 2: Harden direct clipboard-image read behavior across supported platforms
- Step 3: Ensure empty/invalid clipboard image payloads cleanly fall back to normal paste behavior
- Step 4: Keep changes narrowly scoped to prompt input and clipboard utility surfaces

### Phase 3: File-Path Paste Fallback and UX Clarity

- Step 1: Harden pasted file-path detection for image attachments
- Step 2: Preserve reliable image-file-path paste as the fallback path when clipboard image extraction is unavailable
- Step 3: Improve user-facing wording/status around image attachment actions without redesigning attachment storage
- Step 4: Keep SVG/text and non-image paste behavior compatible with current behavior

### Phase 4: Hardening and Rebase-Safety Review

- Step 1: Add focused tests for spinner verb rendering and image-paste flow variants
- Step 2: Review touched files to keep changes isolated from high-churn upstream areas
- Step 3: Defer any dependency-heavy or architecture-heavy image work to a later plan

## Risks

- Hot-file merge conflicts: Keep edits to prompt/input UI files small and move new logic into helper modules
- Terminal/clipboard variability: Preserve file-path paste as a reliable fallback rather than assuming direct clipboard image support everywhere
- UX regressions for normal paste: Always preserve plain-text paste behavior when image extraction fails
- Scope creep into deep multimodal work: Limit this plan to input reliability and TUI wording only
