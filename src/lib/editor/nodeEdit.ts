// Node identity across the whole document, and the doc-level node edits built on it.

import type { DocItem, EditableDoc, PathItem, Vec } from '../path/types.ts'
import { findItem, replaceItem } from '../path/docTree.ts'
import { moveNodes } from '../path/geometry.ts'

export interface NodeRef {
  itemId: string
  sub: number
  idx: number
}

/** A node's identity across the whole document. */
export const nodeKey = (itemId: string, sub: number, idx: number) => `${itemId}|${sub}|${idx}`

export function parseNodeKey(key: string): NodeRef {
  const i = key.lastIndexOf('|')
  const j = key.lastIndexOf('|', i - 1)
  return {
    itemId: key.slice(0, j),
    sub: Number(key.slice(j + 1, i)),
    idx: Number(key.slice(i + 1)),
  }
}

/** A path-local `sub:idx` key (as `marqueeNodes` reports them) split into numbers. */
export function splitKey(k: string): [number, number] {
  const [a, b] = k.split(':').map(Number)
  return [a, b]
}

/** Replace an item anywhere in the tree, returning a new item list. */
export function replaceIn(items: readonly DocItem[], next: DocItem): DocItem[] {
  return replaceItem(items, next.id, next)
}

/** Node refs bucketed by the path they belong to, in first-seen order. */
export function refsByItem(refs: Iterable<NodeRef>): Map<string, { sub: number; idx: number }[]> {
  const byItem = new Map<string, { sub: number; idx: number }[]>()
  for (const ref of refs) {
    const list = byItem.get(ref.itemId) ?? []
    list.push({ sub: ref.sub, idx: ref.idx })
    byItem.set(ref.itemId, list)
  }
  return byItem
}

/** Move a set of nodes that may span several paths. */
export function applyNodeMove(base: EditableDoc, refs: Iterable<NodeRef>, delta: Vec): EditableDoc {
  let items = base.items
  for (const [itemId, list] of refsByItem(refs)) {
    const item = findItem(items, itemId)
    if (!item || item.kind !== 'path') continue
    items = replaceIn(items, moveNodes(item, list, delta.x, delta.y))
  }
  return items === base.items ? base : { ...base, items }
}

/** Node keys whose handles are on screen — the selected ones and their neighbours. */
export function handleKeysFor(path: PathItem, nodeSel: ReadonlySet<string>): Set<string> {
  const keys = new Set<string>()
  for (let sub = 0; sub < path.subPaths.length; sub++) {
    const n = path.subPaths[sub].nodes.length
    for (let idx = 0; idx < n; idx++) {
      if (nodeSel.has(nodeKey(path.id, sub, idx))) {
        keys.add(`${sub}:${idx}`)
        // Neighbours too: the far handle of each adjacent segment lives on them.
        keys.add(`${sub}:${(idx + 1) % n}`)
        keys.add(`${sub}:${(idx - 1 + n) % n}`)
      }
    }
  }
  return keys
}
