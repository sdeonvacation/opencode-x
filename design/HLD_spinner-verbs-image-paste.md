# HLD: Spinner Verbs and Reliable Image Paste

## Tech Stack

| Category  | Technology                       | Purpose                                                        |
| --------- | -------------------------------- | -------------------------------------------------------------- |
| Language  | TypeScript 5.8.2 + Bun 1.3.11    | Primary implementation language; Bun runtime for tests         |
| Framework | @opentui/core / @opentui/solid   | TUI rendering and component model; existing spinner primitives |
| UI        | SolidJS (via @opentui/solid)     | Reactive component tree for Prompt, Spinner, and session route |
| Clipboard | clipboardy + OS-native processes | Cross-platform clipboard read/write; existing `Clipboard` util |
| MIME      | mime-types (via `Filesystem`)    | Extension-to-MIME lookup for file-path paste detection         |
| Testing   | Bun test runner                  | Unit and integration tests under `packages/opencode/test/`     |

---

## Components

| Component                       | Responsibility                                                                                                      | Dependencies                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `SpinnerVerbs` (new)            | Exports a curated list of present-continuous activity verbs and a `pick(tool?)` helper to select a contextual label | None (pure data/logic module)                                     |
| `ClipboardImageHelper` (new)    | Encapsulates image-detection, validation, and normalization logic extracted from `Clipboard.read()` call sites      | `Clipboard` util, `Filesystem.mimeType`, `path`, `fs/promises`    |
| `Clipboard` (existing, patched) | Cross-platform clipboard read/write; gains explicit empty-payload guard and clearer error boundary on image paths   | OS processes (`osascript`, `powershell`, `wl-paste`, `xclip`)     |
| `Spinner` component (existing)  | Animated braille/block spinner; accepts optional `children` label — no structural change needed                     | `@opentui/core`, `useTheme`, `useKV`                              |
| `Prompt` component (existing)   | User input area; paste handler and `onKeyDown` image-paste path call `ClipboardImageHelper`; spinner label wired    | `SpinnerVerbs`, `ClipboardImageHelper`, `Clipboard`, `Filesystem` |
| Session route (existing)        | Renders per-tool `InlineTool`/`BlockTool` rows; `pending` strings updated to use `SpinnerVerbs` constants           | `SpinnerVerbs`                                                    |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  packages/opencode/src/cli/cmd/tui/                                             │
│                                                                                 │
│  util/                                                                          │
│  ├── clipboard.ts          (existing – minor guard patch)                       │
│  ├── clipboard-image.ts    (NEW – ClipboardImageHelper)                         │
│  └── spinner-verbs.ts      (NEW – SpinnerVerbs)                                 │
│                                                                                 │
│  component/                                                                     │
│  ├── spinner.tsx           (existing – unchanged)                               │
│  └── prompt/                                                                    │
│      └── index.tsx         (existing – thin wiring: import helpers, use verbs)  │
│                                                                                 │
│  routes/session/                                                                │
│  └── index.tsx             (existing – pending strings reference SpinnerVerbs)  │
└─────────────────────────────────────────────────────────────────────────────────┘

Data / control flow:

  User pastes (Ctrl+V / bracketed-paste)
        │
        ▼
  Prompt.onKeyDown / onPaste
        │
        ├─► ClipboardImageHelper.detect()
        │       ├─► Clipboard.read()  [existing, patched]
        │       ├─► validate payload (non-empty, valid PNG/JPEG/GIF/WEBP header)
        │       └─► returns: { kind: "image" | "file-path-image" | "text" | "empty" }
        │
        ├─► [kind === "image"]          → pasteAttachment({ mime, content })
        ├─► [kind === "file-path-image"]→ pasteAttachment({ filename, filepath, mime, content })
        ├─► [kind === "text"]           → default textarea paste (no preventDefault)
        └─► [kind === "empty"]          → no-op (silent, no crash)

  Session busy state
        │
        ▼
  Prompt status row  →  <Spinner>  SpinnerVerbs.global()
  InlineTool pending →  SpinnerVerbs.forTool(toolName)
