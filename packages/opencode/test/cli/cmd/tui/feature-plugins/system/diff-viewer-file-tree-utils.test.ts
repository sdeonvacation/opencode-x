import { describe, it, expect } from "bun:test"
import {
  build,
  flatten,
  status,
  filename,
  type FileEntry,
  type TreeNode,
} from "@/cli/cmd/tui/feature-plugins/system/diff-viewer-file-tree-utils"

function entry(file: string, opts?: Partial<FileEntry>): FileEntry {
  return {
    file,
    patch: `--- a/${file}\n+++ b/${file}\n@@ -1,1 +1,1 @@\n-old\n+new`,
    additions: opts?.additions ?? 1,
    deletions: opts?.deletions ?? 1,
    status: opts?.status ?? "modified",
  }
}

describe("diff-viewer-file-tree-utils", () => {
  describe("status", () => {
    it("returns A for added", () => {
      expect(status(entry("a.ts", { status: "added" }))).toBe("A")
    })

    it("returns D for deleted", () => {
      expect(status(entry("a.ts", { status: "deleted" }))).toBe("D")
    })

    it("returns M for modified", () => {
      expect(status(entry("a.ts", { status: "modified" }))).toBe("M")
    })
  })

  describe("filename", () => {
    it("returns basename of path", () => {
      expect(filename("src/lib/foo.ts")).toBe("foo.ts")
    })

    it("handles root files", () => {
      expect(filename("readme.md")).toBe("readme.md")
    })
  })

  describe("build", () => {
    it("creates tree from flat entries", () => {
      const entries = [entry("src/a.ts"), entry("src/b.ts"), entry("lib/c.ts")]
      const tree = build(entries)
      expect(tree.children.length).toBe(2)
    })

    it("collapses single-child directories", () => {
      const entries = [entry("src/lib/deep/a.ts"), entry("src/lib/deep/b.ts")]
      const tree = build(entries)
      // All single-child dirs collapse into root: "src/lib/deep" with 2 file children
      expect(tree.name).toContain("src")
      expect(tree.children.length).toBe(2)
    })

    it("handles empty entries", () => {
      const tree = build([])
      expect(tree.children.length).toBe(0)
    })

    it("handles single file at root", () => {
      const entries = [entry("readme.md")]
      const tree = build(entries)
      expect(tree.children.length).toBe(1)
      expect(tree.children[0].entry).toBeDefined()
      expect(tree.children[0].name).toBe("readme.md")
    })

    it("sorts directories before files", () => {
      const entries = [entry("z.ts"), entry("src/a.ts"), entry("src/b.ts")]
      const tree = build(entries)
      // "src" directory should come before "z.ts" file
      expect(tree.children[0].children.length).toBeGreaterThan(0)
      expect(tree.children[1].entry).toBeDefined()
    })
  })

  describe("flatten", () => {
    it("extracts all file entries from tree", () => {
      const entries = [entry("src/a.ts"), entry("src/b.ts"), entry("lib/c.ts")]
      const tree = build(entries)
      const flat = flatten(tree)
      expect(flat.length).toBe(3)
    })

    it("preserves file data", () => {
      const entries = [entry("src/foo.ts", { additions: 5, deletions: 3, status: "added" })]
      const tree = build(entries)
      const flat = flatten(tree)
      expect(flat[0].additions).toBe(5)
      expect(flat[0].deletions).toBe(3)
      expect(flat[0].status).toBe("added")
    })

    it("returns empty for empty tree", () => {
      const tree: TreeNode = { name: "", path: "", children: [] }
      expect(flatten(tree)).toEqual([])
    })
  })
})
