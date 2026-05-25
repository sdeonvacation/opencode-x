import path from "path"

export type FileEntry = {
  file: string
  patch: string
  additions: number
  deletions: number
  status: "added" | "deleted" | "modified"
}

export type TreeNode = {
  name: string
  path: string
  children: TreeNode[]
  entry?: FileEntry
}

export function status(entry: FileEntry): string {
  if (entry.status === "added") return "A"
  if (entry.status === "deleted") return "D"
  return "M"
}

export function flatten(root: TreeNode): FileEntry[] {
  const result: FileEntry[] = []
  const walk = (node: TreeNode) => {
    if (node.entry) result.push(node.entry)
    for (const child of node.children) walk(child)
  }
  walk(root)
  return result
}

export function build(entries: FileEntry[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: [] }
  for (const entry of entries) {
    const parts = entry.file.split("/")
    let node = root
    for (let i = 0; i < parts.length; i++) {
      const segment = parts[i]
      let child = node.children.find((c) => c.name === segment)
      if (!child) {
        child = {
          name: segment,
          path: parts.slice(0, i + 1).join("/"),
          children: [],
        }
        node.children.push(child)
      }
      node = child
    }
    node.entry = entry
  }
  return collapse(root)
}

function collapse(node: TreeNode): TreeNode {
  // Collapse single-child directories into parent
  if (!node.entry && node.children.length === 1 && !node.children[0].entry) {
    const child = node.children[0]
    return collapse({
      name: node.name ? node.name + "/" + child.name : child.name,
      path: child.path,
      children: child.children,
    })
  }
  node.children = node.children.map(collapse)
  node.children.sort((a, b) => {
    const ad = a.children.length > 0 && !a.entry ? 0 : 1
    const bd = b.children.length > 0 && !b.entry ? 0 : 1
    if (ad !== bd) return ad - bd
    return a.name.localeCompare(b.name)
  })
  return node
}

export function filename(file: string): string {
  return path.basename(file)
}
