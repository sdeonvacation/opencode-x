import { describe, expect, test } from "bun:test"
import path from "path"
import * as fs from "fs/promises"
import { ClipboardImageHelper } from "../../../src/cli/cmd/tui/util/clipboard-image"
import type { Clipboard } from "../../../src/cli/cmd/tui/util/clipboard"
import { tmpdir } from "../../fixture/fixture"

// ---------------------------------------------------------------------------
// Minimal image fixtures (magic bytes only — not valid full images, but
// sufficient for isValidImageBuffer which only checks the first 12 bytes)
// ---------------------------------------------------------------------------

/** Minimal 1×1 PNG (valid PNG magic bytes: \x89PNG\r\n\x1a\n) */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
const PNG_B64 = PNG_MAGIC.toString("base64")

/** Minimal JPEG (SOI marker: \xFF\xD8) */
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])
const JPEG_B64 = JPEG_MAGIC.toString("base64")

/** Minimal GIF87a header */
const GIF_MAGIC = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00])
const GIF_B64 = GIF_MAGIC.toString("base64")

/** Minimal WebP: RIFF????WEBP */
const WEBP_MAGIC = Buffer.from([
  0x52,
  0x49,
  0x46,
  0x46, // RIFF
  0x24,
  0x00,
  0x00,
  0x00, // file size (placeholder)
  0x57,
  0x45,
  0x42,
  0x50, // WEBP
])
const WEBP_B64 = WEBP_MAGIC.toString("base64")

/** Plain text encoded as base64 */
const TEXT_B64 = Buffer.from("hello world").toString("base64")

// ---------------------------------------------------------------------------
// isValidImageBuffer
// ---------------------------------------------------------------------------

