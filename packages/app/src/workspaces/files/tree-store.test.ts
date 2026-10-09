import { expect, test } from "bun:test"
import type { FileNode } from "@/runtime/server/types"
import { createPathHelpers } from "./path"
import { createFileTreeStore } from "./tree-store"

test.each([
  { label: "trailing slash", scope: "/repo", name: "dir", separator: "/", suffix: "/" },
  { label: "no trailing separator", scope: "/repo", name: "dir", separator: "/", suffix: "" },
  { label: "native Windows separators", scope: "C:\\repo", name: "dir", separator: "\\", suffix: "\\" },
  { label: "literal POSIX backslashes", scope: "/repo", name: "dir\\name\\", separator: "/", suffix: "/" },
])("re-lists a recreated directory with $label", async ({ scope, name, separator, suffix }) => {
  const paths = createPathHelpers(() => scope)
  const directory = name + suffix
  const nested = name + separator + "nested" + suffix
  const old = name + separator + "old.txt"
  const descendant = name + separator + "nested" + separator + "old.txt"
  const fresh = name + separator + "new.txt"
  const sibling = name + "-other" + suffix
  const siblingFile = name + "-other" + separator + "keep.txt"

  const entry = (path: string, type: FileNode["type"]): FileNode => ({
    name: path,
    path,
    absolute: `${scope}/${path}`,
    type,
    ignored: false,
  })

  const retained = [sibling, name + "#other" + suffix, name + "%2Fother" + suffix].map((path) =>
    entry(path, "directory"),
  )

  const snapshots = new Map<string, FileNode[]>([
    ["", [entry(directory, "directory"), ...retained]],
    [paths.normalizeDir(directory), [entry(old, "file"), entry(nested, "directory")]],
    [paths.normalizeDir(nested), [entry(descendant, "file")]],
    [paths.normalizeDir(sibling), [entry(siblingFile, "file")]],
  ])

  const requests: string[] = []
  const errors: string[] = []

  const tree = createFileTreeStore({
    scope: () => scope,
    normalizeDir: paths.normalizeDir,
    list: async (path) => {
      requests.push(path)

      return snapshots.get(path) ?? []
    },
    onError: (message) => errors.push(message),
  })

  await tree.listDir("")

  for (const path of [directory, nested, sibling]) {
    tree.expandDir(path)
    await tree.listDir(path)
  }

  expect(tree.children(directory).map((node) => node.path)).toEqual([old, nested])
  expect(tree.dirState(directory)).toMatchObject({ loaded: true, expanded: true })

  snapshots.set("", retained)
  await tree.listDir("", { force: true })

  for (const path of [directory, nested, old, descendant]) expect(tree.node(path)).toBeUndefined()

  for (const path of [directory, nested]) {
    expect(tree.dirState(path)).toBeUndefined()
    expect(tree.children(path)).toEqual([])
  }

  for (const node of retained) expect(tree.node(node.path)).toEqual(node)
  expect(tree.dirState(sibling)).toMatchObject({ loaded: true, expanded: true })
  expect(tree.children(sibling).map((node) => node.path)).toEqual([siblingFile])

  snapshots.set("", [entry(directory, "directory"), ...retained])
  snapshots.set(paths.normalizeDir(directory), [entry(fresh, "file")])
  await tree.listDir("", { force: true })
  expect(tree.children(directory)).toEqual([])
  tree.expandDir(directory)
  await tree.listDir(directory)
  expect(requests.filter((path) => path === paths.normalizeDir(directory))).toHaveLength(2)
  expect(tree.children(directory).map((node) => node.path)).toEqual([fresh])
  expect(errors).toEqual([])
})