```

**Description:** All new logic lives in two additive helper modules (`spinner-verbs.ts`, `clipboard-image.ts`). The existing `Clipboard.read()` receives a minimal guard (empty-buffer check). `Prompt/index.tsx` and `routes/session/index.tsx` import the helpers and replace inline string literals; no structural changes to either file's component tree or data model.

---

## Interfaces

### `SpinnerVerbs`

`packages/opencode/src/cli/cmd/tui/util/spinner-verbs.ts`

| Export                  | Input            | Output     | Behavior                                                                                                                   | Errors |
| ----------------------- | ---------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------- | ------ |
| `VERBS`                 | —                | `string[]` | Exported constant: curated list of present-continuous verbs (e.g. `"Thinking..."`, `"Reasoning..."`, `"Working..."`, etc.) | —      |
| `global()`              | —                | `string`   | Returns a generic busy label (e.g. `"Working…"`). Suitable for the global spinner row in `Prompt`.                         | —      |
| `forTool(tool: string)` | tool name string | `string`   | Returns the best present-continuous label for the given tool name. Falls back to `global()` for unknown tools.             | —      |

**Tool-to-verb mapping (initial set):**

| Tool name     | Verb label           | Notes                                                                                                                                                   |
| ------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bash`        | `"Writing command…"` | Matches existing semantic: pending state is before command is fully received. Two static call sites: lines 1653 and 1872 in `routes/session/index.tsx`. |
| `read`        | `"Reading…"`         |                                                                                                                                                         |
| `write`       | `"Writing…"`         | Only used when Write falls back to `InlineTool` without dynamic `pending()` memo. The dynamic memo at line 1925 is left unchanged.                      |
| `edit`        | `"Editing…"`         |                                                                                                                                                         |
| `glob`        | `"Searching…"`       |                                                                                                                                                         |
| `grep`        | `"Searching…"`       |                                                                                                                                                         |
| `list`        | `"Listing…"`         |                                                                                                                                                         |
| `webfetch`    | `"Fetching…"`        |                                                                                                                                                         |
| `websearch`   | `"Searching…"`       |                                                                                                                                                         |
| `codesearch`  | `"Searching…"`       |                                                                                                                                                         |
| `task`        | `"Delegating…"`      |                                                                                                                                                         |
| `apply_patch` | `"Patching…"`        |                                                                                                                                                         |
| `question`    | `"Asking…"`          |                                                                                                                                                         |
| `skill`       | `"Loading…"`         |                                                                                                                                                         |
| _(default)_   | `"Working…"`         |                                                                                                                                                         |

**Static `pending` call sites to update** (exhaustive list from `routes/session/index.tsx`):

| Line | Current string               | Replacement                           |
| ---- | ---------------------------- | ------------------------------------- |
| 1653 | `"Writing command..."`       | `SpinnerVerbs.forTool("bash")`        |
| 1872 | `"Writing command..."`       | `SpinnerVerbs.forTool("bash")`        |
| 1945 | `"Finding files..."`         | `SpinnerVerbs.forTool("glob")`        |
| 1968 | `"Reading file..."`          | `SpinnerVerbs.forTool("read")`        |
| 1990 | `"Searching content..."`     | `SpinnerVerbs.forTool("grep")`        |
| 2007 | `"Listing directory..."`     | `SpinnerVerbs.forTool("list")`        |
| 2015 | `"Fetching from the web..."` | `SpinnerVerbs.forTool("webfetch")`    |
| 2025 | `"Searching code..."`        | `SpinnerVerbs.forTool("codesearch")`  |
| 2035 | `"Searching web..."`         | `SpinnerVerbs.forTool("websearch")`   |
| 2094 | `"Delegating..."`            | `SpinnerVerbs.forTool("task")`        |
| 2150 | `"Preparing edit..."`        | `SpinnerVerbs.forTool("edit")`        |
| 2225 | `"Preparing patch..."`       | `SpinnerVerbs.forTool("apply_patch")` |
| 2259 | `"Asking questions..."`      | `SpinnerVerbs.forTool("question")`    |
| 2269 | `"Loading skill..."`         | `SpinnerVerbs.forTool("skill")`       |

**Dynamic `pending` call sites — NOT updated** (left unchanged):

| Line | Component    | Reason                                                                                       |
| ---- | ------------ | -------------------------------------------------------------------------------------------- |
| 1189 | Session root | `pending()` is `messageID \| undefined`, not a verb string; used by `UserMessage`            |
| 1925 | Write        | `pending()` is a `createMemo` returning dynamic runtime titles from `ToolStateRunning.title` |

---

### `ClipboardImageHelper`

`packages/opencode/src/cli/cmd/tui/util/clipboard-image.ts`

