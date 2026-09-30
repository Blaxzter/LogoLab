// Force colour: every shape repainted in one colour. The studio shows, scores and
// exports this document, and "Find best settings" scores a candidate that brings a
// recolour through the same mapping, so the two numbers describe the same paint.

import type { EditableDoc } from '../../../lib/path/types.ts'

export function forceColorDoc(doc: EditableDoc, color: string): EditableDoc {
  return {
    ...doc,
    // A stroke-only path (a centreline trace) keeps `fill: 'none'` and takes the
    // colour on its stroke; anything else takes it on its fill.
    items: doc.items.map((it) =>
      it.kind !== 'path'
        ? it
        : it.fill === 'none' && it.stroke
          ? { ...it, stroke: { ...it.stroke, color } }
          : {
              ...it,
              fill: color,
              gradient: undefined,
              ...(it.stroke ? { stroke: { ...it.stroke, color } } : {}),
            },
    ),
  }
}
