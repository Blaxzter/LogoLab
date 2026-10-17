// The layers panel's display model: the doc tree flattened into visible rows,
// plus range selection and drop resolution over them.
//
// Display order is the reverse of paint order (top row = frontmost), and a
// collapsed group hides its subtree. The renderer, range select and drop
// resolver all read the same row array so they agree on what each row is.
//
// An item that paints nothing (`isInert`: defs, an invisible metadata box) is
// no row at all. It stays in the document, so the export writes it back.

import type { DocItem, PathItem, PathNode, RawItem, SubPath, Vec } from '../path/types.ts'
import { isGroup, isInert, walkItems } from '../path/docTree.ts'

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
    if (isInert(item)) return
    numbers.set(item.id, isGroup(item) ? ++groupIndex : ++pathIndex)
  })

  const rows: LayerRow[] = []
  const walk = (list: readonly DocItem[], depth: number, parentId: string | null) => {
    for (let i = list.length - 1; i >= 0; i--) {
      const item = list[i]
      if (isInert(item)) continue
      rows.push({ item, depth, parentId, siblingIndex: i, number: numbers.get(item.id) ?? 0 })
      // A text's children are its glyph cache, not layers.
      if (isGroup(item) && !item.text && item.expanded !== false) walk(item.children, depth + 1, item.id)
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

/* ------------------------------------------------------------- labels */

/**
 * What an unnamed leaf's row is called: "Rectangle 4", "Line 9", "Compound 2".
 * Read off the GEOMETRY, not the tag it was imported from, so the word stays
 * true after an edit (a rectangle whose corner was dragged is a "Path" again)
 * and a boolean result is never called what one of its inputs was.
 */
export function leafLabel(item: PathItem | RawItem, number: number): string {
  return `${item.kind === 'raw' ? rawNoun(item) : pathNoun(item)} ${number}`
}

/** The noun for a path: the primitive it is exactly, else Path / Compound. */
export function pathNoun(item: PathItem): string {
  const subs = item.subPaths.filter((sp) => sp.nodes.length > 0)
  if (subs.length > 1) return 'Compound'
  const sp = subs[0]
  if (!sp) return 'Path'
  if (!sp.closed) return sp.nodes.length === 2 && straight(sp.nodes[0], sp.nodes[1]) ? 'Line' : 'Path'
  if (isRectangle(sp)) return 'Rectangle'
  const ellipse = ellipseKind(sp)
  if (ellipse) return ellipse
  return 'Path'
}

const RAW_NOUNS: Record<string, string> = {
  text: 'Text',
  image: 'Image',
  g: 'Group',
  svg: 'Group',
  use: 'Instance',
  rect: 'Rectangle',
  circle: 'Circle',
  ellipse: 'Ellipse',
  line: 'Line',
  path: 'Path',
  polygon: 'Polygon',
  polyline: 'Path',
}

/** The noun for raw markup: what its element draws, when that is plain. */
function rawNoun(item: RawItem): string {
  const tag = /^\s*<([\w:-]+)/.exec(item.markup)?.[1].toLowerCase()
  return (tag && RAW_NOUNS[tag]) || 'Markup'
}

/** Relative tolerance for "is exactly this primitive" (coordinates are floats after a transform). */
const SHAPE_TOL = 1e-3

function straight(a: PathNode, b: PathNode): boolean {
  return !a.hOut && !b.hIn
}

/** Four straight sides meeting at right angles, at any rotation. */
function isRectangle(sp: SubPath): boolean {
  const n = sp.nodes
  if (n.length !== 4) return false
  for (let i = 0; i < 4; i++) if (!straight(n[i], n[(i + 1) % 4])) return false
  const scale = Math.max(dist(n[0], n[2]), dist(n[1], n[3]))
  if (scale <= 0) return false
  for (let i = 0; i < 4; i++) {
    const a = n[i]
    const b = n[(i + 1) % 4]
    const c = n[(i + 2) % 4]
    const dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)
    if (Math.abs(dot) > SHAPE_TOL * scale * scale) return false
  }
  return true
}

/** Circle / quarter-arc cubic handle length as a fraction of the radius. */
const KAPPA = 0.5522847498

/**
 * "Circle" or "Ellipse" when the loop is the four kappa quarter-arcs an ellipse is
 * drawn with (what `<circle>` / `<ellipse>` import as, and the ellipse tool draws),
 * at any rotation; null otherwise.
 */
function ellipseKind(sp: SubPath): 'Circle' | 'Ellipse' | null {
  const n = sp.nodes
  if (n.length !== 4) return null
  const c = { x: (n[0].x + n[2].x) / 2, y: (n[0].y + n[2].y) / 2 }
  const c2 = { x: (n[1].x + n[3].x) / 2, y: (n[1].y + n[3].y) / 2 }
  const a = sub(n[0], c)
  const b = sub(n[1], c)
  const ra = Math.hypot(a.x, a.y)
  const rb = Math.hypot(b.x, b.y)
  const scale = Math.max(ra, rb)
  if (scale <= 0 || dist(c, c2) > SHAPE_TOL * scale) return null
  if (Math.abs(a.x * b.x + a.y * b.y) > SHAPE_TOL * scale * scale) return null
  // Each node's handles run along the next / previous radius, kappa of its length.
  for (let i = 0; i < 4; i++) {
    const node = n[i]
    const next = sub(n[(i + 1) % 4], c)
    const prev = sub(n[(i + 3) % 4], c)
    if (!node.hOut || !node.hIn) return null
    const out = { x: node.x + KAPPA * next.x, y: node.y + KAPPA * next.y }
    const inn = { x: node.x + KAPPA * prev.x, y: node.y + KAPPA * prev.y }
    if (dist(node.hOut, out) > SHAPE_TOL * scale || dist(node.hIn, inn) > SHAPE_TOL * scale) return null
  }
  return Math.abs(ra - rb) <= SHAPE_TOL * scale ? 'Circle' : 'Ellipse'
}

function sub(p: Vec, q: Vec): Vec {
  return { x: p.x - q.x, y: p.y - q.y }
}

function dist(p: Vec, q: Vec): number {
  return Math.hypot(p.x - q.x, p.y - q.y)
}
