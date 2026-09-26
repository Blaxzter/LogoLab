// Pure document edits behind the studio's selection and path commands; each returns null when nothing changes.

import type { DocItem, EditableDoc, PathItem } from '../../lib/path/types'
import { findItem, isGroup, removeItems, topLevelSelection, ungroup } from '../../lib/path/docTree'
import { scaleAbout, transformItems, translation, type Box } from '../../lib/editor/transform'
import { breakAt, combinePaths, joinEnds, reversePath, splitCompound } from '../../lib/editor/pathOps'
import { parseNodeKey, refsByItem, replaceIn } from '../../lib/editor/nodeEdit'
import { deleteNodes } from '../../lib/path/geometry'
import { duplicateItems, newId } from './editorDoc'

/** Delete the selected nodes; a path left with too few nodes is removed. */
export function deleteSelectedNodes(doc: EditableDoc, nodeSel: ReadonlySet<string>): EditableDoc | null {
  let items = doc.items
  const dropped = new Set<string>()
  for (const [itemId, refs] of refsByItem([...nodeSel].map(parseNodeKey))) {
    const item = findItem(items, itemId)
    if (!item || item.kind !== 'path') continue
    const next = deleteNodes(item, refs)
    if (next) items = replaceIn(items, next)
    else dropped.add(itemId)
  }
  if (dropped.size > 0) items = removeItems(items, dropped)
  return items !== doc.items ? { ...doc, items } : null
}

/** Copy the selection, nudged slightly so it isn't hidden behind the original. */
export function duplicateSelected(
  doc: EditableDoc,
  selection: ReadonlySet<string>,
): { doc: EditableDoc; ids: Set<string> } | null {
  const top = topLevelSelection(doc.items, selection)
  const originals = top.map((id) => findItem(doc.items, id)).filter((it): it is DocItem => it !== null)
  if (originals.length === 0) return null
  const copies = duplicateItems(originals)
  const offset = Math.max(doc.viewBox[2], doc.viewBox[3]) * 0.02
  const ids = new Set(copies.map((c) => c.id))
  const items = transformItems([...doc.items, ...copies], ids, translation(offset, offset))
  return { doc: { ...doc, items }, ids }
}

/** Dissolve every selected group; `freed` holds the children that took their place. */
export function ungroupSelected(
  doc: EditableDoc,
  selection: ReadonlySet<string>,
): { doc: EditableDoc; freed: Set<string> } | null {
  let items = doc.items
  const freed = new Set<string>()
  for (const id of selection) {
    const item = findItem(items, id)
    if (!item || !isGroup(item)) continue
    for (const c of item.children) freed.add(c.id)
    const next = ungroup(items, id)
    if (next) items = next
  }
  if (items === doc.items) return null
  return { doc: { ...doc, items }, freed }
}

/** Numeric geometry entry: resolve X/Y/W/H into a transform of the box. */
export function setSelectionGeometry(
  doc: EditableDoc,
  selection: ReadonlySet<string>,
  box: Box,
  patch: { x?: number; y?: number; w?: number; h?: number },
): EditableDoc | null {
  let items = doc.items
  if (patch.w !== undefined || patch.h !== undefined) {
    const sx = patch.w !== undefined && box.w > 0 ? patch.w / box.w : 1
    const sy = patch.h !== undefined && box.h > 0 ? patch.h / box.h : 1
    // Resize about the top-left (the origin the X/Y fields report), so
    // typing a width doesn't also move the shape.
    items = transformItems(items, selection, scaleAbout({ x: box.x, y: box.y }, sx, sy))
  }
  if (patch.x !== undefined || patch.y !== undefined) {
    items = transformItems(
      items,
      selection,
      translation(patch.x !== undefined ? patch.x - box.x : 0, patch.y !== undefined ? patch.y - box.y : 0),
    )
  }
  return items !== doc.items ? { ...doc, items } : null
}

/* ----------------------------------------------------------- path ops */

function pathAt(doc: EditableDoc, id: string): PathItem | null {
  const item = findItem(doc.items, id)
  return item && item.kind === 'path' ? item : null
}

export function reversePathIn(doc: EditableDoc, id: string): EditableDoc | null {
  const item = pathAt(doc, id)
  if (!item) return null
  return { ...doc, items: replaceIn(doc.items, reversePath(item)) }
}

/** Split the path open at the one selected node. */
export function breakNodeIn(doc: EditableDoc, nodeKey: string): EditableDoc | null {
  const ref = parseNodeKey(nodeKey)
  const item = pathAt(doc, ref.itemId)
  if (!item) return null
  return { ...doc, items: replaceIn(doc.items, breakAt(item, ref.sub, ref.idx)) }
}

/** Weld two loose ends of the same path. */
export function joinNodesIn(doc: EditableDoc, keys: readonly string[]): EditableDoc | null {
  const [a, b] = keys.map(parseNodeKey)
  if (a.itemId !== b.itemId) return null
  const item = pathAt(doc, a.itemId)
  if (!item) return null
  const next = joinEnds(item, { sub: a.sub, idx: a.idx }, { sub: b.sub, idx: b.idx })
  if (next === item) return null
  return { ...doc, items: replaceIn(doc.items, next) }
}

/** Break a compound path into one top-level shape per subpath. */
export function splitPathIn(doc: EditableDoc, id: string): { doc: EditableDoc; ids: Set<string> } | null {
  const item = pathAt(doc, id)
  if (!item || item.subPaths.length < 2) return null
  const parts = splitCompound(item, () => newId('p'))
  const items = doc.items.flatMap((it) => (it.id === item.id ? parts : [it]))
  return { doc: { ...doc, items }, ids: new Set(parts.map((p) => p.id)) }
}

/** Merge the selected paths into one compound path. */
export function combineSelected(
  doc: EditableDoc,
  selection: ReadonlySet<string>,
): { doc: EditableDoc; id: string } | null {
  const paths = [...selection]
    .map((id) => findItem(doc.items, id))
    .filter((it): it is DocItem => it !== null && it.kind === 'path')
  if (paths.length < 2) return null
  const merged = combinePaths(paths as never)
  if (!merged) return null
  const keep = new Set(paths.slice(1).map((p) => p.id))
  const items = removeItems(doc.items, keep).map((it) => (it.id === merged.id ? merged : it))
  return { doc: { ...doc, items }, id: merged.id }
}
