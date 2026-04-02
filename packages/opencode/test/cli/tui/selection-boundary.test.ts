import { expect, test } from "bun:test"
import { within } from "@/cli/cmd/tui/util/selection-boundary"
import type { Renderable } from "@opentui/core"

const node = (parent?: Renderable) => ({ parent: parent ?? null }) as unknown as Renderable

test("within returns true for descendant", () => {
  const root = node()
  const child = node(root)
  const leaf = node(child)
  expect(within(leaf, root)).toBe(true)
})

test("within returns false for other branch", () => {
  const root = node()
  const side = node(root)
  const main = node(root)
  const leaf = node(main)
  expect(within(leaf, side)).toBe(false)
})

test("wide session sidebar wrapper keeps fixed width to avoid main pane overflow", async () => {
  const src = await Bun.file(new URL("../../../src/cli/cmd/tui/routes/session/index.tsx", import.meta.url)).text()
  expect(src).toContain("<Match when={wide()}>")
  expect(src).toContain('<box ref={(r) => (side = r)} width={42} flexShrink={0} height="100%">')
})

test("wide session main wrapper remains shrinkable beside fixed sidebar", async () => {
  const src = await Bun.file(new URL("../../../src/cli/cmd/tui/routes/session/index.tsx", import.meta.url)).text()
  expect(src).toContain("<box\n          ref={(r) => (main = r)}")
  expect(src).toContain("flexGrow={1}")
  expect(src).toContain("flexShrink={1}")
})