describe("ClipboardImageHelper.isValidImageBuffer", () => {
  test('returns false for empty string ""', () => {
    expect(ClipboardImageHelper.isValidImageBuffer("")).toBe(false)
  })

  test("returns true for valid PNG magic bytes", () => {
    expect(ClipboardImageHelper.isValidImageBuffer(PNG_B64)).toBe(true)
  })

  test("returns true for valid JPEG SOI magic bytes", () => {
    expect(ClipboardImageHelper.isValidImageBuffer(JPEG_B64)).toBe(true)
  })

  test("returns true for valid GIF87a magic bytes", () => {
    expect(ClipboardImageHelper.isValidImageBuffer(GIF_B64)).toBe(true)
  })

  test("returns true for valid WebP RIFF header", () => {
    expect(ClipboardImageHelper.isValidImageBuffer(WEBP_B64)).toBe(true)
  })

  test('returns false for base64 of plain text "hello world"', () => {
    expect(ClipboardImageHelper.isValidImageBuffer(TEXT_B64)).toBe(false)
  })

  test("returns false for too-short buffer (< 4 bytes)", () => {
    const short = Buffer.from([0x89, 0x50]).toString("base64")
    expect(ClipboardImageHelper.isValidImageBuffer(short)).toBe(false)
  })

  test("returns false for invalid base64 input", () => {
    expect(ClipboardImageHelper.isValidImageBuffer("!!!not-base64!!!")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// fromClipboard (DI via optional reader)
// ---------------------------------------------------------------------------

describe("ClipboardImageHelper.fromClipboard", () => {
  test("returns kind: image for valid PNG clipboard content", async () => {
    const reader = async (): Promise<Clipboard.Content | undefined> => ({
      data: PNG_B64,
      mime: "image/png",
    })
    const result = await ClipboardImageHelper.fromClipboard(reader)
    expect(result.kind).toBe("image")
    expect(result.mime).toBe("image/png")
    expect(result.content).toBe(PNG_B64)
  })

  test("returns kind: empty for empty-buffer image clipboard (macOS guard)", async () => {
    const reader = async (): Promise<Clipboard.Content | undefined> => ({
      data: "",
      mime: "image/png",
    })
    const result = await ClipboardImageHelper.fromClipboard(reader)
    expect(result.kind).toBe("empty")
  })

  test("returns kind: text for text/plain clipboard content", async () => {
    const reader = async (): Promise<Clipboard.Content | undefined> => ({
      data: "hello world",
      mime: "text/plain",
    })
    const result = await ClipboardImageHelper.fromClipboard(reader)
    expect(result.kind).toBe("text")
    expect(result.text).toBe("hello world")
  })

  test("returns kind: empty when reader returns undefined", async () => {
    const reader = async (): Promise<Clipboard.Content | undefined> => undefined
    const result = await ClipboardImageHelper.fromClipboard(reader)
    expect(result.kind).toBe("empty")
  })

  test("returns kind: empty when reader throws (no crash)", async () => {
    const reader = async (): Promise<Clipboard.Content | undefined> => {
      throw new Error("OS clipboard error")
    }
    const result = await ClipboardImageHelper.fromClipboard(reader)
    expect(result.kind).toBe("empty")
  })

  test("returns kind: empty for non-empty but corrupt image buffer", async () => {
    const reader = async (): Promise<Clipboard.Content | undefined> => ({
      data: TEXT_B64, // valid base64 but not an image
      mime: "image/png",
    })
    const result = await ClipboardImageHelper.fromClipboard(reader)
    expect(result.kind).toBe("empty")
  })
})

// ---------------------------------------------------------------------------
// fromPastedText
// ---------------------------------------------------------------------------

describe("ClipboardImageHelper.fromPastedText", () => {
  test("returns kind: text for plain non-path text", async () => {
    const result = await ClipboardImageHelper.fromPastedText("hello world")
    expect(result.kind).toBe("text")
    expect(result.text).toBe("hello world")
  })

  test("returns kind: text for http URL (not treated as file path)", async () => {
    const result = await ClipboardImageHelper.fromPastedText("https://example.com/image.png")
    expect(result.kind).toBe("text")
  })

  test("returns kind: file-path-image for existing PNG file", async () => {
    await using tmp = await tmpdir()
    const imgPath = path.join(tmp.path, "test.png")
    // Write a minimal PNG (magic bytes + some padding)
    await fs.writeFile(imgPath, PNG_MAGIC)

    const result = await ClipboardImageHelper.fromPastedText(imgPath)
    expect(result.kind).toBe("file-path-image")
    expect(result.mime).toBe("image/png")
    expect(result.filename).toBe("test.png")
    expect(result.filepath).toBe(imgPath)
    expect(typeof result.content).toBe("string")
    expect(result.content!.length).toBeGreaterThan(0)
  })

  test("returns kind: text with SVG content for existing SVG file", async () => {
    await using tmp = await tmpdir()
    const svgPath = path.join(tmp.path, "icon.svg")
    const svgContent = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>'
    await fs.writeFile(svgPath, svgContent, "utf-8")

    const result = await ClipboardImageHelper.fromPastedText(svgPath)
    expect(result.kind).toBe("text")
    expect(result.text).toBe(svgContent)
  })

  test("returns kind: file-path-image for existing PDF file", async () => {
    await using tmp = await tmpdir()
    const pdfPath = path.join(tmp.path, "doc.pdf")
    // Minimal PDF header
    await fs.writeFile(pdfPath, Buffer.from("%PDF-1.4\n"))

    const result = await ClipboardImageHelper.fromPastedText(pdfPath)
    expect(result.kind).toBe("file-path-image")
    expect(result.mime).toBe("application/pdf")
    expect(result.filename).toBe("doc.pdf")
  })

  test("returns kind: text for nonexistent image path (file read failure fallback)", async () => {
    const result = await ClipboardImageHelper.fromPastedText("/nonexistent/path/image.png")
    expect(result.kind).toBe("text")
    expect(result.text).toBe("/nonexistent/path/image.png")
  })

  test("strips surrounding single quotes and whitespace", async () => {
    await using tmp = await tmpdir()
    const imgPath = path.join(tmp.path, "quoted.png")
    await fs.writeFile(imgPath, PNG_MAGIC)

    const result = await ClipboardImageHelper.fromPastedText(`'${imgPath}'`)
    expect(result.kind).toBe("file-path-image")
  })

  test("strips surrounding double quotes", async () => {
    await using tmp = await tmpdir()
    const imgPath = path.join(tmp.path, "quoted2.png")
    await fs.writeFile(imgPath, PNG_MAGIC)

    const result = await ClipboardImageHelper.fromPastedText(`"${imgPath}"`)
    expect(result.kind).toBe("file-path-image")
  })

  test("resolves file:// URI to local path", async () => {
    await using tmp = await tmpdir()
    const imgPath = path.join(tmp.path, "uri.png")
    await fs.writeFile(imgPath, PNG_MAGIC)

    const fileUri = `file://${imgPath}`
    const result = await ClipboardImageHelper.fromPastedText(fileUri)
    expect(result.kind).toBe("file-path-image")
    expect(result.mime).toBe("image/png")
  })

  test("returns kind: text for extensionless path (application/octet-stream)", async () => {
    // Extensionless path → mimeType returns application/octet-stream → kind: text
    const result = await ClipboardImageHelper.fromPastedText("/tmp/image")
    expect(result.kind).toBe("text")
  })

  test("returns kind: text for nonexistent SVG path (file read failure fallback)", async () => {
    const result = await ClipboardImageHelper.fromPastedText("/nonexistent/path/icon.svg")
    expect(result.kind).toBe("text")
    expect(result.text).toBe("/nonexistent/path/icon.svg")
  })
})