| Method / Export                   | Input                                                                                            | Output                                                                                                      | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Errors                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `PasteKind` (type)                | —                                                                                                | `"image" \| "file-path-image" \| "text" \| "empty"`                                                         | Discriminated union describing what a paste event resolved to.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | —                                                                  |
| `PasteResult` (type)              | —                                                                                                | `{ kind: PasteKind; mime?: string; content?: string; filename?: string; filepath?: string; text?: string }` | Carries all data needed for `pasteAttachment` or text insertion.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | —                                                                  |
| `fromClipboard(reader?)`          | Optional `reader?: () => Promise<Clipboard.Content \| undefined>` (defaults to `Clipboard.read`) | `Promise<PasteResult>`                                                                                      | Calls `reader()` (or `Clipboard.read()` by default). If result is `image/*` MIME and `isValidImageBuffer(data)` is true → `kind: "image"`. If result is `text/plain` → `kind: "text"`. If result is undefined or empty or invalid buffer → `kind: "empty"`.                                                                                                                                                                                                                                                                                               | Swallows OS errors; returns `kind: "empty"` on any failure.        |
| `fromPastedText(raw: string)`     | Decoded paste text (post `decodePasteBytes`)                                                     | `Promise<PasteResult>`                                                                                      | Strips surrounding quotes, resolves `file://` URIs, normalises Windows/Unix path separators. Calls `Filesystem.mimeType()`. If MIME is `image/svg+xml` → reads file text → `kind: "text"` with SVG content. If MIME is `image/*` or `application/pdf` → reads file bytes → `kind: "file-path-image"`. If MIME is anything else (e.g. `application/octet-stream`, `text/plain`, or any non-image type) → `kind: "text"`, `text = raw` (caller handles multi-line summarisation). If `mimeType()` throws (not a valid path) → `kind: "text"`, `text = raw`. | File-read failures return `kind: "text"` with original raw string. |
| `isValidImageBuffer(b64: string)` | base64 string                                                                                    | `boolean`                                                                                                   | Decodes first 12 bytes; checks PNG magic (`\x89PNG`), JPEG SOI (`\xFF\xD8`), GIF header (`GIF8`), WebP RIFF header. Returns `false` for empty or unrecognised buffers.                                                                                                                                                                                                                                                                                                                                                                                    | Returns `false` on any decode error.                               |

**Design note:** `fromClipboard()` and `fromPastedText()` replace the inline detection logic currently spread across `Prompt`'s `onKeyDown` and `onPaste` handlers. The handlers become thin delegators:

```
onKeyDown (input_paste keybind)
  → result = await ClipboardImageHelper.fromClipboard()
  → if result.kind === "image" → pasteAttachment(result) + preventDefault
  → else → do NOT preventDefault; let default paste behaviour continue
  (This REPLACES the existing Clipboard.read() call at prompt/index.tsx:940.
   The onKeyDown handler no longer calls Clipboard.read() directly.)

onPaste (bracketed paste)
  → if pastedContent is empty → command.trigger("prompt.paste")  [unchanged]
    (command.trigger path is ONLY for empty bracketed paste from onPaste,
     never from onKeyDown. This avoids double Clipboard.read() invocation.)
  → result = await ClipboardImageHelper.fromPastedText(pastedContent)
  → switch result.kind:
      "file-path-image" | "image" → pasteAttachment(result) + preventDefault
      "text" (SVG)                → pasteText(result.text!, ...) + preventDefault
      "text" (long)               → pasteText(...) + preventDefault  [existing logic]
      "text" (short)              → default textarea paste
```

**Call-site ownership:** `Clipboard.read()` is called in exactly two places after this change:

1. Inside `ClipboardImageHelper.fromClipboard()` (called by `onKeyDown`)
2. Inside the `"prompt.paste"` command handler at `prompt/index.tsx:256-265` (called only by `onPaste` for empty bracketed paste)

The `"prompt.paste"` command handler is **deliberately left using raw `Clipboard.read()`** rather than updated to use `ClipboardImageHelper.fromClipboard()`. Rationale: this path is only triggered for empty bracketed paste (Windows Terminal <1.25 edge case). The macOS empty-buffer guard added to `Clipboard.read()` is sufficient protection against attaching an empty image in this path. Additionally, `ClipboardImageHelper.fromClipboard()` adds `isValidImageBuffer()` validation which provides a second layer of defence if this handler is migrated in a future pass. For now, keeping the handler as-is minimises the diff on `prompt/index.tsx`.

There is no double-invocation path. `onKeyDown` delegates to `fromClipboard()` and either attaches an image or falls through to default paste. `onPaste` handles its own path separately.

**`PasteResult.text` field guarantee:** When `kind === "text"`, the `text` field is always populated (set to the original raw string or the SVG file content). Callers may safely use `result.text!` in this branch.

---

### `Clipboard` (existing – patch only)

`packages/opencode/src/cli/cmd/tui/util/clipboard.ts`

