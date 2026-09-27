// The layers panel's display model: the doc tree flattened into visible rows,
// plus range selection and drop resolution over them.
//
// Display order is the reverse of paint order (top row = frontmost), and a
// collapsed group hides its subtree. The renderer, range select and drop
// resolver all read the same row array so they agree on what each row is.

import type { DocItem } from '../path/types.ts'
import { isGroup, walkItems } from '../path/docTree.ts'

export interface LayerRow {
  item: DocItem
  /** Indentation level; 0 at top level. */
  depth: number
  /** The group this row lives in — null at top level. */
  parentId: string | null
  /** Index within that parent's children, in paint order. */
  siblingIndex: number
  /** The number in "Path 3". */
  number: number
}

/** Where a drop lands: an insertion point in paint order. */
export interface DropSpot {
  parentId: string | null
  index: number
}

/** Which third of a row the pointer is over. */
export type DropEdge = 'above' | 'below' | 'into'

/**
 * Every visible row, top of the stack first. Numbering runs in paint order so
 * adding a shape doesn't renumber the existing rows.
 */
export function layerRows(items: readonly DocItem[]): LayerRow[] {
  const numbers = new Map<string, number>()
  let pathIndex = 0
  let groupIndex = 0
  walkItems(items, (item) => {
    numbers.set(item.id, isGroup(item) ? ++groupIndex : ++pathIndex)
  })

  const rows: LayerRow[] = []
  const walk = (list: readonly DocItem[], depth: number, parentId: string | null) => {
    for (let i = list.length - 1; i >= 0; i--) {
      const item = list[i]
      rows.push({ item, depth, parentId, siblingIndex: i, number: numbers.get(item.id) ?? 0 })
      if (isGroup(item) && item.expanded !== false) walk(item.children, depth + 1, item.id)
    }
  }
  walk(items, 0, null)
  return rows
}

/**
 * The ids of every row between two rows, inclusive (shift-click), in display
 * order. An expanded group in the span contributes itself and its children;
 * structural ops drop the children again via `topLevelSelection`.
 */
export function rowsBetween(rows: readonly LayerRow[], anchorId: string, toId: string): string[] {
  const a = rows.findIndex((r) => r.item.id === anchorId)
  const b = rows.findIndex((r) => r.item.id === toId)
  if (b < 0) return []
  if (a < 0) return [toId]
  const [lo, hi] = a <= b ? [a, b] : [b, a]
  return rows.slice(lo, hi + 1).map((r) => r.item.id)
}

/**
 * The edge a pointer at `offsetY` within a row of `height` is asking for. A
 * group row keeps a fat middle band that means "inside"; a leaf is a simple
 * top/bottom split, because there is nothing to drop into.
 */
export function edgeAt(offsetY: number, height: number, group: boolean): DropEdge {
  const f = height > 0 ? offsetY / height : 0.5
  if (group) return f < 0.3 ? 'above' : f > 0.7 ? 'below' : 'into'
  return f < 0.5 ? 'above' : 'below'
}

/**
 * The insertion point a drop on `rowId`'s `edge` means. Above in the list is
 * in front in paint order (hence the `+1`). Dropping into a group lands at its
 * front, i.e. the first row under the header.
 */
export function dropSpot(rows: readonly LayerRow[], rowId: string, edge: DropEdge): DropSpot | null {
  const row = rows.find((r) => r.item.id === rowId)
  if (!row) return null
  if (edge === 'into') {
    if (!isGroup(row.item)) return null
    return { parentId: row.item.id, index: row.item.children.length }
  }
  return {
    parentId: row.parentId,
    index: edge === 'above' ? row.siblingIndex + 1 : row.siblingIndex,
  }
}
