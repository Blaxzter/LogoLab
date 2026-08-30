// Align and distribute a selection.
//
// Both operate on each selected item's own bounding box and move it bodily —
// nothing is scaled, so aligning never deforms artwork. With a single item
// selected the reference is the artboard (aligning one shape to the canvas is
// the common case and there is nothing else to align it to); with several, the
// reference is the selection's own union box.

import type { DocItem, EditableDoc } from '../path/types.ts'
import { isGroup, topLevelSelection } from '../path/docTree.ts'
import type { Box } from './transform.ts'
import { itemBox, selectionBox, transformItems, translation } from './transform.ts'

export type AlignEdge = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'
export type DistributeAxis = 'horizontal' | 'vertical'

/** The boxes of the top-level selected items, paired with their ids. */
function selectionMembers(
  items: readonly DocItem[],
  ids: ReadonlySet<string>,
): { id: string; box: Box }[] {
  const out: { id: string; box: Box }[] = []
  const wanted = new Set(topLevelSelection(items, ids))
  const walk = (list: readonly DocItem[]) => {
    for (const it of list) {
      if (wanted.has(it.id)) {
        const box = itemBox(it)
        if (box) out.push({ id: it.id, box })
      } else if (isGroup(it)) walk(it.children)
    }
  }
  walk(items)
  return out
}

/** Align every selected item to one edge of the reference box. */
export function alignItems(
  doc: EditableDoc,
  ids: ReadonlySet<string>,
  edge: AlignEdge,
): EditableDoc {
  const members = selectionMembers(doc.items, ids)
  if (members.length === 0) return doc

  const [vx, vy, vw, vh] = doc.viewBox
  const ref: Box =
    members.length === 1
      ? { x: vx, y: vy, w: vw, h: vh }
      : (selectionBox(doc.items, ids) ?? { x: vx, y: vy, w: vw, h: vh })

  let items = doc.items
  for (const { id, box } of members) {
    let dx = 0
    let dy = 0
    switch (edge) {
      case 'left': dx = ref.x - box.x; break
      case 'hcenter': dx = ref.x + ref.w / 2 - (box.x + box.w / 2); break
      case 'right': dx = ref.x + ref.w - (box.x + box.w); break
      case 'top': dy = ref.y - box.y; break
      case 'vcenter': dy = ref.y + ref.h / 2 - (box.y + box.h / 2); break
      case 'bottom': dy = ref.y + ref.h - (box.y + box.h); break
    }
    if (dx === 0 && dy === 0) continue
    items = transformItems(items, new Set([id]), translation(dx, dy))
  }
  return items === doc.items ? doc : { ...doc, items }
}

/**
 * Space the selection evenly between the two extremes, which stay put.
 * Distributes the GAPS, not the centres — evenly-spaced centres leave visually
 * uneven gaps as soon as the items differ in size, which they almost always do.
 */
export function distributeItems(
  doc: EditableDoc,
  ids: ReadonlySet<string>,
  axis: DistributeAxis,
): EditableDoc {
  const members = selectionMembers(doc.items, ids)
  if (members.length < 3) return doc

  const horiz = axis === 'horizontal'
  const start = (b: Box) => (horiz ? b.x : b.y)
  const size = (b: Box) => (horiz ? b.w : b.h)

  const sorted = [...members].sort((a, b) => start(a.box) - start(b.box))
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  const span = start(last.box) + size(last.box) - start(first.box)
  const used = sorted.reduce((acc, m) => acc + size(m.box), 0)
  const gap = (span - used) / (sorted.length - 1)

  let items = doc.items
  let cursor = start(first.box) + size(first.box) + gap
  for (let i = 1; i < sorted.length - 1; i++) {
    const m = sorted[i]
    const delta = cursor - start(m.box)
    if (delta !== 0) {
      items = transformItems(
        items,
        new Set([m.id]),
        horiz ? translation(delta, 0) : translation(0, delta),
      )
    }
    cursor += size(m.box) + gap
  }
  return items === doc.items ? doc : { ...doc, items }
}

/** Whether a distribute would do anything (needs three members). */
export function canDistribute(items: readonly DocItem[], ids: ReadonlySet<string>): boolean {
  return selectionMembers(items, ids).length >= 3
}
