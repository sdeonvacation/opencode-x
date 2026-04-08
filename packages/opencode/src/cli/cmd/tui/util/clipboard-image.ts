import path from "path"
import { fileURLToPath } from "url"
import { Clipboard } from "./clipboard"
import { Filesystem } from "@/util/filesystem"

export type PasteKind = "image" | "file-path-image" | "text" | "empty"

export type PasteResult = {
  kind: PasteKind
  mime?: string
  content?: string
  filename?: string
  filepath?: string
  text?: string
}

export namespace ClipboardImageHelper {
  /**
   * Validates image magic bytes for PNG, JPEG, GIF, and WebP.
   * Decodes only the first 12 bytes — O(1) regardless of image size.
   * Returns false for empty or unrecognised buffers.
   */
  export function isValidImageBuffer(b64: string): boolean {
    if (!b64) return false
    try {
      const buf = Buffer.from(b64, "base64")
      if (buf.byteLength < 4) return false
      // PNG: \x89PNG
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true
      // JPEG: \xFF\xD8
      if (buf[0] === 0xff && buf[1] === 0xd8) return true
      // GIF: GIF8
      if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return true
      // WebP: RIFF????WEBP (bytes 0-3 = RIFF, bytes 8-11 = WEBP)
      if (
        buf.byteLength >= 12 &&
        buf[0] === 0x52 &&
        buf[1] === 0x49 &&
        buf[2] === 0x46 &&
        buf[3] === 0x46 &&
        buf[8] === 0x57 &&
        buf[9] === 0x45 &&
        buf[10] === 0x42 &&
        buf[11] === 0x50
      )
        return true
      return false
    } catch {
      return false
    }
  }

  /**
   * Reads from the clipboard and classifies the result.
   *
   * @param reader - Optional DI hook; defaults to `Clipboard.read`.
   *   Accepts `() => Promise<Clipboard.Content | undefined>`.
   *
   * Returns:
   *   - `kind: "image"` when clipboard contains a valid image buffer
   *   - `kind: "text"` when clipboard contains plain text
   *   - `kind: "empty"` on empty payload, invalid buffer, or any OS error
   */
  export async function fromClipboard(reader?: () => Promise<Clipboard.Content | undefined>): Promise<PasteResult> {
    try {
      const content = await (reader ?? Clipboard.read)()
      if (!content) return { kind: "empty" }
      if (content.mime.startsWith("image/")) {
        if (!isValidImageBuffer(content.data)) return { kind: "empty" }
        return { kind: "image", mime: content.mime, content: content.data }
      }
      if (content.mime === "text/plain") {
        return { kind: "text", text: content.data }
      }
      return { kind: "empty" }
    } catch {
      return { kind: "empty" }
    }
  }

  /**
   * Classifies a decoded paste string (post `decodePasteBytes`).
   *
   * Handles:
   *   - `file://` URIs → resolved to local path
   *   - Surrounding quote stripping
   *   - Windows/Unix path normalisation
   *   - SVG files → `kind: "text"` with SVG content
   *   - image/* and application/pdf → `kind: "file-path-image"` with base64 content
   *   - Everything else → `kind: "text"` with original raw string
   *
   * File-read failures return `kind: "text"` with the original raw string.
   */
  export async function fromPastedText(raw: string): Promise<PasteResult> {
    // Strip surrounding quotes and whitespace, resolve file:// URIs
    const stripped = raw.replace(/^['"]+|['"]+$/g, "").trim()

    let filepath = stripped
    if (stripped.startsWith("file://")) {
      try {
        filepath = fileURLToPath(stripped)
      } catch {
        return { kind: "text", text: raw }
      }
    } else if (process.platform !== "win32") {
      // Unescape backslash-escaped characters on Unix
      filepath = stripped.replace(/\\(.)/g, "$1")
    }

    // Quick URL check — don't treat http(s) URLs as file paths
    if (/^https?:\/\//.test(filepath)) {
      return { kind: "text", text: raw }
    }

    try {
      const mime = Filesystem.mimeType(filepath)
      const filename = path.basename(filepath)

      // SVG: treat as raw text content, not base64 image
      if (mime === "image/svg+xml") {
        try {
          const content = await Filesystem.readText(filepath)
          return { kind: "text", text: content, filename, filepath }
        } catch {
          return { kind: "text", text: raw }
        }
      }

      // image/* or PDF: read bytes as base64
      if (mime.startsWith("image/") || mime === "application/pdf") {
        try {
          const content = await Filesystem.readArrayBuffer(filepath).then((buf) => Buffer.from(buf).toString("base64"))
          return { kind: "file-path-image", mime, content, filename, filepath }
        } catch {
          return { kind: "text", text: raw }
        }
      }

      // All other MIME types (including application/octet-stream for extensionless paths)
      return { kind: "text", text: raw }
    } catch {
      // mimeType() itself doesn't throw (returns application/octet-stream), but guard anyway
      return { kind: "text", text: raw }
    }
  }
}
