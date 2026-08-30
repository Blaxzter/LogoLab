// Document plumbing for the SVG editor: creating documents, minting ids, and
// the item-level edits the panels drive.
//
// Ids are minted from a module-level counter rather than derived from the item
// list, because an id must be unique against every item that has EVER existed
// in this session — React keys, the selection set and the undo history all hold
// ids across edits, and a "max existing + 1" scheme hands out a stale id the
// moment you undo a delete.

import type {
  DocItem,
  EditableDoc,
  GradientFill,
  GroupItem,
  PathItem,
  Stroke,
  SubPath,
} from '../../lib/path/types'
import { findItem, isGroup, mapLeaves, replaceItem, walkItems } from '../../lib/path/docTree'

let counter = 0

/** A fresh document-unique id. */
export function newId(prefix = 'e'): string {
  return `${prefix}${(++counter).toString(36)}`
}

/**
 * Re-seed the counter past everything an imported document already uses, so a
 * new shape can never collide with an id that came in from the file.
 */
export function adoptIds(doc: EditableDoc): void {
  let maxLen = 0
  walkItems(doc.items, (it) => {
    maxLen = Math.max(maxLen, it.id.length)
  })
  // Cheap and sufficient: push the counter well past any plausible collision.
  counter += 1000 + maxLen
}

export const DEFAULT_FILL = '#4f46e5'

/** An empty document with a square artboard. */
export function blankDoc(size = 512): EditableDoc {
  return { viewBox: [0, 0, size, size], items: [] }
}

/** Wrap freshly-drawn subpaths as a path item. */
export function makePath(
  subPaths: SubPath[],
  fill: string = DEFAULT_FILL,
  name?: string,
): PathItem {
  return {
    kind: 'path',
    id: newId('p'),
    name,
    fill,
    fillRule: 'nonzero',
    subPaths,
    visible: true,
  }
}

/** A new empty group. */
export function makeGroup(children: DocItem[], name?: string): GroupItem {
  return { kind: 'group', id: newId('g'), name, children, visible: true, expanded: true }
}

/** Append an item on top of the stack. */
export function addItem(doc: EditableDoc, item: DocItem): EditableDoc {
  return { ...doc, items: [...doc.items, item] }
}

/** Replace one item anywhere in the tree. */
export function putItem(doc: EditableDoc, item: DocItem): EditableDoc {
  return { ...doc, items: replaceItem(doc.items, item.id, item) }
}

/** Patch fields on every selected LEAF (groups forward the patch to children). */
export function patchSelected(
  doc: EditableDoc,
  ids: ReadonlySet<string>,
  patch: (item: PathItem) => PathItem,
): EditableDoc {
  const targets = new Set<string>()
  const collect = (list: readonly DocItem[], inherited: boolean) => {
    for (const it of list) {
      const on = inherited || ids.has(it.id)
      if (isGroup(it)) collect(it.children, on)
      else if (on && it.kind === 'path') targets.add(it.id)
    }
  }
  collect(doc.items, false)
  if (targets.size === 0) return doc
  const items = mapLeaves(doc.items, (it) =>
    it.kind === 'path' && targets.has(it.id) ? patch(it) : it,
  )
  return items === doc.items ? doc : { ...doc, items }
}

/** Recolor: a solid fill replaces any gradient the path carried. */
export function setFill(doc: EditableDoc, ids: ReadonlySet<string>, fill: string): EditableDoc {
  return patchSelected(doc, ids, (it) => {
    const next: PathItem = { ...it, fill }
    delete next.gradient
    return next
  })
}

export function setGradient(
  doc: EditableDoc,
  ids: ReadonlySet<string>,
  gradient: GradientFill | null,
): EditableDoc {
  return patchSelected(doc, ids, (it) => {
    const next = { ...it }
    if (gradient) next.gradient = gradient
    else delete next.gradient
    return next
  })
}

export function setStroke(
  doc: EditableDoc,
  ids: ReadonlySet<string>,
  stroke: Stroke | null,
): EditableDoc {
  return patchSelected(doc, ids, (it) => {
    const next = { ...it }
    if (stroke) next.stroke = stroke
    else delete next.stroke
    return next
  })
}

export function setFillOpacity(
  doc: EditableDoc,
  ids: ReadonlySet<string>,
  opacity: number,
): EditableDoc {
  return patchSelected(doc, ids, (it) => {
    const next = { ...it }
    if (opacity >= 1) delete next.fillOpacity
    else next.fillOpacity = Math.max(0, opacity)
    return next
  })
}

export function setFillRule(
  doc: EditableDoc,
  ids: ReadonlySet<string>,
  fillRule: 'nonzero' | 'evenodd',
): EditableDoc {
  return patchSelected(doc, ids, (it) => ({ ...it, fillRule }))
}

/** Toggle one item's own visibility (groups included). */
export function toggleVisible(doc: EditableDoc, id: string): EditableDoc {
  const item = findItem(doc.items, id)
  if (!item) return doc
  return putItem(doc, { ...item, visible: !item.visible })
}

/** Rename an item. */
export function renameItem(doc: EditableDoc, id: string, name: string): EditableDoc {
  const item = findItem(doc.items, id)
  if (!item) return doc
  const trimmed = name.trim()
  const next = { ...item }
  if (trimmed) next.name = trimmed
  else delete next.name
  return putItem(doc, next)
}

/** Expand / collapse a group row in the layers list. */
export function toggleExpanded(doc: EditableDoc, id: string): EditableDoc {
  const item = findItem(doc.items, id)
  if (!item || !isGroup(item)) return doc
  return putItem(doc, { ...item, expanded: !item.expanded })
}

/**
 * Deep-copy the given items with fresh ids, offset slightly so the copy is
 * visibly on top of its original rather than hidden exactly behind it.
 */
export function duplicateItems(items: readonly DocItem[]): DocItem[] {
  const clone = (it: DocItem): DocItem => {
    if (isGroup(it)) {
      return { ...it, id: newId('g'), children: it.children.map(clone) }
    }
    if (it.kind === 'path') {
      const next: PathItem = {
        ...it,
        id: newId('p'),
        subPaths: it.subPaths.map((sp) => ({ closed: sp.closed, nodes: sp.nodes.map((n) => ({ ...n })) })),
      }
      // A duplicate is an independent shape, not a second view of a traced
      // region — keeping `loops` would tie it to the original's shared edges.
      delete next.loops
      return next
    }
    return { ...it, id: newId('r') }
  }
  return items.map(clone)
}

/** A human label for a layer row. */
export function itemLabel(item: DocItem, index: number): string {
  if (item.name) return item.name
  if (isGroup(item)) return `Group ${index}`
  if (item.kind === 'raw') return 'Markup'
  const sub = item.subPaths.length
  return sub > 1 ? `Compound ${index}` : `Path ${index}`
}

/** Distinct solid fills in the document, most-used first — the doc's palette. */
export function docPalette(doc: EditableDoc): { color: string; count: number }[] {
  const counts = new Map<string, number>()
  walkItems(doc.items, (it) => {
    if (it.kind !== 'path' || it.gradient) return
    const key = it.fill.toLowerCase()
    if (key === 'none') return
    counts.set(key, (counts.get(key) ?? 0) + 1)
  })
  return [...counts.entries()]
    .map(([color, count]) => ({ color, count }))
    .sort((a, b) => b.count - a.count)
}