| Change                       | Location in file                    | What changes                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Empty-buffer guard (macOS)   | `read()`, darwin branch, line 61-62 | After `Filesystem.readBytes(tmpfile)`, check `buffer.byteLength > 0` before returning. If zero bytes, do NOT return the image result — skip past the `return` statement on line 62 and fall through to the `clipboardy.read()` text fallback at line 98. Concretely: wrap the existing `return { data: buffer.toString("base64"), mime: "image/png" }` in `if (buffer.byteLength > 0) { ... }`. |
| Empty-buffer guard (Win/WSL) | `read()`, win32 branch              | Already guarded (`imageBuffer.length > 0`). No change needed.                                                                                                                                                                                                                                                                                                                                   |
| Empty-buffer guard (Linux)   | `read()`, linux branch              | Already guarded (`stdout.byteLength > 0`). No change needed.                                                                                                                                                                                                                                                                                                                                    |
| `console.log` removal        | `getCopyMethod()`                   | Replace `console.log("clipboard: using …")` calls with no-ops or a proper debug logger to avoid polluting TUI output. (Low-risk cosmetic fix; can be deferred.)                                                                                                                                                                                                                                 |

---

## Data Flow

### Flow 1: Ctrl+V image paste (direct clipboard image)

| Step | Component              | Action                                                                                    | Next                                         |
| ---- | ---------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------- |
| 1    | `Prompt` `onKeyDown`   | Matches `input_paste` keybind                                                             | Calls `ClipboardImageHelper.fromClipboard()` |
| 2    | `ClipboardImageHelper` | Calls `Clipboard.read()` → gets `{ data, mime: "image/png" }`; validates non-empty buffer | Returns `PasteResult { kind: "image", … }`   |
| 3    | `Prompt` `onKeyDown`   | `result.kind === "image"` → calls `pasteAttachment({ mime, content })` + `preventDefault` | Extmark `[Image N]` inserted into textarea   |
| 4    | `Prompt` store         | Pushes `FilePart` with `data:image/png;base64,…` URL into `prompt.parts`                  | Part ready for `submit()`                    |

### Flow 2: Bracketed-paste of image file path

| Step | Component              | Action                                                                                                 | Next                                                 |
| ---- | ---------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| 1    | `Prompt` `onPaste`     | Receives `PasteEvent`; decodes bytes; `pastedContent` is non-empty path string                         | Calls `ClipboardImageHelper.fromPastedText(path)`    |
| 2    | `ClipboardImageHelper` | Strips quotes, resolves path, calls `Filesystem.mimeType()` → `"image/png"`; reads file bytes → base64 | Returns `PasteResult { kind: "file-path-image", … }` |
| 3    | `Prompt` `onPaste`     | `result.kind === "file-path-image"` → `pasteAttachment(result)` + `preventDefault`                     | Extmark `[Image N]` inserted                         |
| 4    | `Prompt` store         | Pushes `FilePart` into `prompt.parts`                                                                  | Part ready for `submit()`                            |

### Flow 3: Empty clipboard image (Windows Terminal <1.25 fallback)

| Step | Component                | Action                                                                                 | Next                                                        |
| ---- | ------------------------ | -------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1    | `Prompt` `onPaste`       | `pastedContent` is empty after normalisation                                           | `command.trigger("prompt.paste")` (unchanged existing path) |
| 2    | `Prompt` command handler | Calls `Clipboard.read()` → empty buffer (macOS guard) or no image → `undefined`/`text` | Falls through; no image attached; normal text paste         |

**Phase dependency note:** Flow 3's safe behaviour depends on the Phase 2 empty-buffer guard being applied to `clipboard.ts` first. Before Phase 2, the macOS darwin branch can still return `{ data: "", mime: "image/png" }` for a non-image clipboard, which the `prompt.paste` handler at lines 256–265 would incorrectly pass to `pasteAttachment`. Implementers must ship the `clipboard.ts` guard (Phase 2) before this flow is safe. Phase 1 (spinner verbs only) does not touch paste paths and is unaffected.

### Flow 4: Plain text paste (no change)

| Step | Component          | Action                                                                                  | Next                                               |
| ---- | ------------------ | --------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1    | `Prompt` `onPaste` | `pastedContent` is non-empty text; `fromPastedText` returns `kind: "text"`              | Existing multi-line summary or direct insert logic |
| 2    | `Prompt`           | Short text → default textarea paste; long text → `pasteText(…)` with `[Pasted N lines]` | No change from current behaviour                   |

### Flow 5: Spinner verb display

| Step | Component                  | Action                                                                             | Next                                                |
| ---- | -------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1    | `Prompt` status row        | `status().type !== "idle"` → renders global spinner row                            | `<Spinner>` with label from `SpinnerVerbs.global()` |
| 2    | Session route `InlineTool` | `pending` prop for each tool component updated to `SpinnerVerbs.forTool(toolName)` | Displayed as `~ Searching…` / `~ Running…` etc.     |

