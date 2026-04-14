import { expect, test } from "bun:test"
import { merge, rel } from "../../../src/cli/cmd/tui/feature-plugins/sidebar/files"
import { createTuiPluginApi } from "../../fixture/tui-plugin"

function api() {
  return createTuiPluginApi({
    state: {
      path: {
        state: "/tmp/state",
        config: "/tmp/config",
        worktree: "/tmp/work",
        directory: "/tmp/work/packages/opencode",
      },
      vcs: {
        branch: "dev",
        files: [
          {
            file: "packages/opencode/dummy3.txt",
            additions: 3,
            deletions: 1,
          },
        ],
      },
    },
  })
}

test("rel normalizes patch paths for vcs matching", () => {
  const item = api()

  expect(rel(item, "/tmp/work/packages/opencode/dummy3.txt")).toBe("packages/opencode/dummy3.txt")
  expect(rel(item, "packages/opencode/dummy3.txt")).toBe("packages/opencode/dummy3.txt")
})

test("merge fills counts from vcs diff", () => {
  const item = api()

  expect(merge(item, ["/tmp/work/packages/opencode/dummy3.txt"])).toEqual([
    {
      file: "packages/opencode/dummy3.txt",
      additions: 3,
      deletions: 1,
    },
  ])
})

test("merge keeps files without vcs counts", () => {
  const api = createTuiPluginApi({
    state: {
      path: {
        state: "/tmp/state",
        config: "/tmp/config",
        worktree: "/tmp/work",
        directory: "/tmp/work/packages/opencode",
      },
    },
  })

  expect(merge(api, ["/tmp/work/packages/opencode/dummy3.txt"])).toEqual([
    {
      file: "packages/opencode/dummy3.txt",
      additions: 0,
      deletions: 0,
    },
  ])
})
