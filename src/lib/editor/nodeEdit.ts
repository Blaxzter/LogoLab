// Node identity across the whole document, and the doc-level node edits built on it.

import type { DocItem, EditableDoc, PathItem, Vec } from '../path/types.ts'
import { ancestorsOf, findItem, isGroup, isText, replaceItem } from '../path/docTree.ts'
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

/**
 * Put `next` where `id` was, in its own parent and in order — a path inside a
 * group stays inside it. Identity-stable: an id that isn't in the tree returns
 * `items` itself.
 */
export function replaceWithMany(items: readonly DocItem[], id: string, next: readonly DocItem[]): DocItem[] {
  let changed = false
  const out = items.flatMap((it): DocItem[] => {
    if (it.id === id) {
      changed = true
      return [...next]
    }
    if (isGroup(it)) {
      const kids = replaceWithMany(it.children, id, next)
      if (kids === it.children) return [it]
      changed = true
      return [{ ...it, children: kids }]
    }
    return [it]
  })
  return changed ? out : (items as DocItem[])
}

/**
 * Paths the node tool may edit: the selection's (a group contributes its
 * paths), or every visible path when nothing is selected. A live text's
 * outlines are a cache rebuilt from its words on the next keystroke, so they
 * are never offered — node edits there would vanish silently; Convert to
 * curves first.
 */
export function nodeEditablePaths(items: readonly DocItem[], selection: ReadonlySet<string>): PathItem[] {
  const below = (list: readonly DocItem[]): PathItem[] =>
    list.flatMap((it): PathItem[] =>
      isText(it) ? [] : isGroup(it) ? below(it.children) : it.kind === 'path' ? [it] : [],
    )
  if (selection.size === 0) return below(items).filter((p) => p.visible)
  const out: PathItem[] = []
  for (const id of selection) {
    const item = findItem(items, id)
    if (!item || ancestorsOf(items, id).some(isText)) continue
    out.push(...below([item]))
  }
  return out
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