**Concrete call-site change for global spinner (I1 fix):**

At `component/prompt/index.tsx:1182`, change:

```tsx
// BEFORE
<Spinner color={spinnerDef().color} />

// AFTER
<Spinner color={spinnerDef().color}>{SpinnerVerbs.global()}</Spinner>
```

The `Spinner` component (`spinner.tsx:10`) already accepts `children?: JSX.Element` and renders it as `<text fg={textColor()}>{props.children}</text>` when present (line 35). No structural change to the component is needed.

**Concrete call-site change for onKeyDown (I2 fix):**

At `component/prompt/index.tsx:939-951`, change:

```tsx
// BEFORE
if (keybind.match("input_paste", e)) {
  const content = await Clipboard.read()
  if (content?.mime.startsWith("image/")) {
    e.preventDefault()
    await pasteAttachment({
      filename: "clipboard",
      mime: content.mime,
      content: content.data,
    })
    return
  }
  // If no image, let the default paste behavior continue
}

// AFTER
if (keybind.match("input_paste", e)) {
  const result = await ClipboardImageHelper.fromClipboard()
  if (result.kind === "image") {
    e.preventDefault()
    await pasteAttachment({
      filename: "clipboard",
      mime: result.mime!,
      content: result.content!,
    })
    return
  }
  // kind === "text" | "empty" → let default paste behaviour continue
}
```

**Per-tool pending string wiring (I4 fix):**

In `routes/session/index.tsx`, there are two categories of `pending` usage:

1. **Static string literals** (12 call sites) — replace directly:

```tsx
// BEFORE
<InlineTool icon="✱" pending="Finding files..." ...>
// AFTER
<InlineTool icon="✱" pending={SpinnerVerbs.forTool("glob")} ...>
```

2. **Dynamic computed memos** (2 call sites) — do NOT replace:
   - Line 1189: `pending={pending()}` where `pending` is a `messageID | undefined` (not a verb string; used by `UserMessage` to track in-progress assistant)
   - Line 1925: `pending={pending()}` where `pending` is a `createMemo` in `Write` component that returns dynamic titles from `ToolStateRunning.title` (e.g. `"Preparing write... 4KB received"`, `"Writing file..."`, `"Formatting file..."`)

   These dynamic memos already provide richer context than `SpinnerVerbs.forTool()` and must be left unchanged.

**Error Flows:**

- `ClipboardImageHelper.fromClipboard()` swallows all OS errors and returns `kind: "empty"` → no crash, no attachment.
- `ClipboardImageHelper.fromPastedText()` file-read failure → returns `kind: "text"` with original raw string → falls through to existing text-paste logic.
- `isValidImageBuffer()` returning `false` for a non-empty but corrupt buffer → `fromClipboard()` returns `kind: "empty"` → silent fallback.
- macOS `osascript` clipboard read returning zero bytes (no image on clipboard) → new empty-buffer guard → falls through to `clipboardy.read()` text path.

**R5 fallback clarity decision (I5 fix):** Silent no-op for `kind: "empty"` is the accepted design for this phase. Rationale: adding a visible status hint (e.g. "No image on clipboard") would require either a toast/notification component (which does not exist in opencode TUI today) or a transient status-bar message (which risks polluting the prompt area during normal text paste). The file-path paste fallback is already documented in the manual E2E checklist. A future enhancement may add a brief status hint if a toast/notification primitive becomes available.

---

## Data Model

No new database entities. No schema changes.

| Entity / Type   | Fields                                                                                                           | Relationships                        | Constraints                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------- |
| `PasteKind`     | `"image" \| "file-path-image" \| "text" \| "empty"`                                                              | —                                    | Exhaustive union; no extension without updating switch sites         |
| `PasteResult`   | `kind: PasteKind; mime?: string; content?: string (base64); filename?: string; filepath?: string; text?: string` | Consumed by `Prompt` paste handlers  | `content` present when `kind` is `"image"` or `"file-path-image"`    |
| `VERBS` array   | `string[]` constant                                                                                              | Consumed by `SpinnerVerbs.forTool()` | Read-only; no runtime mutation                                       |
| `TOOL_VERB_MAP` | `Record<string, string>` constant mapping tool names to verb strings                                             | Internal to `spinner-verbs.ts`       | Keys must match tool name strings used in `routes/session/index.tsx` |

---

## Decisions

