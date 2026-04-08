import { describe, expect, test } from "bun:test"
import path from "path"
import * as fs from "fs/promises"
import { ClipboardImageHelper } from "../../../src/cli/cmd/tui/util/clipboard-image"
import type { Clipboard } from "../../../src/cli/cmd/tui/util/clipboard"
import { tmpdir } from "../../fixture/fixture"

// ---------------------------------------------------------------------------
// Minimal image fixtures
// ---------------------------------------------------------------------------

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
const PNG_B64 = PNG_MAGIC.toString("base64")

// ---------------------------------------------------------------------------
// Integration: fromPastedText + pasteAttachment-compatible output
// ---------------------------------------------------------------------------

describe("image-paste-flow: fromPastedText produces pasteAttachment-compatible output", () => {
  test("PNG file on disk → valid base64 content and correct mime", async () => {
    await using tmp = await tmpdir()
    const imgPath = path.join(tmp.path, "photo.png")
    await fs.writeFile(imgPath, PNG_MAGIC)

    const result = await ClipboardImageHelper.fromPastedText(imgPath)

    expect(result.kind).toBe("file-path-image")
    expect(result.mime).toBe("image/png")
    expect(result.filename).toBe("photo.png")
    expect(result.filepath).toBe(imgPath)

    // content must be valid base64
    expect(typeof result.content).toBe("string")
    expect(result.content!.length).toBeGreaterThan(0)
    // Round-trip: decode and compare to original bytes
    const decoded = Buffer.from(result.content!, "base64")
    expect(decoded).toEqual(PNG_MAGIC)
  })

  test("PDF file on disk → mime application/pdf and non-empty content", async () => {
    await using tmp = await tmpdir()
    const pdfPath = path.join(tmp.path, "report.pdf")
    const pdfBytes = Buffer.from("%PDF-1.4\n%%EOF\n")
    await fs.writeFile(pdfPath, pdfBytes)

    const result = await ClipboardImageHelper.fromPastedText(pdfPath)

    expect(result.kind).toBe("file-path-image")
    expect(result.mime).toBe("application/pdf")
    expect(result.filename).toBe("report.pdf")
    expect(typeof result.content).toBe("string")
    expect(result.content!.length).toBeGreaterThan(0)
    // Round-trip
    const decoded = Buffer.from(result.content!, "base64")
    expect(decoded).toEqual(pdfBytes)
  })

  test("SVG file on disk → kind: text with raw SVG markup in text field", async () => {
    await using tmp = await tmpdir()
    const svgPath = path.join(tmp.path, "logo.svg")
    const svgMarkup =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100"/></svg>'
    await fs.writeFile(svgPath, svgMarkup, "utf-8")

    const result = await ClipboardImageHelper.fromPastedText(svgPath)

    expect(result.kind).toBe("text")
    expect(result.text).toBe(svgMarkup)
    // SVG should NOT have content (base64) field set
    expect(result.content).toBeUndefined()
  })

  test("plain text (long) → kind: text with text field equal to input", async () => {
    const longText = "line 1\nline 2\nline 3\nline 4\nline 5\nsome more content here"
    const result = await ClipboardImageHelper.fromPastedText(longText)

    expect(result.kind).toBe("text")
    expect(result.text).toBe(longText)
  })

  test("plain text (short) → kind: text with text field equal to input", async () => {
    const shortText = "hello"
    const result = await ClipboardImageHelper.fromPastedText(shortText)

    expect(result.kind).toBe("text")
    expect(result.text).toBe(shortText)
  })
})

// ---------------------------------------------------------------------------
// Integration: fromClipboard kind: empty → pasteAttachment not called
// ---------------------------------------------------------------------------

describe("image-paste-flow: fromClipboard empty → pasteAttachment not invoked", () => {
  test("kind: empty from fromClipboard does not trigger pasteAttachment", async () => {
    let pasteAttachmentCalled = false

    // Simulate the onKeyDown handler logic
    const mockPasteAttachment = async (_file: { filename?: string; mime: string; content: string }) => {
      pasteAttachmentCalled = true
    }

    const reader = async (): Promise<Clipboard.Content | undefined> => undefined
    const result = await ClipboardImageHelper.fromClipboard(reader)

    if (result.kind === "image") {
      await mockPasteAttachment({
        filename: "clipboard",
        mime: result.mime!,
        content: result.content!,
      })
    }
    // kind === "empty" → handler falls through, pasteAttachment never called

    expect(result.kind).toBe("empty")
    expect(pasteAttachmentCalled).toBe(false)
  })

  test("kind: empty from empty-buffer clipboard does not trigger pasteAttachment", async () => {
    let pasteAttachmentCalled = false

    const mockPasteAttachment = async (_file: { filename?: string; mime: string; content: string }) => {
      pasteAttachmentCalled = true
    }

    // macOS guard scenario: osascript returns empty file
    const reader = async (): Promise<Clipboard.Content | undefined> => ({
      data: "",
      mime: "image/png",
    })
    const result = await ClipboardImageHelper.fromClipboard(reader)

    if (result.kind === "image") {
      await mockPasteAttachment({
        filename: "clipboard",
        mime: result.mime!,
        content: result.content!,
      })
    }

    expect(result.kind).toBe("empty")
    expect(pasteAttachmentCalled).toBe(false)
  })

  test("kind: image from valid clipboard triggers pasteAttachment with correct fields", async () => {
    let capturedFile: { filename?: string; mime: string; content: string } | undefined

    const mockPasteAttachment = async (file: { filename?: string; mime: string; content: string }) => {
      capturedFile = file
    }

    const reader = async (): Promise<Clipboard.Content | undefined> => ({
      data: PNG_B64,
      mime: "image/png",
    })
    const result = await ClipboardImageHelper.fromClipboard(reader)

    if (result.kind === "image") {
      await mockPasteAttachment({
        filename: "clipboard",
        mime: result.mime!,
        content: result.content!,
      })
    }

    expect(result.kind).toBe("image")
    expect(capturedFile).toBeDefined()
    expect(capturedFile!.mime).toBe("image/png")
    expect(capturedFile!.content).toBe(PNG_B64)
    expect(capturedFile!.filename).toBe("clipboard")
  })
})