| Decision                                        | Choice                                                                 | Reason                                                                                                                        | Alternatives                                            | Tradeoffs                                                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| New helper files vs. inline edits               | New `clipboard-image.ts` and `spinner-verbs.ts` modules                | Keeps hot files (`prompt/index.tsx`, `routes/session/index.tsx`) diffs small; isolates new logic for testing; rebase-safe     | Inline all logic in existing files                      | Slightly more files; import surface grows minimally                                                |
| `ClipboardImageHelper` as plain namespace       | `export namespace ClipboardImageHelper { … }` (plain TS, no Effect)    | Matches existing `Clipboard` namespace pattern; no Effect runtime needed for sync/async clipboard helpers                     | Effect service layer                                    | No Effect tracing; acceptable since this is UI-layer input handling, not session-loop work         |
| `SpinnerVerbs` as pure data module              | Exported constant map + two helper functions                           | Zero dependencies; trivially testable; no reactive state needed                                                               | Reactive SolidJS store; per-tool signal                 | Static map must be updated when new tools are added; acceptable for first pass                     |
| Validate image buffer magic bytes               | `isValidImageBuffer()` checks PNG/JPEG/GIF/WebP headers                | Prevents attaching corrupt or zero-byte data as images; catches macOS `osascript` returning empty file on non-image clipboard | Trust OS process exit code only                         | Small decode overhead per paste; negligible                                                        |
| Preserve `command.trigger("prompt.paste")` path | Keep existing empty-bracketed-paste → `command.trigger` path unchanged | Windows Terminal <1.25 compatibility; existing path already handles this edge case                                            | Remove and unify into `ClipboardImageHelper`            | Slightly duplicated entry point; acceptable to avoid regressions on Windows                        |
| Per-tool verb strings as constants              | `TOOL_VERB_MAP` object in `spinner-verbs.ts`                           | Avoids adding new fields to tool contracts or SDK schemas; purely display-layer concern                                       | Add `pendingLabel` field to each tool's metadata schema | Tool display labels are not co-located with tool definitions; acceptable for display-only concerns |
| No new native dependencies                      | Use existing `osascript`, `powershell`, `wl-paste`, `xclip`            | Constraint from PLAN Phase 1; avoids new binary requirements                                                                  | `@napi-rs/clipboard` or similar native addon            | Platform coverage limited to what existing tools support; file-path paste is the reliable fallback |

---

## Risks

| Risk                                                        | Impact                                                                                         | Likelihood | Mitigation                                                                                                                                                                 |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS `osascript` returns zero-byte file for text clipboard | `Clipboard.read()` currently returns `{ data: "", mime: "image/png" }` for non-image clipboard | High       | Empty-buffer guard in `Clipboard.read()` darwin branch + `isValidImageBuffer()` in `ClipboardImageHelper.fromClipboard()` double-gates the path                            |
| Hot-file merge conflicts in `prompt/index.tsx`              | Upstream changes to paste handler or spinner area conflict with our edits                      | Medium     | Keep edits minimal: replace inline string literals with `SpinnerVerbs.forTool()` calls; extract paste logic into helper; no structural JSX changes                         |
| Hot-file merge conflicts in `routes/session/index.tsx`      | Upstream tool component changes conflict with pending-string updates                           | Medium     | Only change `pending="…"` string literals to `SpinnerVerbs.forTool("…")` calls; no other edits to tool components                                                          |
| UX regression: normal text paste broken                     | Users cannot paste plain text after change                                                     | Low        | `fromPastedText()` returns `kind: "text"` for all non-image paths; existing multi-line and short-text logic unchanged; covered by integration tests                        |
| Linux `wl-paste`/`xclip` not installed                      | Image paste silently fails on Linux without Wayland/X11 tools                                  | Medium     | Already handled by existing `stdout.byteLength > 0` guard; file-path paste remains the reliable fallback; no regression from current behaviour                             |
| Windows Terminal 1.25+ Ctrl+V path regression               | New `fromClipboard()` call in `onKeyDown` adds latency or double-pastes                        | Low        | `onKeyDown` already calls `Clipboard.read()` before this change; `ClipboardImageHelper.fromClipboard()` is a thin wrapper; no behaviour change for the text-clipboard path |
| `isValidImageBuffer` false-negative for exotic formats      | Valid image not attached (e.g. TIFF, BMP)                                                      | Low        | Only PNG/JPEG/GIF/WebP checked (matches existing MIME support); exotic formats fall through to file-path paste or text paste; no crash                                     |
| `SpinnerVerbs.forTool()` called with unknown tool name      | Falls back to `"Working…"` — acceptable generic label                                          | Low        | Fallback is always defined; no runtime error possible                                                                                                                      |

---

## Test Plan

### Unit Tests

**File:** `packages/opencode/test/cli/tui/spinner-verbs.test.ts`

- `SpinnerVerbs.global()` returns a non-empty string
- `SpinnerVerbs.forTool("bash")` returns `"Writing command…"`
- `SpinnerVerbs.forTool("read")` returns `"Reading…"`
- `SpinnerVerbs.forTool("write")` returns `"Writing…"`
- `SpinnerVerbs.forTool("glob")` returns `"Searching…"`
- `SpinnerVerbs.forTool("grep")` returns `"Searching…"`
- `SpinnerVerbs.forTool("task")` returns `"Delegating…"`
- `SpinnerVerbs.forTool("unknown_tool")` returns the generic fallback (same as `global()`)
- `VERBS` is a non-empty array of strings
- All values in `TOOL_VERB_MAP` are present in `VERBS`

**File:** `packages/opencode/test/cli/tui/clipboard-image.test.ts`

- `isValidImageBuffer("")` returns `false`
- `isValidImageBuffer(base64OfPng)` returns `true` (fixture: minimal 1×1 PNG)
- `isValidImageBuffer(base64OfJpeg)` returns `true` (fixture: minimal JPEG SOI)
- `isValidImageBuffer(base64OfGif)` returns `true` (fixture: minimal GIF87a)
- `isValidImageBuffer(base64OfWebP)` returns `true` (fixture: minimal RIFF/WEBP)
- `isValidImageBuffer(base64OfText)` returns `false` (e.g. base64 of `"hello"`)
- `fromPastedText("/path/to/image.png")` → `kind: "file-path-image"` when file exists with PNG content (uses `tmpdir` fixture to write a real PNG)
- `fromPastedText("/path/to/image.svg")` → `kind: "text"` with SVG content
- `fromPastedText("/path/to/doc.pdf")` → `kind: "file-path-image"` with PDF content
- `fromPastedText("hello world")` → `kind: "text"` (non-path text)
- `fromPastedText("file:///path/to/image.png")` → resolves `file://` URI → `kind: "file-path-image"`
- `fromPastedText("/nonexistent/path.png")` → `kind: "text"` (file read failure fallback)
- `fromPastedText("'  /path/to/image.png  '")` → strips surrounding quotes/whitespace correctly
- `fromPastedText("/tmp/image")` → extensionless path → `Filesystem.mimeType()` returns `"application/octet-stream"` → `kind: "text"` (not an image; no regression from current behaviour)
- `fromClipboard()` with mocked `Clipboard.read()` returning `{ data: validPngBase64, mime: "image/png" }` → `kind: "image"`
- `fromClipboard()` with mocked `Clipboard.read()` returning `{ data: "", mime: "image/png" }` (empty buffer) → `kind: "empty"`
- `fromClipboard()` with mocked `Clipboard.read()` returning `{ data: textBase64, mime: "text/plain" }` → `kind: "text"`
- `fromClipboard()` with mocked `Clipboard.read()` returning `undefined` → `kind: "empty"`
- `fromClipboard()` with mocked `Clipboard.read()` throwing → `kind: "empty"` (no crash)

**Mock strategy:** For `clipboard-image.test.ts`, use dependency injection rather than module-level mocking: `ClipboardImageHelper.fromClipboard()` should accept an optional `reader?: () => Promise<Clipboard.Content | undefined>` parameter that defaults to `Clipboard.read`. Tests pass a mock reader directly. This avoids fragile `mock.module` interception and matches the namespace pattern. For `fromPastedText` tests, use the `tmpdir` fixture from `packages/opencode/test/fixture/fixture.ts` to write real image/SVG/PDF files to disk.

**Test directory:** Tests go under `packages/opencode/test/cli/tui/`. This directory may need to be created if it does not already exist. Verify with `ls` before creating test files.

**Coverage target:** ≥90% branch coverage for both new helper modules.

---

### Integration Tests

**File:** `packages/opencode/test/cli/tui/image-paste-flow.test.ts`

These tests verify the interaction between `ClipboardImageHelper` and the data it produces, without mounting the full TUI component tree.

- `fromPastedText` + `pasteAttachment`-compatible output: given a real PNG file on disk, `fromPastedText` returns a `PasteResult` whose `content` field is valid base64 and whose `mime` is `"image/png"`.
- `fromPastedText` + PDF: given a real PDF file on disk, result has `mime: "application/pdf"` and non-empty `content`.
- `fromPastedText` + SVG: result has `kind: "text"` and `text` field contains the raw SVG markup.
- `fromPastedText` + plain text (long): result has `kind: "text"` and `text` equals the input (caller decides summarisation).
- Fallback chain: when `fromClipboard()` returns `kind: "empty"`, the `onKeyDown` handler does not call `pasteAttachment` (verified by checking that `pasteAttachment` mock is not called).

---

### End-to-End Tests

Full TUI mount is out of scope for automated tests (requires a real terminal emulator). Manual verification checklist:

1. **macOS direct image paste:** Copy an image to clipboard → Ctrl+V in prompt → `[Image 1]` extmark appears; submit → image attached to message.
2. **macOS no-image paste:** Copy text to clipboard → Ctrl+V → text inserted normally (no `[Image]` extmark).
3. **macOS file-path paste:** Drag-and-drop a PNG from Finder → path pasted → `[Image 1]` extmark appears.
4. **Linux Wayland image paste:** `wl-copy < image.png` → Ctrl+V → image attached.
5. **Linux X11 image paste:** `xclip -selection clipboard -t image/png < image.png` → Ctrl+V → image attached.
6. **Linux no clipboard tool:** No `wl-paste`/`xclip` installed → Ctrl+V with image on clipboard → silent no-op, no crash; text paste still works.
7. **Windows Terminal 1.25+:** Copy image → Ctrl+V → image attached.
8. **Windows Terminal <1.25:** Copy image → empty bracketed paste → `command.trigger("prompt.paste")` path → image attached via `Clipboard.read()`.
9. **Spinner verbs:** Start a session with a bash tool call → spinner row shows `"Running…"`; read tool → `"Reading…"`; generic tool → `"Working…"`.
10. **SVG paste:** Copy path to `.svg` file → paste → `[SVG: filename]` extmark; text content attached (not base64 image).

---

### Non-Functional Tests

**Performance:**

- `fromPastedText()` for a 10 MB image file should complete in < 500 ms (dominated by `Filesystem.readArrayBuffer`; no new overhead introduced).
- `isValidImageBuffer()` decodes only the first 12 bytes; O(1) regardless of image size.
- `SpinnerVerbs.forTool()` is a single object-property lookup; negligible cost.

**Security:**

- `fromPastedText()` does not execute pasted content; only reads file bytes after MIME-type check.
- Path normalisation strips `file://` URI prefix and surrounding quotes before file access; no shell injection possible (no `exec` or `spawn` on the pasted path).
- `isValidImageBuffer()` operates on already-decoded bytes; no eval or dynamic execution.

**Rebase safety:**

- `spinner-verbs.ts` and `clipboard-image.ts` are new files; zero upstream conflict surface.
- `clipboard.ts` patch is a single `if (buffer.byteLength === 0)` guard; minimal conflict surface.
- `prompt/index.tsx` changes: import two new modules + replace ~5 inline string literals + delegate paste detection to helper. All changes are additive imports and call-site substitutions.
- `routes/session/index.tsx` changes: replace `pending="…"` string literals in `InlineTool` calls with `SpinnerVerbs.forTool("…")` calls. No structural JSX changes.

---

## Phased Rollout (aligned to PLAN)

| Phase | Files Created / Modified                                                                                                                                                                               | Deliverable                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| 1     | **New:** `util/spinner-verbs.ts` · **Modified:** `routes/session/index.tsx` (pending strings), `component/prompt/index.tsx` (global spinner label)                                                     | Spinner verbs visible in TUI; all per-tool pending labels improved        |
| 2     | **New:** `util/clipboard-image.ts` · **Modified:** `util/clipboard.ts` (empty-buffer guard), `component/prompt/index.tsx` (delegate `onKeyDown` + `onPaste` to helper)                                 | Reliable clipboard image paste; empty/invalid payloads handled gracefully |
| 3     | **Modified:** `component/prompt/index.tsx` (file-path paste hardening via `fromPastedText`); SVG/PDF/image MIME paths unified through helper; status/wording improvements for attachment actions       | File-path paste reliability; SVG/PDF paths consolidated                   |
| 4     | **New:** `test/cli/tui/spinner-verbs.test.ts`, `test/cli/tui/clipboard-image.test.ts`, `test/cli/tui/image-paste-flow.test.ts` · **Review:** all touched files against upstream diff for rebase-safety | Test coverage; rebase-safety sign-off                                     |

---

## Non-Goals (explicitly deferred)

- True terminal image rendering (inline image display in TUI)
- Streaming tool execution changes
- Provider multimodal architecture redesign
- New native clipboard addons (e.g. `@napi-rs/clipboard`)
- Database schema changes
- Persistent memory or lifecycle hooks
- Major permission-system changes
- User-configurable spinner verb sets (first pass is static)
